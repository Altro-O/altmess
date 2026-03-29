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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

  const cropTransform = useMemo(
    () => ({ transform: `translate(${cropPosition.x}px, ${cropPosition.y}px) scale(${cropZoom})` }),
    [cropPosition.x, cropPosition.y, cropZoom],
  );

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
    if (!cropSource || !imageRef.current) {
      return;
    }

    const image = imageRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext('2d');

    if (!context) {
      setStatus('Не удалось подготовить аватар');
      return;
    }

    const renderedWidth = image.naturalWidth * cropZoom;
    const renderedHeight = image.naturalHeight * cropZoom;
    const drawX = (AVATAR_SIZE - renderedWidth) / 2 + cropPosition.x;
    const drawY = (AVATAR_SIZE - renderedHeight) / 2 + cropPosition.y;

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    context.drawImage(image, drawX, drawY, renderedWidth, renderedHeight);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((nextBlob) => resolve(nextBlob), 'image/jpeg', 0.9);
    });

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
    setStatus('');
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

    setCropPosition({
      x: clamp(dragStart.cropX + (event.clientX - dragStart.x), -220, 220),
      y: clamp(dragStart.cropY + (event.clientY - dragStart.y), -220, 220),
    });
  };

  const stopCropDragging = () => {
    setIsDraggingCrop(false);
    setDragStart(null);
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
          </div>

          {cropSource ? (
            <div className={styles.cropCard}>
              <div
                className={styles.cropViewport}
                onPointerDown={handleCropPointerDown}
                onPointerMove={handleCropPointerMove}
                onPointerUp={stopCropDragging}
                onPointerLeave={stopCropDragging}
              >
                <img ref={imageRef} src={cropSource.previewUrl} alt="Предпросмотр аватара" className={styles.cropImage} style={cropTransform} draggable={false} />
              </div>
              <label className={styles.zoomControl}>
                <span>Масштаб</span>
                <input type="range" min="1" max="2.6" step="0.05" value={cropZoom} onChange={(event) => setCropZoom(Number(event.target.value))} />
              </label>
              <div className={styles.cropActions}>
                <button type="button" className={styles.secondaryButton} onClick={() => { URL.revokeObjectURL(cropSource.previewUrl); setCropSource(null); }}>Отмена</button>
                <button type="button" className={styles.button} onClick={finalizeAvatarCrop} disabled={isUploadingAvatar}>{isUploadingAvatar ? 'Загружаю...' : 'Применить аватар'}</button>
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
