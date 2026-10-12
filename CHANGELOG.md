# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- Realtime messaging through the Vite dev proxy: authenticate over polling then
  upgrade to WebSocket (the upgrade path does not carry the session cookie),
  which previously left the client stuck on "offline" and blocked live delivery.
- Duplicate encryption keys from React StrictMode's double-mounted effect: identity
  bootstrap is now guarded by a shared in-flight promise, and stale devices are
  reconciled so peers always fetch the key matching the persisted identity.
  This was the cause of "Unable to decrypt this message".
- Presence for users who are both online before becoming friends: acceptance now
  emits presence for each peer (previously the peer appeared offline until reconnect).
- `:memory:` database file was being resolved to an on-disk path in tests.
- Device re-registration now reactivates a previously revoked key.
- Opening a new account previously showed the previous account's conversations
  and messages because messages/conversations/outbox were stored globally.
  `<ChatProvider>` is now keyed by user id and every storage call is scoped to
  the authenticated user; stale async socket handlers are ignored after unmount.

### Added

- **Single-port Docker deployment.** `docker compose up --build` runs the backend and
  an nginx web tier; nginx serves the built SPA and reverse-proxies `/api` and
  `/socket.io` (WebSocket upgrade, 32 MiB body limit) so the whole app is reachable on
  one published port. SQLite and encrypted attachments persist in a named volume
  (`server/Dockerfile`, `client/Dockerfile`, `client/nginx.conf`, `docker-compose.yml`).
- `COOKIE_SECURE` config override (defaults to `NODE_ENV === 'production'`) so the
  session cookie's `Secure` flag can match whether the deployment terminates TLS.
- **End-to-end encrypted attachments (images & files).** Files are encrypted in the
  browser in 1 MiB chunks (AES-256-GCM, per-chunk nonces derived from a random per-file
  salt via HKDF-SHA-256, chunk AAD binding format version/chunk size/count/total
  size/index). The content key + salt are embedded only in the encrypted message envelope,
  so the server never sees keys, salt, or plaintext — only opaque ciphertext plus
  non-sensitive metadata (name, MIME on a safe allowlist, sizes, sender/recipient).
  Two-step REST upload (`POST /attachments` ticket → streamed `PUT .../data`) with a
  16 MiB cap and a 256 MiB/user quota; the server streams to disk without buffering and
  a background job expires pending or orphaned blobs. `GET .../data` is authorized to
  sender+recipient only and served `nosniff` + `private, no-store` with `filename*`;
  sender delete is idempotent. Message submission/linking happens in one transaction;
  `attachmentId` flows through pending sync and `message:new`. Reconnect downloads
  decrypt async, render image/file bubbles with progress + retry, lightbox for images,
  and download anchors; upload failures (incl. retry) never reuse a nonce/key.
- Migration `004_attachments.sql`: `attachments` table (`kind`, `name`, `content_type`,
  `plain_size`, `cipher_size`, `status` pending/ready, `expires_at`) + indexes.
- Config: `ATTACHMENT_DIR`, `ATTACHMENT_MAX_BYTES` (16 MiB), `ATTACHMENT_QUOTA_BYTES`
  (256 MiB), `ATTACHMENT_PENDING_TTL_MS` (24 h).
- Tests: 11 server attachment tests (authz, over-limit/mismatch rejection, expiry, delete,
  cleanup) → 55 total; 8 attachment crypto tests + 4 payload tests → 29 client tests
  total; 2 E2E attachment specs (image + large text file) → 6 E2E tests total.
- E2E runs boot the server with a higher localhost rate limit so the shared test IP
  survives full-suite traffic (server rate limiting unchanged in production defaults).
- **Voice messages.** Browser `MediaRecorder` wrapper (`client/src/services/recorder.ts`)
  with selectable audio MIME type (`audio/webm;codecs=opus` preferred, `webm`/`mp4`/`ogg`
  fallbacks), a hard 60 s cap that never drops the captured blob, cancel/resume, and an
  injectable recorder factory so the logic is unit-testable. Voice recordings flow through
  the exact attachment pipeline (`sendAttachment`), so they are encrypted chunked AAD the
  same way as images/files and rendered as playable `<audio>` bubbles on both sides with a
  composer recorder bar (timer, cancel, send). 8 tests → 37 client tests total.
- **One-to-one audio calls.** Server-side in-memory call state machine
  (`server/src/calls/service.js`, volatile like presence): states `ringing → connecting →
  active`, one active call per user, ring timeout (45 s) and signaling-expiry guard on a
  stalled connection. Socket events `call:invite` (server-enforced friendship, self-call,
  offline/busy rejection), `call:ring`, `call:accept`, `call:decline`, `call:cancel`,
  `call:end`, `call:connected`, and `call:signal` relaying SDP/ICE (dropped for
  non-participants); participant disconnect ends the call with `peer_left`. Media flows
  peer-to-peer; the server only validates and relays signaling. Client `RtcPeer` wrapper
  (`client/src/services/peer.ts`) owns getUserMedia + ICE, and `CallScreen` /
  `IncomingCallOverlay` render calling/ringing/in-call states with a live timer, mute and
  hang up. ICE configuration is exposed via authenticated `GET /api/v1/rtc-config`
  (STUN/TURN from `RTC_STUN_SERVERS`, `RTC_TURN_URL`, `RTC_TURN_USERNAME`,
  `RTC_TURN_CREDENTIAL`), so TURN credentials stay server-side.
  Calls use the same P-256 identity infrastructure; media is DTLS-SRTP encrypted between
  peers, but no identity-authenticated E2EE claim is made for calls yet (see
  `docs/IMPLEMENTATION_STATUS.md`).
