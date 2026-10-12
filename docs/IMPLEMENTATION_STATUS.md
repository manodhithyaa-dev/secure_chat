# Implementation Status

Last updated: 2026-10-12. Version 0.1.0.

## Recently fixed (verified against a live dev server)

- **Single-device enforcement.** An account may have exactly one active device. Each
  browser has a stable `clientDeviceId` and a non-extractable ECDSA P-256 signing key;
  register/login signs a server challenge to prove possession. A second device is
  rejected (`409 device_already_registered`) unless the client explicitly requests
  replacement, which revokes the old device and disconnects its sockets. Sessions carry
  `device_id` and every request/socket event re-checks it, so a replaced token stops
  working immediately (`403 device_revoked`). Verified: register→publish→second-device
  reject→replace→old token revoked→new token works.
- A replaced/revoked device signs itself out: `device_revoked` /
  `device_replacement_required` from REST or the socket handshake clears the session and
  returns to the login screen with a short explanation.
- Socket auth through the Vite proxy now uses polling-then-WebSocket upgrade so the
  session cookie is present on first connect; the connection indicator shows
  *Connected* and realtime delivery works.
- Identity bootstrap is idempotent under React StrictMode's double mount (shared
  in-flight promise) and each account has exactly one active device.
- Presence is delivered when two users who were both online become friends
  (acceptance emits presence to each peer).
- Multi-account isolation: a new account on the same browser no longer shows the
  previous account's conversations/messages. IndexedDB is now account-scoped
  (database v3) and `<ChatProvider>` is keyed by user id.

## Verified (implemented + tested)

- **Repo & tooling:** npm workspaces; root `npm run dev` runs server + client; migrations.
- **Deployment:** multi-stage Docker images for the backend and the nginx web tier.
  `docker compose up --build` serves the built SPA and reverse-proxies `/api` +
  `/socket.io` (WebSocket upgrade, 32 MiB body limit) on a single published port;
  SQLite and encrypted attachments persist in a named volume. `COOKIE_SECURE` selects
  the session cookie's `Secure` flag for plain-HTTP vs TLS-terminated deployments.
- **Auth:** register, login, logout, `me`; scrypt password hashing; server-side sessions
  with expiry and revocation; HttpOnly cookie session; authenticated routes.
- **Device binding:** one active device per account (unique partial index); challenge +
  ECDSA proof of possession; device-bound sessions revalidated per request and per socket
  event; explicit, authorized replacement; legacy devices upgraded in place.
- **Friends:** username search; send/accept/reject/cancel requests; incoming/outgoing
  lists; friends list; duplicate/self-request prevention enforced server-side.
- **Messaging authorization:** messaging blocked until friendship is accepted (server-side).
- **E2EE attachments (images/files):** attachments are encrypted client-side in 1 MiB
  chunks with AES-256-GCM (per-chunk nonces from HKDF-SHA-256 keyed with a random per-file
  salt; chunk AAD binds the format version, chunk size, chunk count, total size and index).
  The key and salt travel only inside the encrypted message envelope (server never sees
  them). Upload is two-step REST: `POST /attachments` ticket → streamed `PUT
  /attachments/:id/data` (server never buffers the whole blob; quota 256 MiB/user, size
  cap 16 MiB, no executable types allowed, `nosniff` + `private, no-store` download with
  `filename*`). Attachment metadata link on message submission lives for both
  direct/reconnect delivery; pending sync and `message:new` carry `attachmentId`.
  Client renders image/file bubbles with progress, retry, lightbox, and download; sender
  delete is idempotent and a background job expires pending rows and missing blobs.
- **E2EE:** per-client ECDH P-256 identity keys; HKDF-SHA-256 → AES-256-GCM; random IV;
  AAD binding; integrity failures rejected without plaintext fallback; private key
  non-extractable in IndexedDB.
- **Online delivery:** ciphertext emitted to a connected recipient over Socket.IO.
- **Offline queue:** ciphertext persisted in SQLite with 7-day expiry; delivery on
  reconnect via `GET /messages/pending`.
- **Acknowledgements:** `delivered` (transport) distinguished from `acked` (persistence);
  ack erases the queued ciphertext; lost ack self-heals.
- **Dedup:** `messages.message_id` primary key; retries reuse the id; client dedups on
  receipt.
- **Queue expiry:** background cleanup job; cancelled/expired rows report `expired`.
- **Browser persistence:** IndexedDB stores identity key, device credential (signing
  key), message history, conversations, encrypted outbox (behind the `ChatStorage`
  interface). Messages, conversations, and outbox rows are keyed by `ownerId`, so
  multiple accounts on one browser stay isolated; upgrading from v1 archives ownerless
  records for explicit recovery (see `docs/ARCHITECTURE.md`).
- **Voice messages:** browser `MediaRecorder` wrapper with MIME fallback
  (`audio/webm;codecs=opus` preferred), a 60 s cap that never drops the captured blob,
  cancel/resume, and recorder-bar composer (timer, cancel, send). Recordings flow through
  the attachment pipeline verbatim, so they are AES-256-GCM chunked-encrypted like images
  and render as playable `<audio>` bubbles on both sides.
