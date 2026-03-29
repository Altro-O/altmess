# Altmess

PWA-first realtime messenger for private communication between browsers and mobile devices.

## Progress

`[███████████████████░░░░░░░] 70%`

- `Core messaging` - done
- `Media storage on VPS` - done
- `Profile avatars and crop` - done
- `Sticker / emoji UX` - done
- `PWA and mobile polish` - mostly done
- `One-to-one call stability` - in progress
- `Group chats` - planned
- `Group calls` - planned

## What it already does

- registration and login
- one-to-one realtime chat
- sent / delivered / read states
- replies, quoting, reactions, emoji, stickers
- voice messages
- file and image sharing
- multi-upload with progress
- desktop drag/drop uploads
- grouped media gallery in dialogs
- pinned chats and drafts
- profile editing with avatar upload / crop / delete
- audio and video calls
- push notifications for messages and calls
- mobile action sheets and PWA-friendly chat flow

## Stack

- Next.js 14
- React 18
- TypeScript
- Node.js custom server
- Socket.IO
- Neon Postgres
- self-hosted coturn
- VPS media storage

## Runtime architecture

- `Render` hosts the main application
- `Neon` stores app state and metadata
- `VPS` stores uploaded media and hosts:
  - `coturn`
  - media upload service
  - nightly media cleanup timer

## Current URLs

- app: `https://altmess.onrender.com`
- media: `https://media.85.117.235.136.sslip.io`

## Local development

```bash
npm install
npm run dev
```

Production-like run:

```bash
npm run build
npm start
```

## Important env vars

```env
JWT_SECRET=change-me
DATABASE_URL=postgres://...

TURN_URLS=turn:your-turn-server:3478?transport=udp,turn:your-turn-server:3478?transport=tcp
TURN_USERNAME=your-turn-user
TURN_CREDENTIAL=your-turn-password

MEDIA_UPSTREAM_URL=https://media.example.com
MEDIA_UPSTREAM_TOKEN=change-me
MEDIA_PUBLIC_BASE_URL=https://media.example.com
```

## Media cleanup policy

Current VPS cleanup policy:

- soft limit: `6.5 GB`
- hard limit: `7 GB`
- minimum free disk reserve: `512 MB`
- nightly cleanup timer removes orphaned files first, then expires oldest attachments if needed

Expired files are shown in chat as placeholders instead of broken links.

## Current priorities

1. Multi-select messages and forwarding
2. Server-side pinned chats
3. Better one-to-one call fallback under weak network
4. Group chats
5. Group call architecture

## Repo notes

- active handoff: `project.md`
- current task list: `task.md`
- deploy notes: `DEPLOYMENT.md`

## Screenshots / presentation ideas

Good GitHub follow-up improvements later:

- add screenshots or GIFs for desktop/mobile chat
- add small architecture diagram
- add feature matrix for `done / in progress / planned`
