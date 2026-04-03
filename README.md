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

## Feature Matrix

| Feature | Status | Notes |
| --- | --- | --- |
| One-to-one chat | Done | Realtime messaging between devices via Socket.IO |
| Message states | Done | Sent / delivered / read |
| Replies and quoting | Done | Includes quote selection flow on mobile |
| Reactions and emoji | Done | Frequent emoji rise to the top |
| Stickers | Done | Web-friendly local packs with frequent ordering |
| Voice messages | Done | Inline recording and playback |
| File and image sharing | Done | VPS-backed uploads, multi-upload, progress, drag/drop |
| Media gallery | Done | Grouped gallery in dialog profile with jump-to-message |
| Profile avatars | Done | Upload, crop, replace, delete, VPS cleanup |
| Push notifications | Done | Messages and calls |
| One-to-one calls | In progress | Significantly more resilient, still limited by mobile web platform rules |
| PWA polish | In progress | Mobile UX is strong, but background iPhone behavior remains platform-limited |
| Server-side pinned chats | Planned | Current pinned state is local to browser/PWA |
| Multi-select and forwarding | Planned | Next major productivity block |
| Group chats | Planned | Logical next communication feature |
| Group calls | Planned | Will require a larger architecture step |

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

```text
                +----------------------+
                |      User Device     |
                |  PWA / Browser UI    |
                +----------+-----------+
                           |
                           v
                +----------------------+
                |        Render        |
                | Next.js + Socket.IO  |
                +----+-------------+---+
                     |             |
                     |             |
                     v             v
          +----------------+   +----------------+
          |      Neon      |   |   VPS Media    |
          | app state/meta |   | uploads/files  |
          +----------------+   +----------------+
                                  |
                                  v
                           +-------------+
                           |   coturn    |
                           | WebRTC TURN |
                           +-------------+
```

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

STICKERS_MANIFEST_URL=https://cdn.jsdelivr.net/gh/Altro-O/altmess-stickers@main/manifest.json
```

## External sticker repo

- The app can load sticker packs from a separate static repository via `STICKERS_MANIFEST_URL`.
- If the remote manifest is unavailable, the app falls back to local `public/stickers` packs.
- Manifest format example: `docs/stickers-manifest.example.json`.

Recommended structure for the separate repo:

```text
altmess-stickers/
  manifest.json
  catz/
    001.webp
    002.webp
  retro/
    001.webp
    002.webp
```

Hosting options:

- Cloudflare Pages: host the repo as static files and point `STICKERS_MANIFEST_URL` to `https://<project>.pages.dev/manifest.json`
- GitHub Pages + jsDelivr: keep `manifest.json` in the repo, then use either `https://altro-o.github.io/altmess-stickers/manifest.json` or `https://cdn.jsdelivr.net/gh/Altro-O/altmess-stickers@main/manifest.json`

Recommended for this project:

- use `jsDelivr` for raw sticker asset delivery because it gives a stable CDN URL directly from GitHub
- keep `manifest.json` simple, with a repo-level `baseUrl` and relative file paths
- current production manifest URL: `https://cdn.jsdelivr.net/gh/Altro-O/altmess-stickers@main/manifest.json`

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
- add a visual feature roadmap block
