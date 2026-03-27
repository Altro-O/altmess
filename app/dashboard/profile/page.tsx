'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../components/AuthProvider';
import { apiFetch, type AuthUser } from '../../../utils/api';
import styles from '../../../styles/profile.module.css';

const palette = ['ocean', 'mint', 'sunset', 'berry', 'slate'];

export default function ProfilePage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, token, user, updateUser } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarColor, setAvatarColor] = useState('ocean');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

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
    setAvatarColor(user.avatarColor || 'ocean');
  }, [user]);

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
        body: JSON.stringify({ displayName, bio, avatarUrl, avatarColor }),
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
          <div className={`${styles.avatar} ${styles[`avatar_${avatarColor}`]}`}>
            {avatarUrl ? <img src={avatarUrl} alt={displayName} className={styles.avatarImage} /> : displayName.slice(0, 2).toUpperCase()}
          </div>
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

          <label className={styles.field}>
            <span>Ссылка на аватар</span>
            <input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} className={styles.input} placeholder="https://..." />
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
            <button type="submit" className={styles.button} disabled={saving}>{saving ? 'Сохраняю...' : 'Сохранить'}</button>
            {status ? <span className={styles.status}>{status}</span> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
