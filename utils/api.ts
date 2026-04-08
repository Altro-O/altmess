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

const USER_KEY = 'altmess_user';
const TOKEN_KEY = 'altmess_token';

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

export function storeUser(user: AuthUser) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(TOKEN_KEY, token);
}

export function clearUser() {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
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
    credentials: 'include',
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Ошибка запроса');
  }

  return data as T;
}
