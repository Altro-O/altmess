'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, clearUser, getStoredUser, storeUser, type AuthUser } from '../utils/api';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  updateUser: (user: AuthUser) => void;
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
      const storedUser = getStoredUser();

      try {
        const response = await apiFetch<{ user: AuthUser }>('/api/auth/me');
        setToken(response.user.id);
        setUser(response.user);
        storeUser(response.user);
      } catch {
        clearUser();
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
        storeUser(nextUser);
        setToken(nextToken);
        setUser(nextUser);
      },
      updateUser: (nextUser) => {
        storeUser(nextUser);
        setUser(nextUser);
      },
      logout: async () => {
        try {
          await apiFetch('/api/auth/logout', { method: 'POST' });
        } catch {
          // ignore logout errors
        }
        clearUser();
        setToken(null);
        setUser(null);
        router.push('/');
      },
    }),
    [isLoading, router, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
