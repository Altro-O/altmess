# Altmess Project Handoff

## What the project is

Altmess is a PWA-first realtime messenger for private use between browsers and mobile devices.

Current product state already includes:
- one-to-one realtime chat
- audio and video calls
- replies, reactions, emoji, stickers, and voice messages
- file and image sharing with VPS-backed media storage
- profile editing with avatar upload/crop
- push notifications
- mobile-first chat UX with separate chat screen and action sheets

## Deployment and infra

### Main app
- repository: `https://github.com/Altro-O/altmess`
- local app folder: `E:\projects\Altmess\messenger-app`
- main production app: Render
- public app URL: `https://altmess.onrender.com`

### Database
- Neon Postgres via `DATABASE_URL`
- current persistence model is app-state based, not yet normalized relational tables
- Neon stores application state and metadata, not uploaded binary media

### VPS services
- VPS public IP: `85.117.235.136`
- Ubuntu 24.04
- currently hosts:
  - `coturn`
  - media server for uploads
  - nightly media cleanup timer
- media public base URL:
  - `https://media.85.117.235.136.sslip.io`

## Current architecture

### Frontend
- Next.js App Router UI
- main chat screen: `app/dashboard/chat/page.tsx`
- profile screen: `app/dashboard/profile/page.tsx`
- call UI: `components/VideoCall.tsx`
- navigation: `components/Navigation.tsx`
- reusable avatars: `components/UserAvatar.tsx`

### Backend
- custom server entry: `server/server.js`
- persistence layer: `server/persistence.js`
- VPS media service: `server/media-server.js`
- VPS cleanup job: `server/media-cleanup.js`

### Media pipeline
- user uploads no longer live inside message payloads as data URLs
- Render app proxies uploads to VPS media service when `MEDIA_UPSTREAM_*` envs are set
- chat messages and avatars store URLs + metadata
- old VPS media is cleaned with nightly retention policy

### Calls
- current calls are still one-to-one WebRTC calls with Socket.IO signaling
- TURN is self-hosted on VPS
- one-to-one calls were recently improved with:
  - reconnect grace period
  - iPhone resume recovery
  - less aggressive teardown on short disconnects
- group calls are not implemented yet

## Current important Render env vars

- `DATABASE_URL`
- `JWT_SECRET`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`
- `MEDIA_UPSTREAM_URL`
- `MEDIA_UPSTREAM_TOKEN`
- `MEDIA_PUBLIC_BASE_URL`

Important note:
- do not store real secrets in this file
- rotate exposed credentials if they were pasted into chat/history during setup

## Current VPS setup

### coturn
- service name: `coturn`
- firewall allows:
  - `22/tcp`
  - `3478/tcp`
  - `3478/udp`
  - `49160:49200/udp`
  - `Nginx Full`

### media server
- service name: `altmess-media`
- listens internally on `127.0.0.1:4100`
- served through nginx over HTTPS
- current health check:
  - `https://media.85.117.235.136.sslip.io/healthz`

### media cleanup
- service: `altmess-media-cleanup.service`
- timer: `altmess-media-cleanup.timer`
- nightly schedule:
  - `04:10 UTC`
- current policy:
  - soft limit: `6.5 GB`
  - hard limit: `7 GB`
  - minimum free disk reserve: `512 MB`
- behavior:
  - remove orphaned files first
  - then expire oldest chat attachments if storage pressure remains
  - expired attachments become placeholders in chat instead of broken links

## Current feature set

### Messaging
- realtime messages via Socket.IO
- sent / delivered / read states
- edit and delete
- replies and quoting
- reactions
- emoji picker
- local drafts per dialog
- pinned chats (currently local browser state)
- per-dialog search
- date separators in chat timeline
- floating jump-to-latest button

### Media
- multi-file upload
- upload progress UI
- drag/drop upload on desktop
- inline image preview + lightbox
- grouped gallery from chat header
- jump from gallery item to original message
- file cards and expired file placeholders

### Stickers / emoji
- auto-loaded web-friendly sticker packs from `public/stickers`
- current working added packs include:
  - `flork`
  - `meownicorn`
  - `mauuyn`
  - `emoji1`
- frequent emoji and stickers are promoted first in the picker
- some source archives are still `tgs/lottie` and require conversion before web usage

### Profile
- display name / bio / color
- avatar upload through VPS media storage
- avatar crop UI
- use-as-is avatar option
- avatar replace and delete with old-file cleanup on VPS

### Calls and notifications
- one-to-one audio/video calls
- TURN-backed WebRTC
- web push notifications for messages and calls
- missed/rejected/accepted/ended call events in chat history
- ringtone / reconnect / weak-connection UX improvements

## Known limitations

### iPhone / PWA
- background call behavior is still limited by iOS/Safari/PWA restrictions
- calls can now recover better after returning to the app, but true native-style background calling is not available in web app mode

### Calls
- one-to-one calls are improved but still not equivalent to native apps
- no group calls yet
- long-term group-call path likely needs separate SFU infrastructure

### Persistence model
- current app-state persistence is still a pragmatic MVP model
- long-term scaling path is normal relational tables for users / dialogs / messages / calls / settings

### Stickers
- Telegram animated sticker exports (`.tgs`, `.lottie`) still need conversion to web-friendly formats before integration

## Practical next steps

1. Add multi-select messages and forwarding
2. Move pinned chats from local storage to server-side persistence
3. Continue one-to-one call quality fallback improvements
4. Design group chats, then later group-call architecture
5. Consider normalized database model before larger feature growth

## Files most likely to be touched next

- `app/dashboard/chat/page.tsx`
- `components/VideoCall.tsx`
- `server/server.js`
- `server/media-server.js`
- `server/media-cleanup.js`
- `styles/chat.module.css`
- `styles/videoCall.module.css`
- `utils/api.ts`
