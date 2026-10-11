# Architecture

SecureChat is a simple npm-workspaces monorepo with two applications sharing a
versioned HTTP + WebSocket protocol.

```
securechat/
  client/            React + Vite SPA (encryption happens here)
    src/crypto/      Web Crypto primitives (no React imports)
    src/storage/     ChatStorage interface backed by IndexedDB
    src/services/    REST (fetch) and Socket.IO clients
    src/features/    Auth + Chat React contexts (orchestration)
    src/components/  Presentational UI
  server/            Express + Socket.IO + SQLite
    src/auth/        Registration, login, challenges, sessions, password hashing
    src/friends/     Search, friend requests, friendships
    src/devices/     Device binding + public-key bundles
    src/messages/    Offline queue, dedup, ack, expiry
    src/sockets/     Socket.IO auth, presence, realtime events
    src/database/    node:sqlite connection + migration runner
    migrations/      Ordered .sql files (tracked in schema_migrations)
    tests/           node:test integration tests
  docs/              Architecture, E2EE, offline delivery, API, status
```

## Data flow

1. Client authenticates; server issues an HttpOnly `sc_token` cookie (also returned as
   a bearer token for non-browser clients). Sessions are stored server-side with an
   expiry, are **bound to a device**, and can be revoked.
2. Authentication is device-bound. Each browser holds a stable `clientDeviceId` plus a
   non-extractable **ECDSA P-256 signing key**; it signs a server challenge
   (`POST /auth/challenge`) to prove possession. An account may have exactly **one
   active device** (enforced by a unique index). Registering/logging in from a new
   device is rejected (`device_already_registered`) unless the client explicitly
   requests replacement, which revokes the previous device and disconnects its sockets.
   Every authenticated request and socket re-checks that the session's device is the
   active one.
3. The **E2EE identity key** (ECDH P-256) is generated locally and published on the
   bound device via `PUT /api/v1/devices/current/identity`; the private key is stored
   non-extractable in IndexedDB.
4. To message a friend, the sender fetches the recipient's public key bundle, derives
   a per-conversation AES-256-GCM key (ECDH + HKDF), encrypts locally, persists the
   outgoing record in IndexedDB (outbox), then submits ciphertext to the server.
5. The server enforces the friendship, then either (a) emits the ciphertext to a
   connected recipient socket, or (b) stores it in the SQLite queue for later delivery.
6. The recipient decrypts locally, stores the plaintext in IndexedDB, then sends a
   **persistence acknowledgement**, which is the only thing that erases the queued
   ciphertext.

## Module boundaries

| Concern | Lives in | Notes |
| --- | --- | --- |
| Cryptography | `client/src/crypto` | Framework-independent, reusable |
| Persistence contract | `client/src/storage/repositories.ts` | `ChatStorage` interface |
| Orchestration/state | `client/src/features/chat/ChatContext.tsx` | Notable side effects |
| Authorization/trust | `server/src/*` via middleware | Never trusts the client |

## Server design choices

- **Single instance.** Rate limiting and presence are in-memory; no Redis/queue/2nd DB.
- **`node:sqlite`.** No native compilation. Foreign keys + WAL enabled per connection.
- **Device-bound sessions.** A unique partial index (`WHERE revoked_at IS NULL`) guarantees
  at most one active device per user. Registration binds the device in the same
  transaction as the user; login resolves the device (enroll / verify / upgrade legacy /
  reject / explicit replace). `sessions.device_id` records the binding and is re-checked
  on every authenticated request and socket event, so a replaced device is cut off even
  though its session token is still cryptographically valid.
- **Transactions.** Friend acceptance and message submission run inside
  `withTransaction` (BEGIN IMMEDIATE / COMMIT / ROLLBACK).
- **Parameterized SQL only.** No string-interpolated user input.
- **Consistent errors.** `AppError` → `{ error: { code, message, details? } }`.

## Database tables

`users`, `sessions`, `devices`, `auth_challenges`, `friendships`, `friend_requests`,
`messages`, `schema_migrations`. See `server/migrations/` for constraints and indexes.
Notably `devices` has a unique partial index (`user_id WHERE revoked_at IS NULL`) that
enforces one active device per account, plus `(user_id, client_device_id)` for idempotent
rebinding.

## Realtime

Socket.IO connections are authenticated in the handshake (`socket.handshake.auth.token`
or the `sc_token` cookie), must belong to the account's active device, and each socket
joins room `user:<id>`. Server→client events:
`message:new`, `message:status`, `presence`, `presence:snapshot`, `friend:*`.
Client→server events: `message:ack`, `sync:request`.

## Browser storage (IndexedDB)

`client/src/storage` hides all IndexedDB access behind the `ChatStorage` interface.
The database is **account-scoped** so multiple accounts sharing one browser never see
each other's history.

- Stores (schema v3): `identity` (keyPath `userId`), `device` (keyPath `id`, the stable
  `clientDeviceId` + non-extractable ECDSA signing key), `meta` (keyPath `key`),
  and owner-scoped `scopedMessages`, `scopedConversations`, `scopedOutbox`.
- Owner-scoped records are keyed by a composite string `<ownerId>:<id>` and carry an
  `ownerId` field with a non-unique `ownerId` index (messages also index
  `ownerId,conversationId`). Every storage method takes `ownerId` first and returns
  records with the internal composite key stripped.
- **No account data is ever guessed or deleted.** A v1 database (ownerless `messages`,
  `conversations`, `outbox`) is migrated non-destructively: the original stores are kept
  and their rows are copied into a `legacy` archive (keyed `"<store>:<id>"`) once, guarded
  by the `meta` flag `legacyArchiveVersion`. The migration is idempotent, so an
  interrupted run simply re-archives without duplicating or losing data.
- Legacy rows are surfaced through `getLegacySummary()` / `listLegacyRecords(sourceStore?)`
  and can be attached to an account via `recoverLegacyRecords(ownerId, legacyIds)`.
- `<ChatProvider key={user.id}>` remounts all chat state on account switch, and socket
  handlers stop applying results after unmount, so a slow operation from a previous
  account cannot mutate the current account's state.
