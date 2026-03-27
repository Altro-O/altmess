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
  kind?: 'text' | 'call' | 'voice' | 'file';
  replyTo?: {
    id: string;
    senderId: string;
    content: string;
    kind?: 'text' | 'call' | 'voice' | 'file';
  } | null;
  reactions?: Array<{
    emoji: string;
    userIds: string[];
  }>;
  voice?: {
    audioUrl: string;
    durationSeconds: number;
  } | null;
  attachment?: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    fileUrl: string;
  } | null;
  callEvent?: {
    mode: 'audio' | 'video';
    status: 'accepted' | 'missed' | 'rejected' | 'ended';
    durationSeconds?: number;
    actorId?: string;
  } | null;
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

const TOKEN_KEY = 'altmess_token';
const USER_KEY = 'altmess_user';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function persistSessionCookie(token: string) {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `altmess_token=${encodeURIComponent(token)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
}

function clearSessionCookie() {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = 'altmess_token=; Max-Age=0; Path=/; SameSite=Lax';
}

function getTokenFromCookie() {
  if (typeof document === 'undefined') {
    return null;
  }

  const match = document.cookie.match(/(?:^|; )altmess_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function getStoredToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  return localStorage.getItem(TOKEN_KEY) || getTokenFromCookie();
}

export function getStoredUser() {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = localStorage.getItem(USER_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function storeSession(token: string, user: AuthUser) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  persistSessionCookie(token);
}

export function clearSession() {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  clearSessionCookie();
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
