# Altmess Tasks

## Current focus

### 1. Group communication
- design group chats
- prepare architecture for group calls without paid services
- keep one-to-one call flow stable while group features are added

### 2. Calls stability
- continue improving one-to-one call recovery on weak mobile networks
- verify reconnect after iPhone app resume, Wi-Fi switch, and short internet loss
- add graceful fallback from video to audio when bandwidth is poor

### 3. Messenger productivity
- add multi-select messages
- add forwarding flow
- later combine multi-select with delete / forward actions

## Medium priority

### 4. Chat data sync improvements
- move pinned chats from local browser storage to server-side persistence
- decide whether dialog drafts should stay local or also sync between devices

### 5. Sticker system
- convert Telegram `tgs/lottie` archives into web-friendly `webp/webm` packs
- add tabs or segmented controls for `emoji / stickers / frequent`
- optionally add sticker search by pack/title later

### 6. Notifications and PWA polish
- improve missed-call UX
- add install prompt / helper UI for iPhone `Add to Home Screen`
- consider richer notification copy and actions where platform allows it

## Lower priority

### 7. Media polish
- improve gallery further with larger preview flow and better grouping polish
- consider file-type-specific previews later
- optionally add image carousel when several media items are sent in sequence

### 8. Data model migration
- current app still uses single app-state persistence in Neon
- long-term better path is normal relational tables for users / dialogs / messages / calls
- not urgent yet, but should be planned before large feature growth

## Done recently

- moved user uploads to VPS-backed media storage
- added avatar upload, crop, replace, and delete with VPS cleanup
- added VPS media cleanup policy with nightly timer and expired placeholders
- added multi-file upload, progress, drag/drop, grouped gallery, drafts, pinned chats, and per-dialog search
- improved sticker picker with auto-loaded packs, frequent emoji/stickers, and lighter sticker rendering
- improved one-to-one calls with reconnect grace period and iPhone resume recovery
- polished desktop and mobile chat UI significantly
