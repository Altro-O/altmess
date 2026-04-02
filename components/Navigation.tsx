'use client';

import Link from 'next/link';
import Image from 'next/image';
import styles from '../styles/navigation.module.css';
import { useAuth } from './AuthProvider';

export default function Navigation() {
  const { isAuthenticated, user, logout } = useAuth();
  const brandHref = isAuthenticated ? '/dashboard/chat' : '/';

  return (
    <nav className={styles.navbar}>
      <Link href={brandHref} className={styles.brand}>
        <span className={styles.brandMark}>
          <Image src="/altmess.jpeg" alt="Altmess" width={42} height={42} className={styles.brandMarkImage} />
        </span>
        <span className={styles.brandText}>
          <span className={styles.brandTitle}>Altmess</span>
          <span className={styles.brandSubtitle}>Личные чаты, группы и звонки</span>
        </span>
      </Link>

      <div className={styles.actions}>
        {isAuthenticated ? (
          <>
            <span className={styles.userChip}>{user?.displayName || user?.username}</span>
            <Link href="/dashboard/chat" className={styles.link}>Чаты</Link>
            <Link href="/dashboard/profile" className={styles.link}>Профиль</Link>
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
