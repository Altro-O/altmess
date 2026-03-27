import { generatePrivateKey, hashPassword } from './crypto';

export interface StoredUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  encryptionKey: string;
  createdAt: string;
}

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  encryptionKey: string;
}

export interface StoredMessage {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  encryptedContent: string;
  timestamp: string;
}

const USERS_KEY = 'altmess_users';
const SESSION_KEY = 'altmess_session';
const MESSAGES_KEY = 'altmess_messages';

function isBrowser() {
  return typeof window !== 'undefined';
}

function readJson<T>(key: string, fallback: T): T {
  if (!isBrowser()) {
    return fallback;
  }

  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (!isBrowser()) {
    return;
  }

  localStorage.setItem(key, JSON.stringify(value));
}

function toSessionUser(user: StoredUser): SessionUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    encryptionKey: user.encryptionKey,
  };
}

function seedUsersIfNeeded() {
  const users = readJson<StoredUser[]>(USERS_KEY, []);

  if (users.length > 0) {
    return users;
  }

  const seededUsers: StoredUser[] = [
    {
      id: 'demo-alex',
      username: 'alex',
      email: 'alex@altmess.local',
      passwordHash: hashPassword('alex12345'),
      encryptionKey: generatePrivateKey(),
      createdAt: new Date().toISOString(),
    },
    {
      id: 'demo-sam',
      username: 'sam',
      email: 'sam@altmess.local',
      passwordHash: hashPassword('sam12345'),
      encryptionKey: generatePrivateKey(),
      createdAt: new Date().toISOString(),
    },
  ];

  writeJson(USERS_KEY, seededUsers);
  return seededUsers;
}

export function getStoredUsers() {
  return seedUsersIfNeeded();
}

export function getSessionUser(): SessionUser | null {
  return readJson<SessionUser | null>(SESSION_KEY, null);
}

export function registerLocalUser(input: {
  username: string;
  email: string;
  password: string;
}) {
  const users = getStoredUsers();
  const normalizedUsername = input.username.trim().toLowerCase();
  const normalizedEmail = input.email.trim().toLowerCase();

  if (users.some((user) => user.username.toLowerCase() === normalizedUsername)) {
    return { success: false as const, error: 'Имя пользователя уже занято' };
  }

  if (users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
    return { success: false as const, error: 'Email уже используется' };
  }

  const newUser: StoredUser = {
    id: `user-${Date.now()}`,
    username: input.username.trim(),
    email: input.email.trim(),
    passwordHash: hashPassword(input.password),
    encryptionKey: generatePrivateKey(),
    createdAt: new Date().toISOString(),
  };

  writeJson(USERS_KEY, [...users, newUser]);
  return { success: true as const, user: toSessionUser(newUser) };
}

export function loginLocalUser(input: { username: string; password: string }) {
  const users = getStoredUsers();
  const normalizedUsername = input.username.trim().toLowerCase();
  const passwordHash = hashPassword(input.password);

  const user = users.find(
    (entry) =>
      entry.username.toLowerCase() === normalizedUsername ||
      entry.email.toLowerCase() === normalizedUsername,
  );

  if (!user || user.passwordHash !== passwordHash) {
    return { success: false as const, error: 'Неверный логин или пароль' };
  }

  const sessionUser = toSessionUser(user);
  localStorage.setItem('user_token', `local-session-${user.id}`);
  localStorage.setItem('user_data', JSON.stringify(sessionUser));
  localStorage.setItem('encryption_key', user.encryptionKey);
  writeJson(SESSION_KEY, sessionUser);

  return { success: true as const, user: sessionUser };
}

export function logoutLocalUser() {
  if (!isBrowser()) {
    return;
  }

  localStorage.removeItem('user_token');
  localStorage.removeItem('user_data');
  localStorage.removeItem('encryption_key');
  localStorage.removeItem(SESSION_KEY);
}

export function getChatContacts(currentUserId: string) {
  const users = getStoredUsers();
  const currentUser = users.find((user) => user.id === currentUserId);

  const contacts = users
    .filter((user) => user.id !== currentUserId)
    .map((user, index) => ({
      id: user.id,
      name: user.username,
      preview: user.email,
      accent: index % 2 === 0 ? 'blue' : 'green',
    }));

  if (currentUser) {
    contacts.unshift({
      id: currentUser.id,
      name: 'Личное пространство',
      preview: 'Черновики, заметки и тестовые сообщения',
      accent: 'blue',
    });
  }

  return contacts;
}

export function getStoredMessages() {
  return readJson<StoredMessage[]>(MESSAGES_KEY, []);
}

export function getConversationMessages(currentUserId: string, contactId: string) {
  return getStoredMessages().filter((message) => {
    const directMatch =
      (message.senderId === currentUserId && message.recipientId === contactId) ||
      (message.senderId === contactId && message.recipientId === currentUserId);

    const selfMatch =
      currentUserId === contactId &&
      message.senderId === currentUserId &&
      message.recipientId === currentUserId;

    return directMatch || selfMatch;
  });
}

export function saveMessage(message: StoredMessage) {
  const messages = getStoredMessages();
  writeJson(MESSAGES_KEY, [...messages, message]);
}
