export interface AuthUser {
  id: string;
  username: string;
  email: string;
  createdAt?: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  avatarStorageKey?: string | null;
  avatarStorageKind?: 'local' | 'vps' | null;
  avatarColor?: string;
  lastSeenAt?: string | null;
  pinnedChatIds?: string[];
}

export interface Contact extends AuthUser {
  type?: 'direct' | 'group';
  memberIds?: string[];
  ownerId?: string;
  online: boolean;
  lastMessage?: ChatMessage | null;
  unreadCount?: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName?: string;
  recipientId: string;
  groupId?: string | null;
  content: string;
  forwardedFrom?: {
    senderId: string;
    senderName: string;
  } | null;
  kind?: 'text' | 'call' | 'voice' | 'file';
  replyTo?: {
    id: string;
    senderId: string;
    senderName?: string;
    content: string;
    quote?: string | null;
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
    isSticker?: boolean;
    packKey?: string;
    storageKey?: string | null;
    storageKind?: 'inline' | 'local' | 'sticker' | 'vps' | null;
    storageStatus?: 'ready' | 'deleted' | 'expired' | null;
    uploadedAt?: string | null;
  } | null;
  callEvent?: {
    mode: 'audio' | 'video';
    status: 'accepted' | 'missed' | 'rejected' | 'ended';
    durationSeconds?: number;
    actorId?: string;
  } | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
  pinnedAt?: string | null;
  status: 'sent' | 'delivered' | 'read';
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface MessagesPage {
  messages: ChatMessage[];
  pinnedMessages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface GroupDetails {
  group: Contact;
  members: Contact[];
  availableContacts: Contact[];
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
