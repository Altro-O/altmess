export interface AuthUser {
  id: string;
  username: string;
  email: string;
  createdAt?: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  avatarColor?: string;
  lastSeenAt?: string | null;
}

export interface Contact extends AuthUser {
  online: boolean;
  lastMessage?: ChatMessage | null;
  unreadCount?: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  updatedAt?: string | null;
  deletedAt?: string | null;
  status: 'sent' | 'delivered' | 'read';
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
}

type RequestOptions = RequestInit & {
  token?: string | null;
};

export function getStoredToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  return localStorage.getItem('altmess_token');
}

export function storeSession(token: string, user: AuthUser) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem('altmess_token', token);
  localStorage.setItem('altmess_user', JSON.stringify(user));
}

export function clearSession() {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.removeItem('altmess_token');
  localStorage.removeItem('altmess_user');
}

export async function apiFetch<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');

  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Ошибка запроса');
  }

  return data as T;
}
