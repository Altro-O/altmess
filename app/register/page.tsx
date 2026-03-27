'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from '@/styles/auth.module.css';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch, type AuthUser } from '@/utils/api';

export default function RegisterPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password }),
      });

      login(response.token, response.user);
      router.push('/dashboard/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка соединения с сервером');
      console.error('Registration error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.shell}>
      <section className={styles.hero}>
        <div className={styles.badge}>
          <span className={styles.badgeDot} />
          Private by default
        </div>
        <h1 className={styles.headline}>
          Создайте
          <span className={styles.accent}>новую точку связи</span>
        </h1>
        <p className={styles.subtext}>
          Регистрация готовит аккаунт для сообщений, звонков и дальнейшей синхронизации с серверной частью.
        </p>
        <div className={styles.highlights}>
          <article className={styles.highlight}>
            <div className={styles.highlightIcon}>+</div>
            <div>
              <p className={styles.highlightTitle}>Простой старт</p>
              <p className={styles.highlightText}>Минимум полей и понятный путь к первому чату.</p>
            </div>
          </article>
          <article className={styles.highlight}>
            <div className={styles.highlightIcon}>@</div>
            <div>
              <p className={styles.highlightTitle}>Готовность к backend-расширению</p>
              <p className={styles.highlightText}>Форма уже совместима с дальнейшей доработкой реальной базы и JWT.</p>
            </div>
          </article>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <p className={styles.eyebrow}>Create Account</p>
          <h2 className={styles.title}>Подключиться к Altmess</h2>
          <p className={styles.description}>Создайте профиль и откройте доступ к защищенным сообщениям.</p>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="username" className={styles.label}>Имя пользователя</label>
            <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required className={styles.input} placeholder="Например, altro" />
          </div>
          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={styles.input} placeholder="you@example.com" />
          </div>
          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>Пароль</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className={styles.input} placeholder="Введите пароль" />
          </div>
          <div className={styles.field}>
            <label htmlFor="confirmPassword" className={styles.label}>Подтвердите пароль</label>
            <input id="confirmPassword" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required className={styles.input} placeholder="Повторите пароль" />
          </div>
          <button type="submit" disabled={loading} className={styles.submit}>
            {loading ? 'Создаем аккаунт...' : 'Зарегистрироваться'}
          </button>
        </form>

        <div className={styles.footer}>
          Уже есть аккаунт? <Link href="/">Войти</Link>
        </div>
      </section>
    </div>
  );
}
