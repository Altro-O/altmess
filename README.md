# Altmess

PWA-first realtime messenger for private communication between browsers and mobile devices.

## Status

`[███████████████████░░░░░░░] 70%`

| Area | Status |
| --- | --- |
| Core messaging | Done |
| Media uploads and VPS storage | Done |
| Profile avatars and crop | Done |
| Stickers / emoji UX | Done |
| PWA and mobile UX | Mostly done |
| One-to-one call resilience | In progress |
| Group chats | Planned |
| Group calls | Planned |

## Highlights

- realtime one-to-one chat
- sent / delivered / read states
- replies, quoting, reactions, emoji, stickers
- voice messages and file sharing
- multi-upload with progress
- desktop drag/drop uploads
- grouped media gallery inside dialogs
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
- self-hosted TURN
- external media storage service

## Architecture Overview

- `Render` hosts the main application
- `Neon` stores app state and metadata
- separate infrastructure is used for TURN and uploaded media storage

## Public App

- `https://altmess.onrender.com`

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

## Example env

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

## Media retention

Uploaded media is cleaned by a scheduled retention policy.

- orphaned files are removed first
- old attachments can be expired when storage pressure grows
- expired files are shown in chat as placeholders instead of broken links

## Current priorities

1. Multi-select messages and forwarding
2. Server-side pinned chats
3. Better one-to-one call fallback under weak network
4. Group chats
5. Group call architecture

## Roadmap snapshot

### Done
- realtime chat foundation
- replies / quotes / reactions / voice messages
- VPS-backed uploads and cleanup flow
- avatar upload and crop flow
- grouped gallery and media navigation
- sticker packs with frequent ordering

### In progress
- one-to-one call resilience on weak mobile networks
- mobile and PWA polish

### Planned
- multi-select and forwarding
- server-side pinned chats
- group chats
- group call architecture

## Repository notes

- public handoff summary: `project.md`
- current task list: `task.md`
- deploy notes: `DEPLOYMENT.md`

## Presentation follow-ups

- add screenshots or GIFs for desktop/mobile chat
- add a small architecture diagram
- add a visual feature roadmap block
