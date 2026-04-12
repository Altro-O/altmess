'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import styles from '../styles/navigation.module.css';
import { useAuth } from './AuthProvider';
import ThemeToggle from './ThemeToggle';

export default function Navigation() {
  const { isAuthenticated, user, logout } = useAuth();
  const brandHref = isAuthenticated ? '/dashboard/chat' : '/';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

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
        <ThemeToggle />
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

      <button
        type="button"
        className={styles.hamburger}
        onClick={() => setMenuOpen((prev) => !prev)}
        aria-label="Меню навигации"
        aria-expanded={menuOpen}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {menuOpen ? (
            <>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </>
          ) : (
            <>
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </>
          )}
        </svg>
      </button>

      {menuOpen ? (
        <div ref={menuRef} className={styles.mobileMenu}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 12px' }}>
            <ThemeToggle />
          </div>
          {isAuthenticated ? (
            <>
              <span className={styles.mobileMenuUser}>{user?.displayName || user?.username}</span>
              <Link href="/dashboard/chat" className={styles.mobileMenuLink} onClick={() => setMenuOpen(false)}>Чаты</Link>
              <Link href="/dashboard/profile" className={styles.mobileMenuLink} onClick={() => setMenuOpen(false)}>Профиль</Link>
              <button className={styles.mobileMenuDanger} onClick={() => { setMenuOpen(false); logout(); }}>Выйти</button>
            </>
          ) : (
            <>
              <Link href="/" className={styles.mobileMenuLink} onClick={() => setMenuOpen(false)}>Вход</Link>
              <Link href="/register" className={styles.mobileMenuButton} onClick={() => setMenuOpen(false)}>Регистрация</Link>
            </>
          )}
        </div>
      ) : null}
    </nav>
  );
}
