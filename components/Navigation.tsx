'use client';

import Link from 'next/link';
import styles from '../styles/navigation.module.css';
import { useAuth } from './AuthProvider';

export default function Navigation() {
  const { isAuthenticated, user, logout } = useAuth();

  return (
    <nav className={styles.navbar}>
      <Link href="/" className={styles.brand}>
        <span className={styles.brandMark}>A</span>
        <span className={styles.brandText}>
          <span className={styles.brandTitle}>Altmess</span>
          <span className={styles.brandSubtitle}>realtime messenger</span>
        </span>
      </Link>

      <div className={styles.actions}>
        {isAuthenticated ? (
          <>
            <span className={styles.link}>{user?.username}</span>
            <Link href="/dashboard/chat" className={styles.link}>Чаты</Link>
            <button className={styles.danger} onClick={logout}>Выйти</button>
          </>
        ) : (
          <>
            <Link href="/" className={styles.link}>Вход</Link>
            <Link href="/register" className={styles.button}>Регистрация</Link>
          </>
        )}
      </div>
    </nav>
  );
}