- **One-to-one audio calls:** server-side in-memory call state machine (`ringing →
  connecting → active`, one active call per user) with socket events for invite/ring/
  accept/decline/cancel/end/connected/signal. Friendship is enforced before ringing,
  offline/busy callees are rejected, rings time out server-side (45 s), stalled signaling
  expires after 60 s, non-participant signaling is dropped, and a participant disconnect
  ends the call. Media is exchanged via WebRTC peer-to-peer (DTLS-SRTP encrypted); the
  server relays only SDP/ICE. STUN/TURN endpoints come from authenticated
  `GET /api/v1/rtc-config` (`RTC_STUN_SERVERS`, `RTC_TURN_URL`, `RTC_TURN_USERNAME`,
  `RTC_TURN_CREDENTIAL`), keeping TURN credentials server-side. The client
  (`client/src/services/peer.ts` + `CallScreen`/`IncomingCallOverlay`) handles
  getUserMedia, ICE candidates, mute, live timer, and hang up.
- **One-to-one video calls:** the audio-call state machine now carries a `kind`
  (`audio`|`video`) from `call:invite` through `call:ring`; the caller and callee each
  open video when `kind === 'video'`. The client renders a full-screen video stage
  (remote + local preview, local preview muted and mirrored) alongside the audio controls
  (mute, live timer, hang up) from the same `CallScreen`. Verified end-to-end: ring →
  accept → both sides show live local and remote video → hang up.
- **UI:** dark theme; conversations, search, friends, requests, unread badges,
  connection status, message bubbles with timestamps and status ticks, profile panel,
  loading/empty/error states.
- **Security hygiene:** rate limiting, consistent errors, parameterized SQL, input
  validation, no secrets/plaintext in logs.

## Tests actually run

- Server (`node:test`, 67 tests): startup/migrations, registration/login/logout, friend
  request acceptance rules, authz & malformed input, message queue, dedup, ack (payload
  erased), expiry, authorization, realtime online delivery, reconnect retrieval,
  presence snapshot + acceptance-time presence, device idempotency/revocation, device
  binding (second-device rejection, replacement revokes the old device + its sockets,
  copied-`clientDeviceId` impersonation fails, session survives IP change, legacy
  upgrade in place, concurrent replacement leaves one active device), attachments
  (ticket creation, streamed upload rejects over-limit/mismatched sizes, sender/recipient
  download authz, cross-friend 403, expiry, sender-only delete, idempotent retry, cleanup
  reconciling expired/pending/missing blobs), and calls (authenticated `rtc-config`,
  ring→accept→signal relay, decline, cancel, server-side ring timeout, offline callee,
  busy callee, non-participant signal rejection, friendship enforcement, participant
  disconnect ends the call, and the ring advertises video call kind).
- Client (`vitest`, 45 tests): identity generation, equal session key derivation,
  encrypt/decrypt round trip, ciphertext≠plaintext, tamper/wrong-key rejection;
  account-scoped storage isolation, logout/login history restore, legacy migration
  into the recoverable archive, explicit recovery, idempotent interrupted migration,
  session-invalidation signalling for a replaced/revoked device, attachment encryption
  (round trip + progress, unique nonces, tamper/corrupt-header/out-of-order/truncation
  rejection, base64 + header helpers), payload envelopes (build/parse, text fallback,
  previews), recorder (MIME selection with injected factory, blob capture, failure
  paths), and the `RtcPeer` WebRTC wrapper (media start, offer/answer, ICE candidate
  queueing, mute, connection/error reporting, clean close).
- E2E (`@playwright/test`, 10 tests, Chromium, fake audio/video devices): first-device
  registration + refresh, second-device rejection, authorized replacement that signs the
  previous device out, encrypted-message round trip, encrypted image + large text-file
  attachment round trips, voice message round trip (record ~1.5 s → send → playable on
  both sides), and calls (audio ring → accept → in-call timer → hang up; decline; and
  video call showing live local and remote video on both sides).
  Runs the real server on an in-memory DB (rate limit raised for the shared localhost
  test client) and the real client on isolated ports.
- Production build: `npm run build` succeeds (`tsc --noEmit` + Vite).
- Docker: both images build; the compose stack serves the SPA, proxies
  `/api/v1/health`, completes the Socket.IO WebSocket upgrade (`101`), and publishes
  only the nginx port.

## Incomplete / limited (works, but not production-grade)

- E2EE is a prototype with **no forward secrecy, no ratchet, no key verification**
  (see `docs/E2EE.md`).
- **One device per account by design.** Replacing a device revokes the previous one; no
  multi-device key agreement or message fan-out.
- No server-side push notifications (in-app + reconnect sync only).
- No message editing/deletion, typing indicators, or read receipts.
- Profile settings are read-only (display name cannot be edited yet).
- No password change / account deletion endpoints.
- Calls support audio and video; no screen sharing.
- **Call security posture:** WebRTC media is encrypted in transit with DTLS-SRTP and
  identity keys prove participation, but calls do not yet identity-authenticate the ICE
  session (no fingerprint verification), so treat call E2EE as prototype-grade like the
  rest of the MVP. Signaling is server-authenticated (Socket.IO session + device check).

## Explicitly deferred (do not fake)

- Flutter / Android / iOS builds.
- Native and production browser push.
- Multi-device history sync, encrypted backup/recovery.
- Groups, typing indicators.
