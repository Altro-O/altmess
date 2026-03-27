'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, getStoredToken, storeSession, type AuthUser } from '@/utils/api';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const bootstrap = async () => {
      const storedToken = getStoredToken();

      if (!storedToken) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await apiFetch<{ user: AuthUser }>('/api/auth/me', { token: storedToken });
        setToken(storedToken);
        setUser(response.user);
      } catch {
        clearSession();
        setToken(null);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    bootstrap();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: !!token && !!user,
      isLoading,
      token,
      user,
      login: (nextToken, nextUser) => {
        storeSession(nextToken, nextUser);
        setToken(nextToken);
        setUser(nextUser);
      },
      logout: () => {
        clearSession();
        setToken(null);
        setUser(null);
        router.push('/');
      },
    }),
    [isLoading, router, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
