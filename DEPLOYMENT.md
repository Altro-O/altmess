# Деплой Altmess

## Что уже готово

- общие аккаунты, диалоги и сообщения для всех устройств на одном сервере
- realtime delivery/read статусы и presence
- аудио/видеозвонки через WebRTC signaling
- серверное хранение в SQLite

## Обязательные env

```env
JWT_SECRET=change-me-in-production
DATABASE_PATH=/var/data/altmess.sqlite
```

## Рекомендуемые env для звонков

```env
TURN_URL=turn:your-turn-server:3478
TURN_USERNAME=your-turn-username
TURN_CREDENTIAL=your-turn-password
```

Без TURN у части пользователей звонки могут не проходить в мобильных сетях, CGNAT и корпоративных сетях.

## Куда деплоить

Лучшие варианты для текущей архитектуры:

- Render
- Railway
- Fly.io
- VPS / Docker / PM2

Vercel не подходит как основной вариант, потому что тут нужен постоянный Node.js процесс и Socket.IO.

## Render

В репозитории уже есть `render.yaml`.

Что важно:

- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Persistent Disk: обязателен, иначе база SQLite потеряется после redeploy
- Disk mount path: `/var/data`

После создания сервиса:

1. подключи репозиторий
2. подтверди `render.yaml`
3. добавь TURN env, если нужны стабильные звонки
4. дождись первого деплоя

## Railway

В репозитории уже есть `railway.json`.

Минимум нужно:

- `JWT_SECRET`
- volume или другой persist layer для `DATABASE_PATH`

Если volume нет, история может сбрасываться после перевыкатки.

## Локальная проверка перед деплоем

```bash
npm install
npm run build
npm start
```

Открой приложение в двух браузерах или в обычном + инкогнито:

1. зарегистрируй двух пользователей
2. открой диалог
3. проверь отправку сообщений
4. проверь unread/read
5. проверь аудио- и видеозвонок

## Ограничения текущей production-like версии

- это single-node приложение
- SQLite хорошо подходит для MVP и первых пользователей, но не для горизонтального масштабирования
- для нескольких инстансов понадобится Postgres/MySQL и отдельный realtime state

## Следующий production-этап

1. вынести данные в Postgres
2. добавить Redis для realtime state
3. перейти на httpOnly cookie session
4. добавить push/email notifications
5. добавить вложения и медиа-хранилище
