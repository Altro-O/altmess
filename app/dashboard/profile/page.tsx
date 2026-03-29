'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../components/AuthProvider';
import UserAvatar from '../../../components/UserAvatar';
import { apiFetch, type AuthUser } from '../../../utils/api';
import styles from '../../../styles/profile.module.css';

const palette = ['ocean', 'mint', 'sunset', 'berry', 'slate'];
const AVATAR_SIZE = 512;

type UploadedAvatar = {
  avatarUrl: string;
  avatarStorageKey?: string | null;
  avatarStorageKind?: 'local' | 'vps' | null;
};

type CropMetrics = {
  naturalWidth: number;
  naturalHeight: number;
  baseScale: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createCroppedAvatarBlob(
  image: HTMLImageElement,
  viewportSize: number,
  baseScale: number,
  zoom: number,
  position: { x: number; y: number },
) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Не удалось подготовить аватар');
  }

  const viewportRatio = AVATAR_SIZE / viewportSize;
  const renderedWidth = image.naturalWidth * baseScale * zoom * viewportRatio;
  const renderedHeight = image.naturalHeight * baseScale * zoom * viewportRatio;
  const drawX = (AVATAR_SIZE - renderedWidth) / 2 + position.x * viewportRatio;
  const drawY = (AVATAR_SIZE - renderedHeight) / 2 + position.y * viewportRatio;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.drawImage(image, drawX, drawY, renderedWidth, renderedHeight);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((nextBlob) => resolve(nextBlob), 'image/jpeg', 0.9);
  });
}

