const http = require('http');
const express = require('express');
const next = require('next');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const webpush = require('web-push');
const { loadState, saveState, getState, DATABASE_URL } = require('./persistence');
const { createGroupCallStore } = require('./group-calls');
const {
  ensureGroupsState,
  isGroupContactId,
  getGroupByContactId,
  isGroupMember,
  isGroupOwner,
  buildGroupContact,
  buildGroupMembers,
  buildAvailableGroupContacts,
  buildGroupDialogs,
  getGroupPage,
  createGroupRecord,
  normalizePinnedTargetIds,
  toGroupContactId,
} = require('./groups');

const lifecycle = process.env.npm_lifecycle_event;
const dev = process.env.NODE_ENV !== 'production' && lifecycle !== 'start';
const hostname = '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const JWT_SECRET = process.env.JWT_SECRET || 'altmess-dev-secret-change-me';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const RING_TIMEOUT_MS = 30000;
const CALL_RECONNECT_GRACE_MS = Number(process.env.CALL_RECONNECT_GRACE_MS || 45000);
const MAX_MEDIA_UPLOAD_BYTES = 12 * 1024 * 1024;
const MEDIA_UPLOAD_DIR = path.resolve(process.env.MEDIA_UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
const MEDIA_PUBLIC_BASE_URL = String(process.env.MEDIA_PUBLIC_BASE_URL || '').trim();
const MEDIA_UPSTREAM_URL = String(process.env.MEDIA_UPSTREAM_URL || '').trim().replace(/\/$/, '');
const MEDIA_UPSTREAM_TOKEN = String(process.env.MEDIA_UPSTREAM_TOKEN || '').trim();
const AUTH_COOKIE_NAME = 'altmess_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
];
const groupCallStore = createGroupCallStore();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function readDb() {
  return ensureGroupsState(getState());
}

async function writeDb(data) {
  try {
    await saveState(data);
  } catch (error) {
    console.error('Failed to persist state:', error);
  }
}

async function ensureMediaUploadDir() {
  await fs.mkdir(MEDIA_UPLOAD_DIR, { recursive: true });
}

function hasMediaUpstream() {
  return Boolean(MEDIA_UPSTREAM_URL && MEDIA_UPSTREAM_TOKEN);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    displayName: user.displayName || user.username,
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    avatarStorageKey: user.avatarStorageKey || null,
    avatarStorageKind: user.avatarStorageKind || null,
    avatarColor: user.avatarColor || 'ocean',
    lastSeenAt: user.lastSeenAt || null,
    pinnedChatIds: Array.isArray(user.pinnedChatIds) ? user.pinnedChatIds.map(String) : [],
  };
}

function createToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return typeof payload === 'object' && payload ? payload : null;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|; )${AUTH_COOKIE_NAME}=([^;]+)`));
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  return null;
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: AUTH_COOKIE_MAX_AGE * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
}

function getIceServers() {
  const turnUrls = [
    ...String(process.env.TURN_URLS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    ...String(process.env.TURN_URL || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (turnUrls.length === 0 || !turnUsername || !turnCredential) {
    return DEFAULT_ICE_SERVERS;
  }

  return [
    ...DEFAULT_ICE_SERVERS,
    {
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    },
  ];
}

function supportsPushNotifications() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function getCallPeerId(call, userId) {
  return call.callerId === userId ? call.recipientId : call.callerId;
}

function normalizeQuery(value) {
  return String(value || '').trim().toLowerCase();
}

function getConversationMessages(db, firstUserId, secondUserId) {
  return db.messages
    .filter(
      (message) =>
        (message.senderId === firstUserId && message.recipientId === secondUserId) ||
        (message.senderId === secondUserId && message.recipientId === firstUserId),
    )
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
}

function getConversationPage(db, firstUserId, secondUserId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 40, 1), 100);
  const beforeMessageId = options.beforeMessageId ? String(options.beforeMessageId) : '';
  const messages = getConversationMessages(db, firstUserId, secondUserId);

  let endIndex = messages.length;
  if (beforeMessageId) {
    const beforeIndex = messages.findIndex((message) => message.id === beforeMessageId);
    endIndex = beforeIndex >= 0 ? beforeIndex : messages.length;
  }

  const startIndex = Math.max(0, endIndex - limit);
  const pageMessages = messages.slice(startIndex, endIndex).map(sanitizeMessage);
  const hasMore = startIndex > 0;
  const pinnedMessages = messages
    .filter((message) => message.pinnedAt)
    .sort((first, second) => String(second.pinnedAt).localeCompare(String(first.pinnedAt)))
    .slice(0, 10)
    .map(sanitizeMessage);

  return {
    messages: pageMessages,
    pinnedMessages,
    hasMore,
    nextCursor: hasMore && pageMessages[0] ? pageMessages[0].id : null,
  };
}

function normalizePinnedChatIds(input, currentUserId, db) {
  return normalizePinnedTargetIds(input, currentUserId, db);
}

function sanitizeMessage(message) {
  if (!message.deletedAt) {
    return message;
  }

  return {
    ...message,
    content: 'Сообщение удалено',
    voice: null,
    attachment: null,
    reactions: [],
  };
}

function getMessagePeerId(message, currentUserId) {
  if (message.groupId) {
    return toGroupContactId(message.groupId);
  }

  return message.senderId === currentUserId ? message.recipientId : message.senderId;
}

function buildPublicUploadUrl(relativePath) {
  const normalized = `/uploads/${relativePath.replace(/\\/g, '/')}`;
  if (!MEDIA_PUBLIC_BASE_URL) {
    return normalized;
  }

  return `${MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}${normalized}`;
}

function getFileExtension(fileName, mimeType) {
  const explicitExtension = path.extname(String(fileName || '')).slice(1).trim().toLowerCase();
  if (explicitExtension) {
    return explicitExtension.slice(0, 12);
  }

  const subtype = String(mimeType || '').split('/')[1] || 'bin';
  return subtype.split(';')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'bin';
}

function sanitizeUploadFileName(fileName) {
  let normalizedName = String(fileName || 'file');

  try {
    normalizedName = decodeURIComponent(normalizedName);
  } catch {
    normalizedName = String(fileName || 'file');
  }

  const baseName = path.basename(normalizedName);
  return baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

async function storeUploadedMedia(buffer, fileName, mimeType) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const directory = path.join(MEDIA_UPLOAD_DIR, year, month);
  const safeFileName = sanitizeUploadFileName(fileName);
  const extension = getFileExtension(safeFileName, mimeType);
  const storageKey = path.posix.join(year, month, `${randomUUID()}.${extension}`);
  const filePath = path.join(directory, path.basename(storageKey));

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, buffer);

  return {
    fileUrl: buildPublicUploadUrl(storageKey),
    storageKey,
    storageKind: 'local',
    storageStatus: 'ready',
    uploadedAt: now.toISOString(),
    originalFileName: safeFileName,
  };
}

function resolveStoredMediaPath(fileUrl) {
  const rawUrl = String(fileUrl || '').trim();

  if (!rawUrl || rawUrl.startsWith('data:')) {
    return null;
  }

  let pathname = rawUrl;

  try {
    if (MEDIA_PUBLIC_BASE_URL && rawUrl.startsWith(MEDIA_PUBLIC_BASE_URL)) {
      pathname = new URL(rawUrl).pathname;
    } else if (/^https?:\/\//i.test(rawUrl)) {
      return null;
    }
  } catch {
    return null;
  }

  const normalizedPath = pathname.replace(/\\/g, '/');
  if (!normalizedPath.startsWith('/uploads/')) {
    return null;
  }

  const relativePath = normalizedPath.slice('/uploads/'.length);
  const targetPath = path.resolve(MEDIA_UPLOAD_DIR, relativePath);

  if (!targetPath.startsWith(MEDIA_UPLOAD_DIR)) {
    return null;
  }

  return targetPath;
}

async function deleteStoredMediaAttachment(attachment) {
  if (!attachment?.fileUrl || attachment.isSticker) {
    return false;
  }

  if (attachment.storageKind === 'vps' && attachment.storageKey && hasMediaUpstream()) {
    try {
      const response = await fetch(`${MEDIA_UPSTREAM_URL}/upload/${encodeURIComponent(attachment.storageKey)}`, {
        method: 'DELETE',
        headers: {
          'X-Media-Token': MEDIA_UPSTREAM_TOKEN,
        },
      });

      return response.ok;
    } catch (error) {
      console.error('Failed to delete VPS media:', error);
      return false;
    }
  }

  if (attachment.storageKind !== 'local') {
    return false;
  }

  const filePath = resolveStoredMediaPath(attachment.fileUrl);
  if (!filePath) {
    return false;
  }

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    console.error('Failed to delete stored media:', error);
    return false;
  }
}

async function deleteStoredAvatar(user) {
  if (!user?.avatarUrl || !user?.avatarStorageKind || !user?.avatarStorageKey) {
    return false;
  }

  return deleteStoredMediaAttachment({
    fileUrl: user.avatarUrl,
    storageKind: user.avatarStorageKind,
    storageKey: user.avatarStorageKey,
  });
}

async function uploadToMediaUpstream(req, res, fileName, mimeType, sizeBytes) {
  const response = await fetch(`${MEDIA_UPSTREAM_URL}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      'X-Media-Token': MEDIA_UPSTREAM_TOKEN,
      'X-File-Name': fileName,
      'X-File-Size': String(sizeBytes),
    },
    body: req.body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.attachment) {
    res.status(response.status || 502).json({ error: data.error || 'Не удалось сохранить файл на VPS' });
    return true;
  }

  res.status(201).json({ attachment: data.attachment });
  return true;
}

