# Implementation Status

Last updated: 2026-10-11. Version 0.1.0.

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
- **Auth:** register, login, logout, `me`; scrypt password hashing; server-side sessions
  with expiry and revocation; HttpOnly cookie session; authenticated routes.
- **Device binding:** one active device per account (unique partial index); challenge +
  ECDSA proof of possession; device-bound sessions revalidated per request and per socket
  event; explicit, authorized replacement; legacy devices upgraded in place.
- **Friends:** username search; send/accept/reject/cancel requests; incoming/outgoing
  lists; friends list; duplicate/self-request prevention enforced server-side.
- **Messaging authorization:** messaging blocked until friendship is accepted (server-side).
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
- **UI:** dark theme; conversations, search, friends, requests, unread badges,
  connection status, message bubbles with timestamps and status ticks, profile panel,
  loading/empty/error states.
- **Security hygiene:** rate limiting, consistent errors, parameterized SQL, input
  validation, no secrets/plaintext in logs.

## Tests actually run

- Server (`node:test`, 44 tests): startup/migrations, registration/login/logout, friend
  request acceptance rules, authz & malformed input, message queue, dedup, ack (payload
  erased), expiry, authorization, realtime online delivery, reconnect retrieval,
  presence snapshot + acceptance-time presence, device idempotency/revocation, and
  device binding (second-device rejection, replacement revokes the old device + its
  sockets, copied-`clientDeviceId` impersonation fails, session survives IP change,
  legacy upgrade in place, concurrent replacement leaves one active device).
- Client (`vitest`, 17 tests): identity generation, equal session key derivation,
  encrypt/decrypt round trip, ciphertext≠plaintext, tamper/wrong-key rejection;
  account-scoped storage isolation, logout/login history restore, legacy migration
  into the recoverable archive, explicit recovery, idempotent interrupted migration,
  and session-invalidation signalling for a replaced/revoked device.
- E2E (`@playwright/test`, 4 tests, Chromium): first-device registration + refresh,
  second-device rejection (asserts `409 device_already_registered`), authorized
  replacement that signs the previous device out and keeps the new device valid across
  a refresh, and a friend-request + encrypted-message round trip. Runs the real server
  on an in-memory DB and the real client on isolated ports.
- Production build: `npm run build` succeeds (`tsc --noEmit` + Vite).

## Incomplete / limited (works, but not production-grade)

- E2EE is a prototype with **no forward secrecy, no ratchet, no key verification**
  (see `docs/E2EE.md`).
- **One device per account by design.** Replacing a device revokes the previous one; no
  multi-device key agreement or message fan-out.
- No server-side push notifications (in-app + reconnect sync only).
- No message editing/deletion, typing indicators, or read receipts.
- Profile settings are read-only (display name cannot be edited yet).
- No password change / account deletion endpoints.

## Explicitly deferred (do not fake)

- Flutter / Android / iOS builds.
- Native and production browser push.
- Multi-device history sync, encrypted backup/recovery.
- Attachments (image/video/file), voice/video calls, groups.
- Advanced UI polish and production deployment automation.