export default function ProfilePage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, token, user, updateUser } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarStorageKey, setAvatarStorageKey] = useState<string | null>(null);
  const [avatarStorageKind, setAvatarStorageKind] = useState<'local' | 'vps' | null>(null);
  const [avatarColor, setAvatarColor] = useState('ocean');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [cropSource, setCropSource] = useState<{ file: File; previewUrl: string } | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; cropX: number; cropY: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cropViewportRef = useRef<HTMLDivElement | null>(null);
  const [cropViewportSize, setCropViewportSize] = useState(320);
  const [cropMetrics, setCropMetrics] = useState<CropMetrics | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/');
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (!user) {
      return;
    }

    setDisplayName(user.displayName || user.username);
    setBio(user.bio || '');
    setAvatarUrl(user.avatarUrl || '');
    setAvatarStorageKey(user.avatarStorageKey || null);
    setAvatarStorageKind(user.avatarStorageKind || null);
    setAvatarColor(user.avatarColor || 'ocean');
  }, [user]);

  useEffect(() => () => {
    if (cropSource?.previewUrl) {
      URL.revokeObjectURL(cropSource.previewUrl);
    }
  }, [cropSource]);

  useEffect(() => {
    const updateViewportSize = () => {
      const width = cropViewportRef.current?.getBoundingClientRect().width;
      if (width) {
        setCropViewportSize(width);
      }
    };

    updateViewportSize();
    window.addEventListener('resize', updateViewportSize);
    return () => window.removeEventListener('resize', updateViewportSize);
  }, [cropSource]);

  const clampCropPosition = (nextX: number, nextY: number, nextZoom = cropZoom, nextMetrics = cropMetrics) => {
    if (!nextMetrics) {
      return { x: nextX, y: nextY };
    }

    const renderedWidth = nextMetrics.naturalWidth * nextMetrics.baseScale * nextZoom;
    const renderedHeight = nextMetrics.naturalHeight * nextMetrics.baseScale * nextZoom;
    const maxOffsetX = Math.max(0, renderedWidth / 2 - cropViewportSize * 0.12);
    const maxOffsetY = Math.max(0, renderedHeight / 2 - cropViewportSize * 0.12);

    return {
      x: clamp(nextX, -maxOffsetX, maxOffsetX),
      y: clamp(nextY, -maxOffsetY, maxOffsetY),
    };
  };

  const cropTransform = useMemo(
    () => ({ transform: `translate(calc(-50% + ${cropPosition.x}px), calc(-50% + ${cropPosition.y}px)) scale(${(cropMetrics?.baseScale || 1) * cropZoom})` }),
    [cropMetrics?.baseScale, cropPosition.x, cropPosition.y, cropZoom],
  );

  const previewTransform = useMemo(() => {
    const previewSize = 96;
    const ratio = previewSize / cropViewportSize;
    return {
      transform: `translate(calc(-50% + ${cropPosition.x * ratio}px), calc(-50% + ${cropPosition.y * ratio}px)) scale(${((cropMetrics?.baseScale || 1) * cropZoom) * ratio})`,
    };
  }, [cropMetrics?.baseScale, cropPosition.x, cropPosition.y, cropViewportSize, cropZoom]);

  const uploadAvatarBlob = async (blob: Blob, fileName: string): Promise<UploadedAvatar> => {
    if (!token) {
      throw new Error('Сессия недействительна');
    }

    const response = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': blob.type || 'image/jpeg',
        'X-File-Name': encodeURIComponent(fileName),
        'X-File-Size': String(blob.size),
      },
      body: blob,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.attachment) {
      throw new Error(data.error || 'Не удалось загрузить аватар');
    }

    return {
      avatarUrl: data.attachment.fileUrl,
      avatarStorageKey: data.attachment.storageKey || null,
      avatarStorageKind: data.attachment.storageKind || null,
    };
  };

  const finalizeAvatarCrop = async () => {
    if (!cropSource || !imageRef.current || !cropMetrics) {
      return;
    }

    const image = imageRef.current;
    const blob = await createCroppedAvatarBlob(image, cropViewportSize, cropMetrics.baseScale, cropZoom, cropPosition);

    if (!blob) {
      setStatus('Не удалось подготовить аватар');
      return;
    }

    setIsUploadingAvatar(true);
    setStatus('');
    try {
      const uploaded = await uploadAvatarBlob(blob, `${cropSource.file.name.replace(/\.[^.]+$/, '') || 'avatar'}.jpg`);
      setAvatarUrl(uploaded.avatarUrl);
      setAvatarStorageKey(uploaded.avatarStorageKey || null);
      setAvatarStorageKind(uploaded.avatarStorageKind || null);
      setStatus('Аватар загружен. Не забудьте сохранить профиль');
      URL.revokeObjectURL(cropSource.previewUrl);
      setCropSource(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Не удалось загрузить аватар');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const applyAvatarWithoutEditing = async () => {
    if (!cropSource || !imageRef.current || !cropMetrics) {
      return;
    }

    setIsUploadingAvatar(true);
    setStatus('');
    try {
      const blob = await createCroppedAvatarBlob(imageRef.current, cropViewportSize, cropMetrics.baseScale, 1, { x: 0, y: 0 });
      if (!blob) {
        throw new Error('Не удалось подготовить аватар');
      }

      const uploaded = await uploadAvatarBlob(blob, `${cropSource.file.name.replace(/\.[^.]+$/, '') || 'avatar'}.jpg`);
      setAvatarUrl(uploaded.avatarUrl);
      setAvatarStorageKey(uploaded.avatarStorageKey || null);
      setAvatarStorageKind(uploaded.avatarStorageKind || null);
      setStatus('Аватар загружен целиком. Не забудьте сохранить профиль');
      URL.revokeObjectURL(cropSource.previewUrl);
      setCropSource(null);
      setCropMetrics(null);
      setCropZoom(1);
      setCropPosition({ x: 0, y: 0 });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Не удалось загрузить аватар');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleAvatarUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      setStatus('Нужен файл изображения');
      return;
    }

    if (cropSource?.previewUrl) {
      URL.revokeObjectURL(cropSource.previewUrl);
    }

    setCropSource({ file, previewUrl: URL.createObjectURL(file) });
    setCropZoom(1);
    setCropPosition({ x: 0, y: 0 });
    setCropMetrics(null);
    setStatus('');
  };

  const handleCropImageLoad = () => {
    if (!imageRef.current || !cropViewportSize) {
      return;
    }

    const nextMetrics = {
      naturalWidth: imageRef.current.naturalWidth,
      naturalHeight: imageRef.current.naturalHeight,
      baseScale: Math.max(cropViewportSize / imageRef.current.naturalWidth, cropViewportSize / imageRef.current.naturalHeight),
    };

    setCropMetrics(nextMetrics);
    setCropZoom(1);
    setCropPosition({ x: 0, y: 0 });
  };

  const handleCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!cropSource) {
      return;
    }

    setIsDraggingCrop(true);
    setDragStart({ x: event.clientX, y: event.clientY, cropX: cropPosition.x, cropY: cropPosition.y });
  };

  const handleCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingCrop || !dragStart) {
      return;
    }

    setCropPosition(clampCropPosition(
      dragStart.cropX + (event.clientX - dragStart.x),
      dragStart.cropY + (event.clientY - dragStart.y),
    ));
  };

  const stopCropDragging = () => {
    setIsDraggingCrop(false);
    setDragStart(null);
  };

  const resetCrop = () => {
    setCropZoom(1);
    setCropPosition({ x: 0, y: 0 });
  };

  const removeAvatar = () => {
    if (cropSource?.previewUrl) {
      URL.revokeObjectURL(cropSource.previewUrl);
    }

    setCropSource(null);
    setCropMetrics(null);
    setCropZoom(1);
    setCropPosition({ x: 0, y: 0 });
    setAvatarUrl('');
    setAvatarStorageKey(null);
    setAvatarStorageKind(null);
    setStatus('Аватар будет удален после сохранения профиля');
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token) {
      return;
    }

    setSaving(true);
    setStatus('');

    try {
      const response = await apiFetch<{ user: AuthUser }>('/api/profile', {
        method: 'PATCH',
        token,
        body: JSON.stringify({ displayName, bio, avatarUrl, avatarColor, avatarStorageKey, avatarStorageKind }),
      });
      updateUser(response.user);
      setStatus('Профиль сохранен');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Не удалось сохранить профиль');
    } finally {
      setSaving(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <UserAvatar
            avatarUrl={avatarUrl}
            alt={displayName}
            fallback={displayName.slice(0, 2).toUpperCase()}
            className={`${styles.avatar} ${styles[`avatar_${avatarColor}`]}`}
            imageClassName={styles.avatarImage}
          />
          <div>
            <p className={styles.eyebrow}>Profile</p>
            <h1 className={styles.title}>Настройки профиля</h1>
            <p className={styles.description}>Имя, аватар и короткий статус будут видны в списке диалогов и в шапке чата.</p>
          </div>
        </div>

        <form onSubmit={handleSave} className={styles.form}>
          <label className={styles.field}>
            <span>Отображаемое имя</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={styles.input} maxLength={32} />
          </label>

          <label className={styles.field}>
            <span>Короткий статус</span>
            <input value={bio} onChange={(event) => setBio(event.target.value)} className={styles.input} maxLength={90} placeholder="Например: на связи до ночи" />
          </label>

          <div className={styles.field}>
            <span>Загрузка аватара</span>
            <input type="file" accept="image/*" onChange={handleAvatarUpload} className={styles.fileInput} />
            <span className={styles.hint}>После выбора можно подвигать и приблизить изображение перед загрузкой.</span>
            {avatarUrl ? <button type="button" className={styles.dangerLinkButton} onClick={removeAvatar}>Удалить аватар</button> : null}
          </div>

          {cropSource ? (
            <div className={styles.cropCard}>
              <div className={styles.cropLayout}>
                <div className={styles.cropWorkspace}>
                  <div className={styles.cropSourcePreview}>
                    <img src={cropSource.previewUrl} alt="Исходная фотография" className={styles.cropSourceImage} />
                  </div>
                  <div
                    ref={cropViewportRef}
                    className={styles.cropViewport}
                    onPointerDown={handleCropPointerDown}
                    onPointerMove={handleCropPointerMove}
                    onPointerUp={stopCropDragging}
                    onPointerLeave={stopCropDragging}
                  >
                    <img ref={imageRef} src={cropSource.previewUrl} alt="Предпросмотр аватара" className={styles.cropImage} style={cropTransform} draggable={false} onLoad={handleCropImageLoad} />
                    <div className={styles.cropFrame} />
                  </div>
                </div>
                <div className={styles.cropSidebar}>
                  <div className={styles.cropPreviewCard}>
                    <span className={styles.cropPreviewLabel}>Итоговый аватар</span>
                    <div className={`${styles.cropAvatarPreview} ${styles[`avatar_${avatarColor}`]}`}>
                      {cropSource ? <img src={cropSource.previewUrl} alt="Итоговый аватар" className={styles.cropAvatarPreviewImage} style={previewTransform} draggable={false} /> : null}
                    </div>
                  </div>
                  <label className={styles.zoomControl}>
                    <span>Масштаб</span>
                    <input
                      type="range"
                      min="1"
                      max="3"
                      step="0.05"
                      value={cropZoom}
                      onChange={(event) => {
                        const nextZoom = Number(event.target.value);
                        setCropZoom(nextZoom);
                        setCropPosition((prev) => clampCropPosition(prev.x, prev.y, nextZoom));
                      }}
                    />
                  </label>
                  <div className={styles.cropActions}>
                    <button type="button" className={styles.secondaryButton} onClick={applyAvatarWithoutEditing} disabled={isUploadingAvatar}>Использовать целиком</button>
                    <button type="button" className={styles.secondaryButton} onClick={resetCrop}>Сбросить</button>
                    <button type="button" className={styles.secondaryButton} onClick={() => { URL.revokeObjectURL(cropSource.previewUrl); setCropSource(null); setCropMetrics(null); }}>Отмена</button>
                    <button type="button" className={styles.button} onClick={finalizeAvatarCrop} disabled={isUploadingAvatar}>{isUploadingAvatar ? 'Загружаю...' : 'Применить аватар'}</button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <label className={styles.field}>
            <span>Или прямая ссылка на изображение</span>
            <input value={avatarUrl} onChange={(event) => { setAvatarUrl(event.target.value); setAvatarStorageKey(null); setAvatarStorageKind(null); }} className={styles.input} placeholder="https://site.com/avatar.jpg" />
            <span className={styles.hint}>Нужна именно ссылка на сам файл картинки, а не на страницу поиска.</span>
          </label>

          <div className={styles.field}>
            <span>Цвет профиля</span>
            <div className={styles.palette}>
              {palette.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`${styles.swatch} ${styles[`swatch_${item}`]} ${avatarColor === item ? styles.swatchActive : ''}`}
                  onClick={() => setAvatarColor(item)}
                />
              ))}
            </div>
          </div>

          <div className={styles.actions}>
            <button type="submit" className={styles.button} disabled={saving || isUploadingAvatar}>{saving ? 'Сохраняю...' : 'Сохранить'}</button>
            {status ? <span className={styles.status}>{status}</span> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
