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
  (17 client tests total).
- Tests: device binding — second-device rejection, replacement revokes the old device
  and its sockets, copied-`clientDeviceId` impersonation fails, session survives an IP
  change, legacy upgrade, concurrent replacement leaves one active device
  (44 server tests total).
- End-to-end tests (`@playwright/test`, 4 tests): first-device registration, second-device
  rejection with `409 device_already_registered`, authorized replacement that signs the
  previous device out, refresh/reconnect stays valid, and chat still works after auth.
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