function buildReplyPreview(message, quoteText = '') {
  if (!message) {
    return null;
  }

  const quote = typeof quoteText === 'string' && quoteText.trim()
    ? quoteText.trim().slice(0, 280)
    : null;

  return {
    id: message.id,
    senderId: message.senderId,
    senderName: message.senderName || '',
    content: message.kind === 'voice' ? 'Голосовое сообщение' : message.kind === 'file' ? 'Файл' : sanitizeMessage(message).content,
    quote,
    kind: message.kind || 'text',
  };
}

function formatCallDuration(startedAt, endedAt) {
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  const totalSeconds = Math.max(0, Math.round((ended - started) / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds} сек`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildCallSummary(call, actorId) {
  const prefix = call.mode === 'video' ? 'Видеозвонок' : 'Аудиозвонок';

  if (call.status === 'missed') {
    return `${prefix} пропущен`;
  }

  if (call.status === 'accepted') {
    return `${prefix} принят`;
  }

  if (call.status === 'rejected') {
    return actorId === call.recipientId ? `${prefix} отклонен` : `${prefix} отменен`;
  }

  if (call.status === 'ended') {
    const duration = call.endedAt ? formatCallDuration(call.startedAt, call.endedAt) : null;
    return duration ? `${prefix} завершен · ${duration}` : `${prefix} завершен`;
  }

  return prefix;
}

function createCallLogMessage(db, call, actorId) {
  const now = call.endedAt || new Date().toISOString();
  const durationSeconds = call.endedAt
    ? Math.max(0, Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000))
    : 0;

  const message = {
    id: randomUUID(),
    senderId: call.callerId,
    recipientId: call.recipientId,
    content: buildCallSummary(call, actorId),
    kind: 'call',
    callEvent: {
      mode: call.mode,
      status: call.status,
      durationSeconds,
      actorId,
    },
    status: 'read',
    deliveredAt: now,
    readAt: now,
    createdAt: now,
    updatedAt: null,
    deletedAt: null,
  };

  db.messages.push(message);
  return message;
}

function createGroupCallLogMessage(db, group, room, actorId, status = 'ended') {
  const endedAt = new Date().toISOString();
  const call = {
    callerId: actorId,
    recipientId: `group:${group.id}`,
    groupId: group.id,
    mode: room.mode,
    status,
    startedAt: room.startedAt || room.createdAt || endedAt,
    endedAt,
  };
  const durationSeconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000));

  const message = {
    id: randomUUID(),
    senderId: actorId,
    senderName: db.users.find((user) => user.id === actorId)?.displayName || db.users.find((user) => user.id === actorId)?.username || 'Участник',
    recipientId: `group:${group.id}`,
    groupId: group.id,
    content: buildCallSummary({ ...call, endedAt }, actorId),
    kind: 'call',
    callEvent: {
      mode: room.mode,
      status,
      durationSeconds,
      actorId,
    },
    status: 'read',
    deliveredAt: endedAt,
    readAt: endedAt,
    createdAt: endedAt,
    updatedAt: null,
    deletedAt: null,
  };

  db.messages.push(message);
  return message;
}

async function persistCallLog(db, call, actorId) {
  const message = createCallLogMessage(db, call, actorId);
  await writeDb(db);
  const payload = sanitizeMessage(message);
  emitToUser(call.callerId, 'message:new', payload);
  emitToUser(call.recipientId, 'message:new', payload);
}

async function persistGroupCallLog(db, group, room, actorId) {
  const message = createGroupCallLogMessage(db, group, room, actorId, 'ended');
  await writeDb(db);
  const payload = sanitizeMessage(message);
  group.memberIds.forEach((memberId) => emitToUser(memberId, 'message:new', payload));
}

app.prepare().then(async () => {
  await loadState();
  if (!hasMediaUpstream()) {
    await ensureMediaUploadDir();
  }

  const expressApp = express();
  const server = http.createServer(expressApp);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });
  const activeUsers = new Map();
  const activeCalls = new Map();
  const ringTimeouts = new Map();
  const callReconnectTimeouts = new Map();

  function isUserOnline(userId) {
    return activeUsers.has(userId);
  }

  function setUserSocket(userId, socketId) {
    const sockets = activeUsers.get(userId) || new Set();
    sockets.add(socketId);
    activeUsers.set(userId, sockets);
    [...activeCalls.values()]
      .filter((call) => ['ringing', 'active'].includes(call.status) && (call.callerId === userId || call.recipientId === userId))
      .forEach((call) => {
        restoreCallConnection(call.id, userId);
      });
  }

  function removeUserSocket(userId, socketId) {
    const sockets = activeUsers.get(userId);
    if (!sockets) {
      return;
    }

    sockets.delete(socketId);
    if (sockets.size === 0) {
      activeUsers.delete(userId);
    }
  }

  function emitToUser(userId, event, payload) {
    const sockets = activeUsers.get(userId);
    if (!sockets) {
      return;
    }

    sockets.forEach((socketId) => io.to(socketId).emit(event, payload));
  }

  function emitToGroupMembers(group, event, payload, exceptUserId = null) {
    group.memberIds.forEach((memberId) => {
      if (exceptUserId && memberId === exceptUserId) {
        return;
      }

      emitToUser(memberId, event, payload);
    });
  }

  function getUserSockets(userId) {
    return [...(activeUsers.get(userId) || [])]
      .map((socketId) => io.sockets.sockets.get(socketId))
      .filter(Boolean);
  }

  function hasVisibleSocket(userId) {
    return getUserSockets(userId).some((socket) => socket.data.isVisible !== false);
  }

  async function removePushSubscriptionByEndpoint(endpoint) {
    const db = readDb();
    const nextSubscriptions = db.pushSubscriptions.filter((entry) => entry.endpoint !== endpoint);
    if (nextSubscriptions.length === db.pushSubscriptions.length) {
      return;
    }

    db.pushSubscriptions = nextSubscriptions;
    await writeDb(db);
  }

  async function sendPushToUser(userId, payload) {
    if (!supportsPushNotifications()) {
      return;
    }

    const db = readDb();
    const subscriptions = db.pushSubscriptions.filter((entry) => entry.userId === userId);

    await Promise.all(
      subscriptions.map(async (entry) => {
        try {
          await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            await removePushSubscriptionByEndpoint(entry.endpoint);
            return;
          }

          console.error('Failed to send push notification:', error);
        }
      }),
    );
  }

  function clearRingTimeout(callId) {
    const timeout = ringTimeouts.get(callId);
    if (timeout) {
      clearTimeout(timeout);
      ringTimeouts.delete(callId);
    }
  }

  function clearCallReconnectTimeout(callId, userId) {
    const timeoutKey = `${callId}:${userId}`;
    const timeout = callReconnectTimeouts.get(timeoutKey);
    if (timeout) {
      clearTimeout(timeout);
      callReconnectTimeouts.delete(timeoutKey);
    }
  }

  function restoreCallConnection(callId, userId) {
    const call = activeCalls.get(String(callId));
    if (!call || !['ringing', 'active'].includes(call.status) || (call.callerId !== userId && call.recipientId !== userId)) {
      return false;
    }

    const timeoutKey = `${call.id}:${userId}`;
    const timeout = callReconnectTimeouts.get(timeoutKey);
    if (!timeout) {
      return false;
    }

    clearTimeout(timeout);
    callReconnectTimeouts.delete(timeoutKey);
    emitToUser(getCallPeerId(call, userId), 'call:peer-reconnected', { callId: call.id, userId });
    return true;
  }

  function scheduleCallReconnectTimeout(call, disconnectedUserId) {
    clearCallReconnectTimeout(call.id, disconnectedUserId);
    const timeoutKey = `${call.id}:${disconnectedUserId}`;
    const timeout = setTimeout(async () => {
      const db = readDb();
      const storedCall = db.calls.find((entry) => entry.id === call.id);
      if (!storedCall || !['ringing', 'active'].includes(storedCall.status) || isUserOnline(disconnectedUserId)) {
        callReconnectTimeouts.delete(timeoutKey);
        return;
      }

      clearRingTimeout(call.id);
      call.status = 'ended';
      call.endedAt = new Date().toISOString();
      storedCall.status = 'ended';
      storedCall.endedAt = call.endedAt;
      activeCalls.delete(call.id);
      callReconnectTimeouts.delete(timeoutKey);
      emitToUser(getCallPeerId(call, disconnectedUserId), 'call:ended', { callId: call.id, byUserId: disconnectedUserId });
      persistCallLog(db, storedCall, disconnectedUserId).catch((error) => {
        console.error('Failed to persist reconnect-timeout call log:', error);
      });
    }, CALL_RECONNECT_GRACE_MS);

    callReconnectTimeouts.set(timeoutKey, timeout);
  }

  function emitIncomingCall(call, fromUser) {
    emitToUser(call.recipientId, 'call:incoming', {
      callId: call.id,
      mode: call.mode,
      fromUser,
    });
  }

  function scheduleRingTimeout(callId) {
    clearRingTimeout(callId);
    const timeout = setTimeout(async () => {
      const db = readDb();
      const call = activeCalls.get(callId);
      const storedCall = db.calls.find((entry) => entry.id === callId);

      if (!call || !storedCall || storedCall.status !== 'ringing') {
        return;
      }

      const endedAt = new Date().toISOString();
      call.status = 'missed';
      call.endedAt = endedAt;
      storedCall.status = 'missed';
      storedCall.endedAt = endedAt;
      activeCalls.delete(callId);
      ringTimeouts.delete(callId);
      emitToUser(call.callerId, 'call:missed', { callId, byUserId: call.recipientId });
      emitToUser(call.recipientId, 'call:missed', { callId, byUserId: call.recipientId });
      persistCallLog(db, storedCall, call.recipientId).catch((error) => {
        console.error('Failed to persist missed call log:', error);
      });
    }, RING_TIMEOUT_MS);

    ringTimeouts.set(callId, timeout);
  }

  function syncPendingCall(userId) {
    const db = readDb();
    const pendingCall = [...activeCalls.values()].find((call) => call.recipientId === userId && call.status === 'ringing');
    if (!pendingCall) {
      return;
    }

    const fromUser = db.users.find((entry) => entry.id === pendingCall.callerId);
    if (!fromUser) {
      return;
    }

    emitIncomingCall(pendingCall, publicUser(fromUser));
  }

  function buildPresencePayload(currentUserId) {
    const db = readDb();
    return db.users
      .filter((user) => user.id !== currentUserId)
      .map((user) => ({ id: user.id, online: isUserOnline(user.id), lastSeenAt: user.lastSeenAt || null }));
  }

  function broadcastPresence(userId) {
    const db = readDb();
    const currentUser = db.users.find((user) => user.id === userId);
    const payload = { id: userId, online: isUserOnline(userId), lastSeenAt: currentUser?.lastSeenAt || null };
    db.users.filter((user) => user.id !== userId).forEach((user) => emitToUser(user.id, 'presence:update', payload));
  }

  function buildContactList(currentUserId, searchQuery = '') {
    const db = readDb();
    const query = normalizeQuery(searchQuery);
    const users = db.users.filter((user) => {
      if (user.id === currentUserId) {
        return false;
      }

      if (!query) {
        return true;
      }

      return user.username.toLowerCase().includes(query) || user.email.toLowerCase().includes(query);
    });

    return users
      .map((user) => {
        const lastMessage = getConversationMessages(db, currentUserId, user.id).at(-1) || null;
        const unreadCount = db.messages.filter(
          (message) => message.senderId === user.id && message.recipientId === currentUserId && !message.readAt,
        ).length;

        return {
          ...publicUser(user),
          type: 'direct',
          online: isUserOnline(user.id),
          lastMessage: lastMessage ? sanitizeMessage(lastMessage) : null,
          unreadCount,
        };
      })
      .sort((first, second) => {
        const firstTime = first.lastMessage?.createdAt || first.createdAt || '';
        const secondTime = second.lastMessage?.createdAt || second.createdAt || '';
        return secondTime.localeCompare(firstTime);
      });
  }

  function buildDialogs(currentUserId) {
    const directDialogs = buildContactList(currentUserId).filter((contact) => contact.lastMessage || contact.unreadCount > 0);
    const groupDialogs = buildGroupDialogs(readDb(), currentUserId, sanitizeMessage);

    return [...directDialogs, ...groupDialogs]
      .sort((first, second) => {
        const firstTime = first.lastMessage?.createdAt || first.createdAt || '';
        const secondTime = second.lastMessage?.createdAt || second.createdAt || '';
        return secondTime.localeCompare(firstTime);
      });
  }

  function emitMessageStatus(message) {
    const payload = {
      id: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      status: message.status,
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    };

    emitToUser(message.senderId, 'message:status', payload);
    emitToUser(message.recipientId, 'message:status', payload);
  }

  function markMessagesDelivered(currentUserId, messageIds = []) {
    const db = readDb();
    const now = new Date().toISOString();
    const changedIds = [];
    const allowedIds = new Set((Array.isArray(messageIds) ? messageIds : []).map((value) => String(value)));

    db.messages.forEach((message) => {
      if (message.recipientId === currentUserId && !message.deliveredAt && allowedIds.has(message.id)) {
        message.deliveredAt = now;
        message.status = message.readAt ? 'read' : 'delivered';
        changedIds.push(message.id);
        emitMessageStatus(message);
      }
    });

    if (changedIds.length > 0) {
      writeDb(db);
    }

    return changedIds;
  }

  function markConversationRead(currentUserId, contactId, messageIds = []) {
    const db = readDb();
    const now = new Date().toISOString();
    const changedIds = [];
    const allowedIds = new Set((Array.isArray(messageIds) ? messageIds : []).map((value) => String(value)));

    db.messages.forEach((message) => {
      if (
        message.senderId === contactId &&
        message.recipientId === currentUserId &&
        !message.readAt &&
        (allowedIds.size === 0 || allowedIds.has(message.id))
      ) {
        message.deliveredAt = message.deliveredAt || now;
        message.readAt = now;
        message.status = 'read';
        changedIds.push(message.id);
        emitMessageStatus(message);
      }
    });

    if (changedIds.length > 0) {
      writeDb(db);
    }

    return changedIds;
  }

  function authMiddleware(req, res, nextMiddleware) {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Требуется авторизация' });
      return;
    }

    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Сессия недействительна' });
      return;
    }

    const db = readDb();
    const user = db.users.find((entry) => entry.id === payload.userId);
    if (!user) {
      res.status(401).json({ error: 'Пользователь не найден' });
      return;
    }

    req.user = publicUser(user);
    nextMiddleware();
  }

  expressApp.use(express.json({ limit: '2mb' }));
  if (!hasMediaUpstream()) {
    expressApp.use('/uploads', express.static(MEDIA_UPLOAD_DIR, {
      fallthrough: false,
      index: false,
      maxAge: '7d',
    }));
  }

  expressApp.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true });
  });

  expressApp.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Все поля обязательны для заполнения' });
      return;
    }

    const trimmedUsername = String(username).trim();
    const trimmedEmail = String(email).trim().toLowerCase();

    if (trimmedUsername.length < 3 || String(password).length < 6) {
      res.status(400).json({ error: 'Логин должен быть от 3 символов, пароль - от 6 символов' });
      return;
    }

    const db = readDb();
    if (db.users.some((user) => user.username.toLowerCase() === trimmedUsername.toLowerCase())) {
      res.status(409).json({ error: 'Имя пользователя уже занято' });
      return;
    }

    if (db.users.some((user) => user.email.toLowerCase() === trimmedEmail)) {
      res.status(409).json({ error: 'Email уже используется' });
      return;
    }

    const user = {
      id: randomUUID(),
      username: trimmedUsername,
      email: trimmedEmail,
      passwordHash: await bcrypt.hash(String(password), 10),
      createdAt: new Date().toISOString(),
      displayName: trimmedUsername,
      bio: '',
      avatarUrl: '',
      avatarColor: 'ocean',
      pinnedChatIds: [],
      lastSeenAt: null,
    };

    db.users.push(user);
    writeDb(db);

    const token = createToken(user);
    setAuthCookie(res, token);
    res.status(201).json({ token, user: publicUser(user), iceServers: getIceServers() });
  });

  expressApp.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const loginValue = normalizeQuery(username);
    const db = readDb();
    const user = db.users.find(
      (entry) =>
        entry.username.toLowerCase() === loginValue || entry.email.toLowerCase() === loginValue,
    );

    if (!user || !(await bcrypt.compare(String(password), user.passwordHash))) {
      res.status(401).json({ error: 'Неверный логин или пароль' });
      return;
    }

    const token = createToken(user);
    setAuthCookie(res, token);
    res.json({ token, user: publicUser(user), iceServers: getIceServers() });
  });

  expressApp.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  expressApp.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ user: req.user, iceServers: getIceServers() });
  });

  expressApp.patch('/api/profile', authMiddleware, async (req, res) => {
    const db = readDb();
    const user = db.users.find((entry) => entry.id === req.user.id);

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    const nextDisplayName = String(req.body?.displayName || user.displayName || user.username).trim();
    const nextBio = String(req.body?.bio || '').trim();
    const nextAvatarUrl = String(req.body?.avatarUrl || '').trim();
    const nextAvatarStorageKey = req.body?.avatarStorageKey ? String(req.body.avatarStorageKey) : null;
    const nextAvatarStorageKind = req.body?.avatarStorageKind ? String(req.body.avatarStorageKind) : null;
    const nextAvatarColor = String(req.body?.avatarColor || user.avatarColor || 'ocean');

    const avatarChanged = user.avatarUrl && user.avatarUrl !== nextAvatarUrl;
    if (avatarChanged) {
      await deleteStoredAvatar(user);
    }

    user.displayName = nextDisplayName.slice(0, 32) || user.username;
    user.bio = nextBio.slice(0, 90);
    user.avatarUrl = nextAvatarUrl.slice(0, 500);
    user.avatarStorageKey = nextAvatarStorageKey;
    user.avatarStorageKind = nextAvatarStorageKind === 'local' || nextAvatarStorageKind === 'vps' ? nextAvatarStorageKind : null;
    user.avatarColor = ['ocean', 'mint', 'sunset', 'berry', 'slate'].includes(nextAvatarColor)
      ? nextAvatarColor
      : 'ocean';

    await writeDb(db);
    res.json({ user: publicUser(user) });
  });

  expressApp.get('/api/users/search', authMiddleware, (req, res) => {
    res.json({ users: buildContactList(req.user.id, req.query.q || '') });
  });

  expressApp.get('/api/users/contacts', authMiddleware, (req, res) => {
    res.json({ contacts: buildContactList(req.user.id, req.query.q || '') });
  });

  expressApp.get('/api/dialogs', authMiddleware, (req, res) => {
    res.json({ dialogs: buildDialogs(req.user.id) });
  });

  expressApp.post('/api/groups', authMiddleware, async (req, res) => {
    const db = readDb();
    const title = String(req.body?.title || '').trim();
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String) : [];

    if (title.length < 2) {
      res.status(400).json({ error: 'Название группы слишком короткое' });
      return;
    }

    const validUserIds = new Set(db.users.map((user) => user.id));
    const nextMemberIds = memberIds.filter((memberId) => validUserIds.has(memberId) && memberId !== req.user.id);
    if (nextMemberIds.length === 0) {
      res.status(400).json({ error: 'Выберите хотя бы одного участника' });
      return;
    }

    const group = createGroupRecord({ ownerId: req.user.id, title, memberIds: nextMemberIds });
    db.groups.push(group);
    await writeDb(db);
    group.memberIds.forEach((memberId) => {
      emitToUser(memberId, 'group:new', { group: buildGroupContact(db, group, memberId, sanitizeMessage) });
    });
    res.status(201).json({ group: buildGroupContact(db, group, req.user.id, sanitizeMessage) });
  });

  expressApp.get('/api/groups/:groupId', authMiddleware, (req, res) => {
    const db = readDb();
    const group = db.groups.find((entry) => entry.id === String(req.params.groupId || ''));
    const directDialogs = buildDialogs(req.user.id).filter((contact) => contact.type === 'direct');

    if (!group || !isGroupMember(group, req.user.id)) {
      res.status(404).json({ error: 'Группа не найдена' });
      return;
    }

    res.json({
      group: buildGroupContact(db, group, req.user.id, sanitizeMessage),
      members: buildGroupMembers(db, group, publicUser),
      availableContacts: buildAvailableGroupContacts(directDialogs, group, req.user.id),
    });
  });

  expressApp.patch('/api/groups/:groupId', authMiddleware, async (req, res) => {
    const db = readDb();
    const group = db.groups.find((entry) => entry.id === String(req.params.groupId || ''));
    const directDialogs = buildDialogs(req.user.id).filter((contact) => contact.type === 'direct');

    if (!group || !isGroupMember(group, req.user.id)) {
      res.status(404).json({ error: 'Группа не найдена' });
      return;
    }

    if (!isGroupOwner(group, req.user.id)) {
      res.status(403).json({ error: 'Только владелец группы может управлять участниками' });
      return;
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const addMemberIds = Array.isArray(req.body?.addMemberIds) ? req.body.addMemberIds.map(String) : [];
    const removeMemberIds = Array.isArray(req.body?.removeMemberIds) ? req.body.removeMemberIds.map(String) : [];
    const validUserIds = new Set(db.users.map((user) => user.id));

    if (title) {
      group.title = title.slice(0, 60);
    }

    const previousMemberIds = [...group.memberIds];
    const nextMembers = new Set(group.memberIds);
    addMemberIds.forEach((memberId) => {
      if (validUserIds.has(memberId)) {
        nextMembers.add(memberId);
      }
    });
    removeMemberIds.forEach((memberId) => {
      if (memberId !== group.ownerId) {
        nextMembers.delete(memberId);
      }
    });
    group.memberIds = Array.from(nextMembers);

    await writeDb(db);

    group.memberIds.forEach((memberId) => {
      emitToUser(memberId, 'group:update', { group: buildGroupContact(db, group, memberId, sanitizeMessage) });
    });
    previousMemberIds
      .filter((memberId) => !group.memberIds.includes(memberId))
      .forEach((memberId) => emitToUser(memberId, 'group:removed', { groupId: group.id }));

    res.json({
      group: buildGroupContact(db, group, req.user.id, sanitizeMessage),
      members: buildGroupMembers(db, group, publicUser),
      availableContacts: buildAvailableGroupContacts(directDialogs, group, req.user.id),
    });
  });

  expressApp.post('/api/groups/:groupId/leave', authMiddleware, async (req, res) => {
    const db = readDb();
    const group = db.groups.find((entry) => entry.id === String(req.params.groupId || ''));

    if (!group || !isGroupMember(group, req.user.id)) {
      res.status(404).json({ error: 'Группа не найдена' });
      return;
    }

    if (isGroupOwner(group, req.user.id)) {
      res.status(400).json({ error: 'Владелец не может выйти из группы без удаления. Сначала удалите группу.' });
      return;
    }

    group.memberIds = group.memberIds.filter((memberId) => memberId !== req.user.id);
    await writeDb(db);

    emitToUser(req.user.id, 'group:removed', { groupId: group.id });
    group.memberIds.forEach((memberId) => {
      emitToUser(memberId, 'group:update', { group: buildGroupContact(db, group, memberId, sanitizeMessage) });
    });

    res.json({ ok: true });
  });

  expressApp.delete('/api/groups/:groupId', authMiddleware, async (req, res) => {
    const db = readDb();
    const groupId = String(req.params.groupId || '');
    const group = db.groups.find((entry) => entry.id === groupId);

    if (!group || !isGroupMember(group, req.user.id)) {
      res.status(404).json({ error: 'Группа не найдена' });
      return;
    }

    if (!isGroupOwner(group, req.user.id)) {
      res.status(403).json({ error: 'Удалить группу может только владелец' });
      return;
    }

    db.groups = db.groups.filter((entry) => entry.id !== groupId);
    db.messages = db.messages.filter((message) => message.groupId !== groupId);
    await writeDb(db);

    group.memberIds.forEach((memberId) => {
      emitToUser(memberId, 'group:removed', { groupId });
    });

    res.json({ ok: true });
  });

  expressApp.get('/api/preferences', authMiddleware, (req, res) => {
    const db = readDb();
    const user = db.users.find((entry) => entry.id === req.user.id);
    res.json({
      pinnedChatIds: Array.isArray(user?.pinnedChatIds) ? user.pinnedChatIds.map(String) : [],
    });
  });

  expressApp.patch('/api/preferences', authMiddleware, async (req, res) => {
    const db = readDb();
    const user = db.users.find((entry) => entry.id === req.user.id);

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    user.pinnedChatIds = normalizePinnedChatIds(req.body?.pinnedChatIds, req.user.id, db);
    await writeDb(db);
    res.json({ pinnedChatIds: user.pinnedChatIds });
  });

  expressApp.get('/api/messages', authMiddleware, (req, res) => {
    const contactId = String(req.query.contactId || '');
    if (!contactId) {
      res.status(400).json({ error: 'Не указан contactId' });
      return;
    }

    const db = readDb();
    if (isGroupContactId(contactId)) {
      const group = getGroupByContactId(db, contactId);
      if (!group || !isGroupMember(group, req.user.id)) {
        res.status(404).json({ error: 'Группа не найдена' });
        return;
      }

      res.json(getGroupPage(db, group, {
        beforeMessageId: req.query.beforeMessageId,
        limit: req.query.limit,
      }, sanitizeMessage));
      return;
    }

    res.json(getConversationPage(db, req.user.id, contactId, {
      beforeMessageId: req.query.beforeMessageId,
      limit: req.query.limit,
    }));
  });

  expressApp.post('/api/uploads', authMiddleware, express.raw({ type: '*/*', limit: `${MAX_MEDIA_UPLOAD_BYTES}b` }), async (req, res) => {
    const fileName = sanitizeUploadFileName(req.headers['x-file-name']);
    const mimeType = String(req.headers['content-type'] || 'application/octet-stream').trim() || 'application/octet-stream';
    const sizeBytes = Number(req.headers['x-file-size'] || req.body?.length || 0);

    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Пустой файл' });
      return;
    }

    if (req.body.length > MAX_MEDIA_UPLOAD_BYTES) {
      res.status(413).json({ error: 'Файл слишком большой. Пока лимит 12 MB' });
      return;
    }

    try {
      if (hasMediaUpstream()) {
        await uploadToMediaUpstream(req, res, fileName, mimeType, sizeBytes);
        return;
      }

      const stored = await storeUploadedMedia(req.body, fileName, mimeType);
      res.status(201).json({
        attachment: {
          fileName,
          mimeType,
          sizeBytes,
          fileUrl: stored.fileUrl,
          storageKey: stored.storageKey,
          storageKind: stored.storageKind,
          storageStatus: stored.storageStatus,
          uploadedAt: stored.uploadedAt,
        },
      });
    } catch (error) {
      console.error('Failed to store uploaded media:', error);
      res.status(500).json({ error: 'Не удалось сохранить файл' });
    }
  });

  expressApp.post('/api/messages/read', authMiddleware, (req, res) => {
    const contactId = String(req.body?.contactId || '');
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    if (!contactId) {
      res.status(400).json({ error: 'Не указан contactId' });
      return;
    }

    res.json({ ok: true, messageIds: markConversationRead(req.user.id, contactId, messageIds) });
  });

  expressApp.get('/api/rtc/config', authMiddleware, (req, res) => {
    res.json({ iceServers: getIceServers() });
  });

  expressApp.get('/api/notifications/config', authMiddleware, (req, res) => {
    res.json({
      supported: supportsPushNotifications(),
      vapidPublicKey: VAPID_PUBLIC_KEY,
    });
  });

  expressApp.post('/api/notifications/subscribe', authMiddleware, async (req, res) => {
    if (!supportsPushNotifications()) {
      res.status(503).json({ error: 'Push-уведомления еще не настроены на сервере' });
      return;
    }

    const subscription = req.body?.subscription;
    const endpoint = String(subscription?.endpoint || '');
    const p256dh = String(subscription?.keys?.p256dh || '');
    const auth = String(subscription?.keys?.auth || '');

    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: 'Некорректная push-подписка' });
      return;
    }

    const db = readDb();
    const now = new Date().toISOString();
    const existing = db.pushSubscriptions.find((entry) => entry.endpoint === endpoint);

    if (existing) {
      existing.userId = req.user.id;
      existing.subscription = subscription;
      existing.updatedAt = now;
    } else {
      db.pushSubscriptions.push({
        id: randomUUID(),
        userId: req.user.id,
        endpoint,
        subscription,
        createdAt: now,
        updatedAt: now,
      });
    }

    await writeDb(db);
    res.json({ ok: true });
  });

  expressApp.delete('/api/notifications/subscribe', authMiddleware, async (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) {
      res.status(400).json({ error: 'Не указан endpoint подписки' });
      return;
    }

    await removePushSubscriptionByEndpoint(endpoint);
    res.json({ ok: true });
  });

  expressApp.all('*', (req, res) => handle(req, res));

  io.use((socket, nextSocket) => {
    const token = socket.handshake.auth?.token
      || (() => {
          const cookieHeader = socket.handshake.headers?.cookie || '';
          const match = cookieHeader.match(new RegExp(`(?:^|; )${AUTH_COOKIE_NAME}=([^;]+)`));
          return match ? decodeURIComponent(match[1]) : null;
        })();
    const payload = token ? verifyToken(token) : null;
    const db = readDb();
    const user = payload ? db.users.find((entry) => entry.id === payload.userId) : null;

    if (!user) {
      nextSocket(new Error('unauthorized'));
      return;
    }

    socket.data.user = publicUser(user);
    nextSocket();
  });

  io.on('connection', (socket) => {
    const currentUser = socket.data.user;
    socket.data.isVisible = true;
    setUserSocket(currentUser.id, socket.id);
    socket.emit('presence:sync', buildPresencePayload(currentUser.id));
    broadcastPresence(currentUser.id);
    syncPendingCall(currentUser.id);

    socket.on('client:visibility', ({ visible }) => {
      socket.data.isVisible = visible !== false;
    });

    socket.on('message:send', async (payload, callback) => {
      const content = String(payload?.content || '').trim();
      const recipientId = String(payload?.recipientId || '');
      const groupContactId = isGroupContactId(recipientId) ? recipientId : '';
      const kind = payload?.kind === 'voice' ? 'voice' : payload?.kind === 'file' ? 'file' : 'text';
      const voice = payload?.voice && typeof payload.voice.audioUrl === 'string'
        ? {
            audioUrl: String(payload.voice.audioUrl),
            durationSeconds: Number(payload.voice.durationSeconds || 0),
          }
        : null;
      const attachment = payload?.attachment && typeof payload.attachment.fileUrl === 'string'
        ? {
            fileName: String(payload.attachment.fileName || 'file'),
            mimeType: String(payload.attachment.mimeType || 'application/octet-stream'),
            sizeBytes: Number(payload.attachment.sizeBytes || 0),
            fileUrl: String(payload.attachment.fileUrl),
            isSticker: Boolean(payload.attachment.isSticker),
            packKey: payload.attachment.packKey ? String(payload.attachment.packKey) : null,
            storageKey: payload.attachment.storageKey ? String(payload.attachment.storageKey) : null,
            storageKind: payload.attachment.storageKind ? String(payload.attachment.storageKind) : (payload.attachment.isSticker ? 'sticker' : 'inline'),
            storageStatus: payload.attachment.storageStatus ? String(payload.attachment.storageStatus) : 'ready',
            uploadedAt: payload.attachment.uploadedAt ? String(payload.attachment.uploadedAt) : null,
          }
        : null;
      const replyToMessageId = payload?.replyToMessageId ? String(payload.replyToMessageId) : null;
      const replyQuote = typeof payload?.replyQuote === 'string' ? payload.replyQuote.trim().slice(0, 280) : '';
      const forwardedFrom = payload?.forwardedFrom && typeof payload.forwardedFrom.senderId === 'string' && typeof payload.forwardedFrom.senderName === 'string'
        ? {
            senderId: String(payload.forwardedFrom.senderId),
            senderName: String(payload.forwardedFrom.senderName).trim().slice(0, 80),
          }
        : null;
      const db = readDb();
      const targetGroup = groupContactId ? getGroupByContactId(db, groupContactId) : null;
      const recipient = db.users.find((user) => user.id === recipientId);
      const replyToMessage = replyToMessageId ? db.messages.find((entry) => entry.id === replyToMessageId) : null;

      if ((!content && kind === 'text') || (kind === 'voice' && !voice?.audioUrl) || (kind === 'file' && !attachment?.fileUrl)) {
        callback?.({ ok: false, error: 'Получатель не найден или сообщение пустое' });
        return;
      }

      if (groupContactId && (!targetGroup || !isGroupMember(targetGroup, currentUser.id))) {
        callback?.({ ok: false, error: 'Группа не найдена' });
        return;
      }

      if (!groupContactId && !recipient) {
        callback?.({ ok: false, error: 'Получатель не найден или сообщение пустое' });
        return;
      }

      const now = new Date().toISOString();
      const message = {
        id: randomUUID(),
        senderId: currentUser.id,
        senderName: currentUser.displayName || currentUser.username,
        recipientId: groupContactId || recipientId,
        groupId: targetGroup?.id || null,
        content: kind === 'voice' ? 'Голосовое сообщение' : kind === 'file' ? attachment.fileName : content,
        forwardedFrom,
        kind,
        voice,
        attachment,
        replyQuote: replyQuote || null,
        replyTo: buildReplyPreview(replyToMessage, replyQuote),
        status: 'sent',
        deliveredAt: null,
        readAt: null,
        createdAt: now,
        updatedAt: null,
        deletedAt: null,
        pinnedAt: null,
      };

      db.messages.push(message);
      await writeDb(db);
      if (targetGroup) {
        targetGroup.memberIds.forEach((memberId) => emitToUser(memberId, 'message:new', message));
      } else {
        emitToUser(recipientId, 'message:new', message);
        emitToUser(currentUser.id, 'message:new', message);
      }

      if (!targetGroup && !hasVisibleSocket(recipientId)) {
        await sendPushToUser(recipientId, {
          title: currentUser.displayName || currentUser.username,
          body: content.length > 120 ? `${content.slice(0, 117)}...` : content,
          tag: `message-${currentUser.id}`,
          vibrate: [120, 60, 120],
          url: `/dashboard/chat?contactId=${currentUser.id}`,
          data: {
            type: 'message',
            contactId: currentUser.id,
          },
        });
      }

      callback?.({ ok: true, message });
    });

    socket.on('message:delivered', async ({ messageIds }, callback) => {
      const deliveredIds = markMessagesDelivered(currentUser.id, messageIds);
      callback?.({ ok: true, messageIds: deliveredIds });
    });

    socket.on('message:edit', ({ messageId, content }, callback) => {
      const db = readDb();
      const message = db.messages.find((entry) => entry.id === String(messageId));
      const nextContent = String(content || '').trim();

      if (!message || message.senderId !== currentUser.id || message.deletedAt || message.kind === 'voice' || message.kind === 'call' || message.kind === 'file') {
        callback?.({ ok: false, error: 'Сообщение нельзя изменить' });
        return;
      }

      if (!nextContent) {
        callback?.({ ok: false, error: 'Пустое сообщение' });
        return;
      }

      message.content = nextContent;
      message.updatedAt = new Date().toISOString();
      writeDb(db);

      const payload = sanitizeMessage(message);
      if (message.groupId) {
        const group = db.groups.find((entry) => entry.id === message.groupId);
        group?.memberIds.forEach((memberId) => emitToUser(memberId, 'message:update', payload));
      } else {
        emitToUser(message.senderId, 'message:update', payload);
        emitToUser(message.recipientId, 'message:update', payload);
      }
      callback?.({ ok: true, message: payload });
    });

    socket.on('message:react', ({ messageId, emoji }, callback) => {
      const db = readDb();
      const message = db.messages.find((entry) => entry.id === String(messageId));
      const nextEmoji = String(emoji || '').trim();

      const canReactToGroup = message?.groupId
        ? isGroupMember(db.groups.find((group) => group.id === message.groupId), currentUser.id)
        : false;

      if (!message || !nextEmoji || message.deletedAt || (!canReactToGroup && message.senderId !== currentUser.id && message.recipientId !== currentUser.id)) {
        callback?.({ ok: false, error: 'Не удалось обновить реакцию' });
        return;
      }

      const reactions = Array.isArray(message.reactions) ? message.reactions : [];
      const existing = reactions.find((entry) => entry.emoji === nextEmoji);

      if (existing) {
        existing.userIds = existing.userIds.includes(currentUser.id)
          ? existing.userIds.filter((userId) => userId !== currentUser.id)
          : [...existing.userIds, currentUser.id];
      } else {
        reactions.push({ emoji: nextEmoji, userIds: [currentUser.id] });
      }

      message.reactions = reactions.filter((entry) => entry.userIds.length > 0);
      writeDb(db);

      const payload = sanitizeMessage(message);
      if (message.groupId) {
        const group = db.groups.find((entry) => entry.id === message.groupId);
        group?.memberIds.forEach((memberId) => emitToUser(memberId, 'message:update', payload));
      } else {
        emitToUser(message.senderId, 'message:update', payload);
        emitToUser(message.recipientId, 'message:update', payload);
      }
      callback?.({ ok: true, message: payload });
    });

    socket.on('message:delete', async ({ messageId }, callback) => {
      const db = readDb();
      const message = db.messages.find((entry) => entry.id === String(messageId));

      if (!message || message.senderId !== currentUser.id || message.deletedAt) {
        callback?.({ ok: false, error: 'Сообщение нельзя удалить' });
        return;
      }

      await deleteStoredMediaAttachment(message.attachment);
      message.deletedAt = new Date().toISOString();
      message.updatedAt = message.deletedAt;
      await writeDb(db);

      const payload = sanitizeMessage(message);
      if (message.groupId) {
        const group = db.groups.find((entry) => entry.id === message.groupId);
        group?.memberIds.forEach((memberId) => emitToUser(memberId, 'message:update', payload));
      } else {
        emitToUser(message.senderId, 'message:update', payload);
        emitToUser(message.recipientId, 'message:update', payload);
      }
      callback?.({ ok: true, message: payload });
    });

    socket.on('message:pin', async ({ messageId, pinned }, callback) => {
      const db = readDb();
      const message = db.messages.find((entry) => entry.id === String(messageId));

      if (!message || message.deletedAt || message.kind === 'call') {
        callback?.({ ok: false, error: 'Сообщение нельзя закрепить' });
        return;
      }

      const canPinDirect = message.senderId === currentUser.id || message.recipientId === currentUser.id;
      const canPinGroup = message.groupId
        ? isGroupMember(db.groups.find((group) => group.id === message.groupId), currentUser.id)
        : false;

      if (!canPinDirect && !canPinGroup) {
        callback?.({ ok: false, error: 'Нет доступа к сообщению' });
        return;
      }

      message.pinnedAt = pinned === false ? null : new Date().toISOString();
      message.updatedAt = new Date().toISOString();
      await writeDb(db);

      const payload = sanitizeMessage(message);
      if (message.groupId) {
        const group = db.groups.find((entry) => entry.id === message.groupId);
        group?.memberIds.forEach((memberId) => emitToUser(memberId, 'message:update', payload));
      } else {
        emitToUser(message.senderId, 'message:update', payload);
        emitToUser(message.recipientId, 'message:update', payload);
      }
      callback?.({ ok: true, message: payload });
    });

    socket.on('conversation:read', ({ contactId, messageIds }, callback) => {
      if (!contactId) {
        callback?.({ ok: false, messageIds: [] });
        return;
      }

      const readIds = markConversationRead(currentUser.id, String(contactId), messageIds);
      callback?.({ ok: true, messageIds: readIds });
    });

    socket.on('call:start', async (payload, callback) => {
      const toUserId = String(payload?.toUserId || '');
      const mode = payload?.mode === 'audio' ? 'audio' : 'video';
      const db = readDb();
      const recipient = db.users.find((user) => user.id === toUserId);
      const activePeerCall = [...activeCalls.values()].find(
        (call) =>
          (call.callerId === currentUser.id || call.recipientId === currentUser.id || call.callerId === toUserId || call.recipientId === toUserId) &&
          ['ringing', 'active'].includes(call.status),
      );

      if (!recipient || toUserId === currentUser.id) {
        callback?.({ ok: false, error: 'Неверный получатель звонка' });
        return;
      }

      if (activePeerCall) {
        callback?.({ ok: false, error: 'Один из участников уже находится в звонке' });
        return;
      }

      const call = {
        id: randomUUID(),
        callerId: currentUser.id,
        recipientId: toUserId,
        mode,
        status: 'ringing',
        startedAt: new Date().toISOString(),
        endedAt: null,
      };

      db.calls.push(call);
      await writeDb(db);
      activeCalls.set(call.id, call);
      emitIncomingCall(call, currentUser);
      scheduleRingTimeout(call.id);

      if (!hasVisibleSocket(toUserId)) {
        await sendPushToUser(toUserId, {
          title: mode === 'video' ? 'Видеозвонок' : 'Аудиозвонок',
          body: `${currentUser.displayName || currentUser.username} звонит вам. Нажмите, чтобы открыть чат.`,
          tag: `call-${call.id}`,
          requireInteraction: true,
          vibrate: [250, 150, 250, 150, 450],
          url: `/dashboard/chat?contactId=${currentUser.id}&incomingCallId=${call.id}&incomingCallMode=${mode}`,
          data: {
            type: 'call',
            callId: call.id,
            contactId: currentUser.id,
            mode,
          },
        });
      }

      callback?.({ ok: true, callId: call.id });
    });

    socket.on('call:accept', async ({ callId }) => {
      const db = readDb();
      const call = activeCalls.get(String(callId));
      const storedCall = db.calls.find((entry) => entry.id === callId);
      if (!call || !storedCall) {
        return;
      }

      clearRingTimeout(call.id);
      clearCallReconnectTimeout(call.id, call.callerId);
      clearCallReconnectTimeout(call.id, call.recipientId);
      call.status = 'active';
      storedCall.status = 'active';
      emitToUser(call.callerId, 'call:accepted', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:accepted', { callId, byUserId: currentUser.id });
      createCallLogMessage(db, { ...storedCall, status: 'accepted' }, currentUser.id);
      writeDb(db)
        .then(() => {
          const latestMessage = sanitizeMessage(db.messages[db.messages.length - 1]);
          emitToUser(call.callerId, 'message:new', latestMessage);
          emitToUser(call.recipientId, 'message:new', latestMessage);
        })
        .catch((error) => {
          console.error('Failed to persist accepted call log:', error);
        });
    });

    socket.on('call:reject', async ({ callId }) => {
      const db = readDb();
      const call = activeCalls.get(String(callId));
      const storedCall = db.calls.find((entry) => entry.id === callId);
      if (!call || !storedCall) {
        return;
      }

      clearRingTimeout(call.id);
      clearCallReconnectTimeout(call.id, call.callerId);
      clearCallReconnectTimeout(call.id, call.recipientId);
      call.status = 'rejected';
      storedCall.status = 'rejected';
      storedCall.endedAt = new Date().toISOString();
      call.endedAt = storedCall.endedAt;
      activeCalls.delete(callId);
      emitToUser(call.callerId, 'call:rejected', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:rejected', { callId, byUserId: currentUser.id });
      persistCallLog(db, storedCall, currentUser.id).catch((error) => {
        console.error('Failed to persist rejected call log:', error);
      });
    });

    socket.on('call:end', async ({ callId }) => {
      const db = readDb();
      const call = activeCalls.get(String(callId));
      const storedCall = db.calls.find((entry) => entry.id === callId);
      if (!call || !storedCall) {
        return;
      }

      clearRingTimeout(call.id);
      clearCallReconnectTimeout(call.id, call.callerId);
      clearCallReconnectTimeout(call.id, call.recipientId);
      call.status = 'ended';
      storedCall.status = 'ended';
      storedCall.endedAt = new Date().toISOString();
      call.endedAt = storedCall.endedAt;
      activeCalls.delete(callId);
      emitToUser(call.callerId, 'call:ended', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:ended', { callId, byUserId: currentUser.id });
      persistCallLog(db, storedCall, currentUser.id).catch((error) => {
        console.error('Failed to persist ended call log:', error);
      });
    });

    socket.on('call:connection-restored', ({ callId }, callback) => {
      const restored = restoreCallConnection(callId, currentUser.id);
      callback?.({ ok: restored });
    });

    socket.on('group-call:start', ({ groupId, mode }, callback) => {
      const db = readDb();
      const group = db.groups.find((entry) => entry.id === String(groupId || ''));

      if (!group || !isGroupMember(group, currentUser.id)) {
        callback?.({ ok: false, error: 'Группа не найдена' });
        return;
      }

      const room = groupCallStore.startRoom(group.id, mode === 'audio' ? 'audio' : 'video');
      emitToGroupMembers(group, 'group-call:incoming', {
        groupId: group.id,
        mode: room.mode,
        title: group.title,
        fromUser: publicUser(currentUser),
      }, currentUser.id);

      callback?.({
        ok: true,
        room: {
          groupId: group.id,
          mode: room.mode,
          title: group.title,
        },
      });
    });

    socket.on('group-call:join', ({ groupId }, callback) => {
      const db = readDb();
      const group = db.groups.find((entry) => entry.id === String(groupId || ''));

      if (!group || !isGroupMember(group, currentUser.id)) {
        callback?.({ ok: false, error: 'Группа не найдена' });
        return;
      }

      const room = groupCallStore.getRoom(group.id);
      if (!room) {
        callback?.({ ok: false, error: 'Групповой звонок уже завершен' });
        return;
      }

      const existingParticipants = groupCallStore
        .listParticipants(group.id)
        .filter((participant) => participant.userId !== currentUser.id)
        .map((participant) => {
          const member = db.users.find((user) => user.id === participant.userId);
          return member ? publicUser(member) : null;
        })
        .filter(Boolean);

      groupCallStore.upsertParticipant(group.id, {
        userId: currentUser.id,
        socketId: socket.id,
      });

      emitToGroupMembers(group, 'group-call:user-joined', {
        groupId: group.id,
        user: publicUser(currentUser),
      }, currentUser.id);

      callback?.({
        ok: true,
        room: {
          groupId: group.id,
          mode: room.mode,
          title: group.title,
          participants: existingParticipants,
        },
      });
    });

    socket.on('group-call:leave', ({ groupId }, callback) => {
      const db = readDb();
      const group = db.groups.find((entry) => entry.id === String(groupId || ''));
      if (!group) {
        callback?.({ ok: true });
        return;
      }

      const currentRoom = groupCallStore.getRoom(group.id);
      const room = groupCallStore.removeParticipant(group.id, currentUser.id);
      emitToGroupMembers(group, 'group-call:user-left', {
        groupId: group.id,
        userId: currentUser.id,
      }, currentUser.id);

      if (!room) {
        emitToGroupMembers(group, 'group-call:ended', { groupId: group.id });
        if (currentRoom) {
          persistGroupCallLog(db, group, currentRoom, currentUser.id).catch((error) => {
            console.error('Failed to persist group call log:', error);
          });
        }
      }

      callback?.({ ok: true });
    });

    socket.on('group-call:offer', ({ groupId, targetUserId, offer }) => {
      const room = groupCallStore.getRoom(String(groupId || ''));
      if (!room || !groupCallStore.hasParticipant(groupId, currentUser.id) || !groupCallStore.hasParticipant(groupId, targetUserId)) {
        return;
      }

      emitToUser(String(targetUserId), 'group-call:offer', {
        groupId: String(groupId),
        fromUserId: currentUser.id,
        offer,
      });
    });

    socket.on('group-call:answer', ({ groupId, targetUserId, answer }) => {
      const room = groupCallStore.getRoom(String(groupId || ''));
      if (!room || !groupCallStore.hasParticipant(groupId, currentUser.id) || !groupCallStore.hasParticipant(groupId, targetUserId)) {
        return;
      }

      emitToUser(String(targetUserId), 'group-call:answer', {
        groupId: String(groupId),
        fromUserId: currentUser.id,
        answer,
      });
    });

    socket.on('group-call:ice-candidate', ({ groupId, targetUserId, candidate }) => {
      const room = groupCallStore.getRoom(String(groupId || ''));
      if (!room || !groupCallStore.hasParticipant(groupId, currentUser.id) || !groupCallStore.hasParticipant(groupId, targetUserId)) {
        return;
      }

      emitToUser(String(targetUserId), 'group-call:ice-candidate', {
        groupId: String(groupId),
        fromUserId: currentUser.id,
        candidate,
      });
    });

    socket.on('webrtc:offer', ({ callId, offer }) => {
      const call = activeCalls.get(String(callId));
      if (!call) {
        return;
      }

      const targetUserId = currentUser.id === call.callerId ? call.recipientId : call.callerId;
      emitToUser(targetUserId, 'webrtc:offer', { callId: call.id, offer, fromUserId: currentUser.id });
    });

    socket.on('webrtc:answer', ({ callId, answer }) => {
      const call = activeCalls.get(String(callId));
      if (!call) {
        return;
      }

      const targetUserId = currentUser.id === call.callerId ? call.recipientId : call.callerId;
      emitToUser(targetUserId, 'webrtc:answer', { callId: call.id, answer, fromUserId: currentUser.id });
    });

    socket.on('webrtc:ice-candidate', ({ callId, candidate }) => {
      const call = activeCalls.get(String(callId));
      if (!call) {
        return;
      }

      const targetUserId = currentUser.id === call.callerId ? call.recipientId : call.callerId;
      emitToUser(targetUserId, 'webrtc:ice-candidate', {
        callId: call.id,
        candidate,
        fromUserId: currentUser.id,
      });
    });

    socket.on('disconnect', () => {
      const db = readDb();
      db.groups
        .filter((group) => groupCallStore.hasParticipant(group.id, currentUser.id))
        .forEach((group) => {
          const currentRoom = groupCallStore.getRoom(group.id);
          const room = groupCallStore.removeParticipant(group.id, currentUser.id);
          emitToGroupMembers(group, 'group-call:user-left', {
            groupId: group.id,
            userId: currentUser.id,
          }, currentUser.id);

          if (!room) {
            emitToGroupMembers(group, 'group-call:ended', { groupId: group.id });
            if (currentRoom) {
              persistGroupCallLog(db, group, currentRoom, currentUser.id).catch((error) => {
                console.error('Failed to persist disconnected group call log:', error);
              });
            }
          }
        });

      removeUserSocket(currentUser.id, socket.id);
      [...activeCalls.values()]
        .filter((call) => ['ringing', 'active'].includes(call.status) && (call.callerId === currentUser.id || call.recipientId === currentUser.id))
        .forEach((call) => {
          if (isUserOnline(currentUser.id)) {
            return;
          }

          emitToUser(getCallPeerId(call, currentUser.id), 'call:peer-reconnecting', {
            callId: call.id,
            userId: currentUser.id,
            graceMs: CALL_RECONNECT_GRACE_MS,
          });
          scheduleCallReconnectTimeout(call, currentUser.id);
        });

      if (!isUserOnline(currentUser.id)) {
        const db = readDb();
        const user = db.users.find((entry) => entry.id === currentUser.id);
        if (user) {
          user.lastSeenAt = new Date().toISOString();
          writeDb(db);
        }
      }
      broadcastPresence(currentUser.id);
    });
  });

  server
    .once('error', (error) => {
      console.error(error);
      process.exit(1);
    })
    .listen(port, hostname, () => {
      if (JWT_SECRET === 'altmess-dev-secret-change-me') {
        console.warn('Using default JWT secret. Set JWT_SECRET in production.');
      }

      if (DATABASE_URL) {
        console.log('Using external Postgres persistence');
      }

      console.log(`> Ready on http://${hostname}:${port}`);
    });
});