- Tests: 11 server call tests (ring/accept/decline/cancel/timeout/offline/busy/signal
  membership/friendship/disconnect + `rtc-config` auth) → 66 total; 8 `RtcPeer` unit tests
  → 45 client tests total; 2 E2E audio-call specs (ring→accept→in-call→hang up, decline)
  → 9 E2E tests total.
- **One-to-one video calls.** The call state machine now carries a `kind`
  (`audio`|`video`): `call:invite` sends it, `createCall` stores it, and `call:ring`
  advertises it so the callee knows to open a camera too. Both sides capture local video
  and render a full-screen stage (`CallScreen`) with remote + local (muted, mirrored)
  preview while keeping the audio controls — mute, live timer, hang up — and the same
  `IncomingCallOverlay` labelled "Incoming video call…". Server test for ring `kind`
  → 67 total; video-call E2E spec (accept → live local + remote video on both sides →
  hang up) → 10 E2E tests total.
- **Single-device enforcement.** An account may have exactly one active device,
  enforced by a unique partial index (`user_id WHERE revoked_at IS NULL`). Each
  browser keeps a stable `clientDeviceId` and a non-extractable ECDSA P-256 signing
  key; register/login sign a server challenge (`POST /auth/challenge`) to prove
  possession. A second device is rejected (`409 device_already_registered`) unless the
  client explicitly requests replacement, which revokes the old device and disconnects
  its sockets. Sessions store `device_id` and every authenticated request and socket
  event re-checks it, so a replaced token fails with `403 device_revoked`.
  Legacy devices (no proof key) are upgraded in place on next login.
- Client signs itself out cleanly when it is replaced: a REST `device_revoked` /
  `device_replacement_required` or a socket handshake rejection clears the session and
  returns to the login screen with a short explanation, instead of leaving a broken,
  half-authenticated view.
- Migrations `002_device_binding.sql` and `003_device_identity_optional.sql`: device
  columns (`client_device_id`, `signing_public_key`, `last_seen_at`), session `device_id`,
  the `auth_challenges` table, and relaxing the E2EE identity columns so a device can be
  bound before its encryption key is published. Existing rows (including revoked
  devices) are preserved and duplicate active devices are collapsed to the newest.
- Account-scoped IndexedDB storage (database v3): messages, conversations, and
  the outbox are now keyed by `ownerId` so multiple accounts on one browser keep
  isolated history. Legacy (ownerless) v1 records are preserved in a separate
  `legacy` archive for explicit recovery instead of being deleted or guessed.
  A `device` store keeps the device credential (signing key) per browser.
- Tests: account isolation, logout/login restore, legacy migration + recovery,
  idempotent interrupted-migration cases, and session-invalidation signalling
  (29 client tests total).
- Tests: device binding — second-device rejection, replacement revokes the old device
  and its sockets, copied-`clientDeviceId` impersonation fails, session survives an IP
  change, legacy upgrade, concurrent replacement leaves one active device
  (55 server tests total).
- End-to-end tests (`@playwright/test`, 6 tests): first-device registration, second-device
  rejection with `409 device_already_registered`, authorized replacement that signs the
  previous device out, refresh/reconnect stays valid, chat still works after auth, and
  encrypted image + large text-file attachment round trips.
  The runner boots the real server against an in-memory database on isolated ports
  (`E2E_SERVER_PORT`/`E2E_CLIENT_PORT`) and never touches the dev database.

## [0.1.0] - 2026-10-10

Initial web-first MVP.

### Added

- Monorepo (npm workspaces) with `client/` (React + TS + Vite) and `server/`
  (Express + Socket.IO + `node:sqlite`).
- Authentication: register, login, logout, session persistence/expiry/revocation,
  scrypt password hashing, HttpOnly cookie sessions.
- Friends: user search, friend requests (send/accept/reject/cancel), incoming/outgoing
  lists, friendships, server-side validation.
- Devices & public keys: device registration/revocation and public-key bundle retrieval.
- End-to-end encryption (prototype): ECDH P-256 + HKDF-SHA-256 + AES-256-GCM with AAD
  binding and non-extractable private keys in IndexedDB (`client/src/crypto`).
- Messaging: ciphertext-only submission, SQLite offline queue with 7-day expiry,
  reconnect retrieval, transport vs persistence acknowledgements, idempotent retries.
- Socket.IO realtime: authenticated connections, presence, new-message delivery, message
  status, friend-request events.
- IndexedDB persistence behind a `ChatStorage` interface: message history, conversations,
  identity key, encrypted outbox.
- Dark-theme UI: conversations sidebar, search, friends/requests, composer, status ticks,
  connection indicator, profile panel, loading/empty/error states.
- SQL migrations, parameterized SQL, foreign keys, unique constraints, transactions,
  rate limiting, consistent error responses.
- Tests: 30 server integration tests (`node:test`) and 5 client crypto tests (`vitest`).
- Documentation: `README`, `AGENTS`, `docs/ARCHITECTURE`, `docs/E2EE`,
  `docs/OFFLINE_DELIVERY`, `docs/API`, `docs/IMPLEMENTATION_STATUS`.

### Security notes

- E2EE is a prototype without forward secrecy or key verification. See `docs/E2EE.md`.
- The server only ever stores metadata, public keys, and temporary ciphertext.
