const http = require('http');
const express = require('express');
const next = require('next');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const { initDatabase } = require('./database');

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

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.created_at,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    status: row.status,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    createdAt: row.created_at,
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

app.prepare().then(async () => {
  const db = await initDatabase();
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

  async function authMiddleware(req, res, nextMiddleware) {
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

    const user = await db.get('SELECT * FROM users WHERE id = ?', payload.userId);
    if (!user) {
      res.status(401).json({ error: 'Пользователь не найден' });
      return;
    }

    req.user = publicUser(user);
    nextMiddleware();
  }

  async function buildPresencePayload(currentUserId) {
    const users = await db.all('SELECT id FROM users WHERE id <> ?', currentUserId);
    return users.map((user) => ({
      id: user.id,
      online: isUserOnline(user.id),
    }));
  }

  async function broadcastPresence(userId) {
    const users = await db.all('SELECT id FROM users WHERE id <> ?', userId);
    const payload = { id: userId, online: isUserOnline(userId) };
    users.forEach((user) => emitToUser(user.id, 'presence:update', payload));
  }

  async function buildContactList(currentUserId, searchQuery = '') {
    const query = normalizeQuery(searchQuery);
    const users = query
      ? await db.all(
          `SELECT * FROM users
           WHERE id <> ? AND (LOWER(username) LIKE ? OR LOWER(email) LIKE ?)
           ORDER BY username ASC`,
          currentUserId,
          `%${query}%`,
          `%${query}%`,
        )
      : await db.all('SELECT * FROM users WHERE id <> ? ORDER BY username ASC', currentUserId);

    const contacts = [];

    for (const user of users) {
      const lastMessage = await db.get(
        `SELECT * FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC
         LIMIT 1`,
        currentUserId,
        user.id,
        user.id,
        currentUserId,
      );

      const unreadRow = await db.get(
        `SELECT COUNT(*) AS unreadCount
         FROM messages
         WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
        user.id,
        currentUserId,
      );

      contacts.push({
        ...publicUser(user),
        online: isUserOnline(user.id),
        lastMessage: lastMessage ? mapMessage(lastMessage) : null,
        unreadCount: unreadRow?.unreadCount || 0,
      });
    }

    contacts.sort((first, second) => {
      const firstTime = first.lastMessage?.createdAt || first.createdAt || '';
      const secondTime = second.lastMessage?.createdAt || second.createdAt || '';
      return secondTime.localeCompare(firstTime);
    });

    return contacts;
  }

  async function buildDialogs(currentUserId) {
    const contacts = await buildContactList(currentUserId);
    return contacts.filter((contact) => contact.lastMessage || contact.unreadCount > 0);
  }

  async function markConversationDelivered(userId) {
    const now = new Date().toISOString();
    const pending = await db.all(
      `SELECT * FROM messages
       WHERE recipient_id = ? AND delivered_at IS NULL`,
      userId,
    );

    if (pending.length === 0) {
      return;
    }

    await db.run(
      `UPDATE messages
       SET status = CASE WHEN read_at IS NULL THEN 'delivered' ELSE 'read' END,
           delivered_at = COALESCE(delivered_at, ?)
       WHERE recipient_id = ? AND delivered_at IS NULL`,
      now,
      userId,
    );

    pending.forEach((message) => {
      emitToUser(message.sender_id, 'message:status', {
        id: message.id,
        status: 'delivered',
        deliveredAt: now,
        readAt: message.read_at,
      });
    });
  }

  async function markConversationRead(currentUserId, contactId) {
    const now = new Date().toISOString();
    const unread = await db.all(
      `SELECT * FROM messages
       WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
      contactId,
      currentUserId,
    );

    if (unread.length === 0) {
      return [];
    }

    await db.run(
      `UPDATE messages
       SET status = 'read',
           delivered_at = COALESCE(delivered_at, ?),
           read_at = ?
       WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
      now,
      now,
      contactId,
      currentUserId,
    );

    unread.forEach((message) => {
      emitToUser(message.sender_id, 'message:status', {
        id: message.id,
        status: 'read',
        deliveredAt: message.delivered_at || now,
        readAt: now,
      });
    });

    return unread.map((message) => message.id);
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

    const usernameTaken = await db.get(
      'SELECT id FROM users WHERE LOWER(username) = ?',
      trimmedUsername.toLowerCase(),
    );
    const emailTaken = await db.get('SELECT id FROM users WHERE LOWER(email) = ?', trimmedEmail);

    if (usernameTaken) {
      res.status(409).json({ error: 'Имя пользователя уже занято' });
      return;
    }

    if (emailTaken) {
      res.status(409).json({ error: 'Email уже используется' });
      return;
    }

    const user = {
      id: randomUUID(),
      username: trimmedUsername,
      email: trimmedEmail,
      passwordHash: await bcrypt.hash(String(password), 10),
      createdAt: new Date().toISOString(),
    };

    await db.run(
      'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      user.id,
      user.username,
      user.email,
      user.passwordHash,
      user.createdAt,
    );

    res.status(201).json({ token: createToken(user), user: publicUser({ ...user, created_at: user.createdAt }), iceServers: getIceServers() });
  });

  expressApp.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
      return;
    }

    const loginValue = normalizeQuery(username);
    const user = await db.get(
      'SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?',
      loginValue,
      loginValue,
    );

    if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
      res.status(401).json({ error: 'Неверный логин или пароль' });
      return;
    }

    res.json({ token: createToken(user), user: publicUser(user), iceServers: getIceServers() });
  });

  expressApp.get('/api/auth/me', authMiddleware, async (req, res) => {
    res.json({ user: req.user, iceServers: getIceServers() });
  });

  expressApp.get('/api/users/search', authMiddleware, async (req, res) => {
    const users = await buildContactList(req.user.id, req.query.q || '');
    res.json({ users });
  });

  expressApp.get('/api/users/contacts', authMiddleware, async (req, res) => {
    const contacts = await buildContactList(req.user.id, req.query.q || '');
    res.json({ contacts });
  });

  expressApp.get('/api/dialogs', authMiddleware, async (req, res) => {
    const dialogs = await buildDialogs(req.user.id);
    res.json({ dialogs });
  });

  expressApp.get('/api/messages', authMiddleware, async (req, res) => {
    const contactId = String(req.query.contactId || '');
    if (!contactId) {
      res.status(400).json({ error: 'Не указан contactId' });
      return;
    }

    const messages = await db.all(
      `SELECT * FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC`,
      req.user.id,
      contactId,
      contactId,
      req.user.id,
    );

    await markConversationRead(req.user.id, contactId);
    const refreshed = await db.all(
      `SELECT * FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC`,
      req.user.id,
      contactId,
      contactId,
      req.user.id,
    );

    res.json({ messages: refreshed.map(mapMessage) });
  });

  expressApp.post('/api/messages/read', authMiddleware, async (req, res) => {
    const contactId = String(req.body?.contactId || '');
    if (!contactId) {
      res.status(400).json({ error: 'Не указан contactId' });
      return;
    }

    const messageIds = await markConversationRead(req.user.id, contactId);
    res.json({ ok: true, messageIds });
  });

  expressApp.get('/api/rtc/config', authMiddleware, async (req, res) => {
    res.json({ iceServers: getIceServers() });
  });

  expressApp.all('*', (req, res) => handle(req, res));

  io.use(async (socket, nextSocket) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      nextSocket(new Error('unauthorized'));
      return;
    }

    const payload = verifyToken(token);
    if (!payload) {
      nextSocket(new Error('unauthorized'));
      return;
    }

    const user = await db.get('SELECT * FROM users WHERE id = ?', payload.userId);
    if (!user) {
      nextSocket(new Error('unauthorized'));
      return;
    }

    socket.data.user = publicUser(user);
    nextSocket();
  });

  io.on('connection', async (socket) => {
    const currentUser = socket.data.user;
    setUserSocket(currentUser.id, socket.id);
    socket.emit('presence:sync', await buildPresencePayload(currentUser.id));
    await markConversationDelivered(currentUser.id);
    await broadcastPresence(currentUser.id);

    socket.on('message:send', async (payload, callback) => {
      const content = String(payload?.content || '').trim();
      const recipientId = String(payload?.recipientId || '');

      if (!content || !recipientId) {
        callback?.({ ok: false, error: 'Сообщение или получатель не указаны' });
        return;
      }

      const recipient = await db.get('SELECT * FROM users WHERE id = ?', recipientId);
      if (!recipient) {
        callback?.({ ok: false, error: 'Получатель не найден' });
        return;
      }

      const now = new Date().toISOString();
      const online = isUserOnline(recipientId);
      const message = {
        id: randomUUID(),
        senderId: currentUser.id,
        recipientId,
        content,
        status: online ? 'delivered' : 'sent',
        deliveredAt: online ? now : null,
        readAt: null,
        createdAt: now,
      };

      await db.run(
        `INSERT INTO messages (
          id, sender_id, recipient_id, content, status, delivered_at, read_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.senderId,
        message.recipientId,
        message.content,
        message.status,
        message.deliveredAt,
        message.readAt,
        message.createdAt,
      );

      emitToUser(recipientId, 'message:new', message);
      emitToUser(currentUser.id, 'message:new', message);
      callback?.({ ok: true, message });
    });

    socket.on('conversation:read', async (payload) => {
      const contactId = String(payload?.contactId || '');
      if (!contactId) {
        return;
      }

      await markConversationRead(currentUser.id, contactId);
    });

    socket.on('call:start', async (payload, callback) => {
      const toUserId = String(payload?.toUserId || '');
      const mode = payload?.mode === 'audio' ? 'audio' : 'video';

      if (!toUserId || toUserId === currentUser.id) {
        callback?.({ ok: false, error: 'Неверный получатель звонка' });
        return;
      }

      const recipient = await db.get('SELECT * FROM users WHERE id = ?', toUserId);
      if (!recipient) {
        callback?.({ ok: false, error: 'Пользователь не найден' });
        return;
      }

      const callId = randomUUID();
      const startedAt = new Date().toISOString();
      const call = {
        id: callId,
        callerId: currentUser.id,
        recipientId: toUserId,
        mode,
        status: 'ringing',
        startedAt,
      };

      activeCalls.set(callId, call);
      await db.run(
        'INSERT INTO calls (id, caller_id, recipient_id, mode, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        call.id,
        call.callerId,
        call.recipientId,
        call.mode,
        call.status,
        call.startedAt,
      );

      emitToUser(toUserId, 'call:incoming', {
        callId,
        mode,
        fromUser: currentUser,
      });
      callback?.({ ok: true, callId });
    });

    socket.on('call:accept', async (payload) => {
      const callId = String(payload?.callId || '');
      const call = activeCalls.get(callId);
      if (!call || call.recipientId !== currentUser.id) {
        return;
      }

      call.status = 'active';
      await db.run('UPDATE calls SET status = ? WHERE id = ?', 'active', callId);
      emitToUser(call.callerId, 'call:accepted', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:accepted', { callId, byUserId: currentUser.id });
    });

    socket.on('call:reject', async (payload) => {
      const callId = String(payload?.callId || '');
      const call = activeCalls.get(callId);
      if (!call) {
        return;
      }

      activeCalls.delete(callId);
      await db.run('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?', 'rejected', new Date().toISOString(), callId);
      emitToUser(call.callerId, 'call:rejected', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:rejected', { callId, byUserId: currentUser.id });
    });

    socket.on('call:end', async (payload) => {
      const callId = String(payload?.callId || '');
      const call = activeCalls.get(callId);
      if (!call) {
        return;
      }

      activeCalls.delete(callId);
      await db.run('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?', 'ended', new Date().toISOString(), callId);
      emitToUser(call.callerId, 'call:ended', { callId, byUserId: currentUser.id });
      emitToUser(call.recipientId, 'call:ended', { callId, byUserId: currentUser.id });
    });

    socket.on('webrtc:offer', (payload) => {
      const call = activeCalls.get(String(payload?.callId || ''));
      if (!call) {
        return;
      }

      const targetUserId = currentUser.id === call.callerId ? call.recipientId : call.callerId;
      emitToUser(targetUserId, 'webrtc:offer', {
        callId: call.id,
        offer: payload.offer,
        fromUserId: currentUser.id,
      });
    });

    socket.on('webrtc:answer', (payload) => {
      const call = activeCalls.get(String(payload?.callId || ''));
      if (!call) {
        return;
      }

      const targetUserId = currentUser.id === call.callerId ? call.recipientId : call.callerId;
      emitToUser(targetUserId, 'webrtc:answer', {
        callId: call.id,
        answer: payload.answer,
        fromUserId: currentUser.id,
      });
    });

    socket.on('webrtc:ice-candidate', (payload) => {
      const call = activeCalls.get(String(payload?.callId || ''));
      if (!call) {
        return;
      }

      const targetUserId = currentUser.id === call.callerId ? call.recipientId : call.callerId;
      emitToUser(targetUserId, 'webrtc:ice-candidate', {
        callId: call.id,
        candidate: payload.candidate,
        fromUserId: currentUser.id,
      });
    });

    socket.on('disconnect', async () => {
      removeUserSocket(currentUser.id, socket.id);
      await broadcastPresence(currentUser.id);
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

      console.log(`> Ready on http://${hostname}:${port}`);
    });
});
