# Altmess

Realtime веб-мессенджер с общими аккаунтами, синхронизацией между браузерами и устройствами, delivery/read статусами и WebRTC звонками.

## Что умеет

- регистрация и логин через общий сервер
- список диалогов и поиск пользователей
- сообщения в realtime между разными устройствами
- delivery/read статусы
- presence / online статус
- аудио- и видеозвонки через WebRTC signaling

## Стек

- Next.js 14
- React 18
- TypeScript
- Node.js custom server
- Socket.IO
- SQLite

## Локальный запуск

```bash
npm install
npm run dev
```

Или production-like режим:

```bash
npm run build
npm start
```

## Env

```env
JWT_SECRET=change-me-in-production
DATABASE_PATH=server/data/altmess.sqlite

# Для стабильных звонков в реальных сетях
TURN_URL=turn:your-turn-server:3478
TURN_USERNAME=your-turn-username
TURN_CREDENTIAL=your-turn-password
```

## Основные API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/dialogs`
- `GET /api/users/search?q=<query>`
- `GET /api/messages?contactId=<id>`
- `POST /api/messages/read`

## Деплой

- Render: `render.yaml`
- Railway: `railway.json`

Подробности в `DEPLOYMENT.md`.
