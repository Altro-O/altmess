'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from '../styles/auth.module.css';
import { useAuth } from '../components/AuthProvider';
import { apiFetch, type AuthUser } from '../utils/api';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });

      login(response.token, response.user);
      router.push('/dashboard/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка соединения с сервером');
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.shell}>
      <section className={styles.hero}>
        <div className={styles.badge}>
          <span className={styles.badgeDot} />
          End-to-end messaging workspace
        </div>
        <h1 className={styles.headline}>
          Общение,
          <span className={styles.accent}>которое ощущается живым</span>
        </h1>
        <p className={styles.subtext}>
          Altmess собирает личные чаты, быстрые звонки и защищенную переписку в одном веб-интерфейсе без лишней тяжести.
        </p>
        <div className={styles.highlights}>
          <article className={styles.highlight}>
            <div className={styles.highlightIcon}>#</div>
            <div>
              <p className={styles.highlightTitle}>Быстрый вход</p>
              <p className={styles.highlightText}>Легкий онбординг и быстрый доступ к чату без перегруза интерфейса.</p>
            </div>
          </article>
          <article className={styles.highlight}>
            <div className={styles.highlightIcon}>*</div>
            <div>
              <p className={styles.highlightTitle}>Шифрование сообщений</p>
              <p className={styles.highlightText}>Подготовленная база под защищенную доставку и дальнейшее усиление сервера.</p>
            </div>
          </article>
          <article className={styles.highlight}>
            <div className={styles.highlightIcon}>~</div>
            <div>
              <p className={styles.highlightTitle}>Звонки и чат рядом</p>
              <p className={styles.highlightText}>Текст, presence и видеозвонок в едином рабочем пространстве.</p>
            </div>
          </article>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <p className={styles.eyebrow}>Sign In</p>
          <h2 className={styles.title}>С возвращением</h2>
          <p className={styles.description}>Войдите и сразу попадете в рабочую область мессенджера.</p>
          <p className={styles.description}>Теперь аккаунт и сообщения общие для всех браузеров и устройств в рамках одного сервера.</p>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="username" className={styles.label}>Имя пользователя</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className={styles.input}
              placeholder="Например, altro"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>Пароль</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={styles.input}
              placeholder="Введите пароль"
            />
          </div>
          <button type="submit" disabled={loading} className={styles.submit}>
            {loading ? 'Входим...' : 'Открыть Altmess'}
          </button>
        </form>

        <div className={styles.footer}>
          Нет аккаунта? <Link href="/register">Создать новый</Link>
        </div>
      </section>
    </div>
  );
}
