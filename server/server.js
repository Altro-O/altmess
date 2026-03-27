const http = require('http');
const express = require('express');
const next = require('next');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const { loadState, saveState, getState, DATABASE_URL } = require('./persistence');

const lifecycle = process.env.npm_lifecycle_event;
const dev = process.env.NODE_ENV !== 'production' && lifecycle !== 'start';
const hostname = '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const JWT_SECRET = process.env.JWT_SECRET || 'altmess-dev-secret-change-me';
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
];

function readDb() {
  return getState();
}

async function writeDb(data) {
  try {
    await saveState(data);
  } catch (error) {
    console.error('Failed to persist state:', error);
  }
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
    avatarColor: user.avatarColor || 'ocean',
    lastSeenAt: user.lastSeenAt || null,
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
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

function getIceServers() {
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (!turnUrl || !turnUsername || !turnCredential) {
    return DEFAULT_ICE_SERVERS;
  }

  return [
    ...DEFAULT_ICE_SERVERS,
    {
      urls: [turnUrl],
      username: turnUsername,
      credential: turnCredential,
    },
  ];
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

function sanitizeMessage(message) {
  if (!message.deletedAt) {
    return message;
  }

  return {
    ...message,
    content: 'Сообщение удалено',
  };
}

app.prepare().then(async () => {
  await loadState();

  const expressApp = express();
  const server = http.createServer(expressApp);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });
  const activeUsers = new Map();
  const activeCalls = new Map();

  function isUserOnline(userId) {
    return activeUsers.has(userId);
  }

  function setUserSocket(userId, socketId) {
    const sockets = activeUsers.get(userId) || new Set();
    sockets.add(socketId);
    activeUsers.set(userId, sockets);
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
    return buildContactList(currentUserId).filter((contact) => contact.lastMessage || contact.unreadCount > 0);
  }

  function markConversationDelivered(userId) {
    const db = readDb();
    const now = new Date().toISOString();
    let changed = false;

    db.messages.forEach((message) => {
      if (message.recipientId === userId && !message.deliveredAt) {
        message.deliveredAt = now;
        message.status = message.readAt ? 'read' : 'delivered';
        changed = true;
        emitToUser(message.senderId, 'message:status', {
          id: message.id,
          status: message.status,
          deliveredAt: message.deliveredAt,
          readAt: message.readAt,
        });
      }
    });

    if (changed) {
      writeDb(db);
    }
  }

  function markConversationRead(currentUserId, contactId) {
    const db = readDb();
    const now = new Date().toISOString();
    const changedIds = [];

    db.messages.forEach((message) => {
      if (message.senderId === contactId && message.recipientId === currentUserId && !message.readAt) {
        message.deliveredAt = message.deliveredAt || now;
        message.readAt = now;
        message.status = 'read';
        changedIds.push(message.id);
        emitToUser(message.senderId, 'message:status', {
          id: message.id,
          status: 'read',
          deliveredAt: message.deliveredAt,
          readAt: message.readAt,
        });
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
      lastSeenAt: null,
    };

    db.users.push(user);
    writeDb(db);

    res.status(201).json({ token: createToken(user), user: publicUser(user), iceServers: getIceServers() });
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

    res.json({ token: createToken(user), user: publicUser(user), iceServers: getIceServers() });
  });

  expressApp.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ user: req.user, iceServers: getIceServers() });
  });

  expressApp.patch('/api/profile', authMiddleware, (req, res) => {
    const db = readDb();
    const user = db.users.find((entry) => entry.id === req.user.id);

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    const nextDisplayName = String(req.body?.displayName || user.displayName || user.username).trim();
    const nextBio = String(req.body?.bio || '').trim();
    const nextAvatarUrl = String(req.body?.avatarUrl || '').trim();
    const nextAvatarColor = String(req.body?.avatarColor || user.avatarColor || 'ocean');

    user.displayName = nextDisplayName.slice(0, 32) || user.username;
    user.bio = nextBio.slice(0, 90);
    user.avatarUrl = nextAvatarUrl.slice(0, 500);
    user.avatarColor = ['ocean', 'mint', 'sunset', 'berry', 'slate'].includes(nextAvatarColor)
      ? nextAvatarColor
      : 'ocean';

    writeDb(db);
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

  expressApp.get('/api/messages', authMiddleware, (req, res) => {
    const contactId = String(req.query.contactId || '');
    if (!contactId) {
      res.status(400).json({ error: 'Не указан contactId' });
      return;
    }

    markConversationRead(req.user.id, contactId);
    const db = readDb();
    res.json({ messages: getConversationMessages(db, req.user.id, contactId).map(sanitizeMessage) });
  });

  expressApp.post('/api/messages/read', authMiddleware, (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!contactId) {
      res.status(400).json({ error: 'Не указан contactId' });
      return;
    }

    res.json({ ok: true, messageIds: markConversationRead(req.user.id, contactId) });
  });

  expressApp.get('/api/rtc/config', authMiddleware, (req, res) => {
    res.json({ iceServers: getIceServers() });
  });

  expressApp.all('*', (req, res) => handle(req, res));

  io.use((socket, nextSocket) => {
    const token = socket.handshake.auth?.token;
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
    setUserSocket(currentUser.id, socket.id);
    socket.emit('presence:sync', buildPresencePayload(currentUser.id));
    markConversationDelivered(currentUser.id);
    broadcastPresence(currentUser.id);

    socket.on('message:send', (payload, callback) => {
      const content = String(payload?.content || '').trim();
      const recipientId = String(payload?.recipientId || '');
      const db = readDb();
      const recipient = db.users.find((user) => user.id === recipientId);

      if (!content || !recipient) {
        callback?.({ ok: false, error: 'Получатель не найден или сообщение пустое' });
        return;
      }

      const now = new Date().toISOString();
      const message = {
        id: randomUUID(),
        senderId: currentUser.id,
        recipientId,
        content,
        status: isUserOnline(recipientId) ? 'delivered' : 'sent',
        deliveredAt: isUserOnline(recipientId) ? now : null,
        readAt: null,
        createdAt: now,
        updatedAt: null,
        deletedAt: null,
      };

      db.messages.push(message);
      writeDb(db);
      emitToUser(recipientId, 'message:new', message);
      emitToUser(currentUser.id, 'message:new', message);
      callback?.({ ok: true, message });
    });

    socket.on('message:edit', ({ messageId, content }, callback) => {
      const db = readDb();
      const message = db.messages.find((entry) => entry.id === String(messageId));
      const nextContent = String(content || '').trim();

      if (!message || message.senderId !== currentUser.id || message.deletedAt) {
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
      emitToUser(message.senderId, 'message:update', payload);
      emitToUser(message.recipientId, 'message:update', payload);
      callback?.({ ok: true, message: payload });
    });

    socket.on('message:delete', ({ messageId }, callback) => {
      const db = readDb();
      const message = db.messages.find((entry) => entry.id === String(messageId));

      if (!message || message.senderId !== currentUser.id || message.deletedAt) {
        callback?.({ ok: false, error: 'Сообщение нельзя удалить' });
        return;
      }

      message.deletedAt = new Date().toISOString();
      message.updatedAt = message.deletedAt;
      writeDb(db);

      const payload = sanitizeMessage(message);
      emitToUser(message.senderId, 'message:update', payload);
      emitToUser(message.recipientId, 'message:update', payload);
      callback?.({ ok: true, message: payload });
    });

    socket.on('conversation:read', ({ contactId }) => {
      if (contactId) {
        markConversationRead(currentUser.id, String(contactId));
      }
    });

    socket.on('call:start', (payload, callback) => {
      const toUserId = String(payload?.toUserId || '');
      const mode = payload?.mode === 'audio' ? 'audio' : 'video';
      const db = readDb();
      const recipient = db.users.find((user) => user.id === toUserId);

      if (!recipient || toUserId === currentUser.id) {
        callback?.({ ok: false, error: 'Неверный получатель звонка' });
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
      writeDb(db);
      activeCalls.set(call.id, call);
      emitToUser(toUserId, 'call:incoming', {
        callId: call.id,
        mode,
        fromUser: currentUser,
      });
      callback?.({ ok: true, callId: call.id });
    });

    socket.on('call:accept', ({ callId }) => {
      const db = readDb();
      const call = activeCalls.get(String(callId));
      const storedCall = db.calls.find((entry) => entry.id === callId);
      if (!call || !storedCall) {
        return;
      }

      call.status = 'active';
      storedCall.status = 'active';
      writeDb(db);
      emitToUser(call.callerId, 'call:accepted', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:accepted', { callId, byUserId: currentUser.id });
    });

    socket.on('call:reject', ({ callId }) => {
      const db = readDb();
      const call = activeCalls.get(String(callId));
      const storedCall = db.calls.find((entry) => entry.id === callId);
      if (!call || !storedCall) {
        return;
      }

      call.status = 'rejected';
      storedCall.status = 'rejected';
      storedCall.endedAt = new Date().toISOString();
      writeDb(db);
      activeCalls.delete(callId);
      emitToUser(call.callerId, 'call:rejected', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:rejected', { callId, byUserId: currentUser.id });
    });

    socket.on('call:end', ({ callId }) => {
      const db = readDb();
      const call = activeCalls.get(String(callId));
      const storedCall = db.calls.find((entry) => entry.id === callId);
      if (!call || !storedCall) {
        return;
      }

      call.status = 'ended';
      storedCall.status = 'ended';
      storedCall.endedAt = new Date().toISOString();
      writeDb(db);
      activeCalls.delete(callId);
      emitToUser(call.callerId, 'call:ended', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:ended', { callId, byUserId: currentUser.id });
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
      removeUserSocket(currentUser.id, socket.id);
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
