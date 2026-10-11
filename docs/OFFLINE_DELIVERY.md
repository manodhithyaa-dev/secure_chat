# Offline Delivery

Goal: never lose a message, never duplicate one, and never confuse transport delivery
with the recipient actually saving the message.

## Sender side — the outbox

Implemented in `client/src/features/chat/ChatContext.tsx`, persisted through
`ChatStorage` (`client/src/storage/repositories.ts`).

1. Generate a unique `messageId` (`crypto.randomUUID()`).
2. Encrypt locally (`client/src/crypto`).
3. Write the plaintext+status record to IndexedDB (`messages` store) **and** an encrypted
   outbox record (`outbox` store) with the ciphertext, IV and algorithm.
4. `POST /api/v1/messages` with the envelope.
5. Update status from the server response:
   - `delivered` → local `delivered`
   - `queued` (recipient offline) → local `sent`, removed from outbox (server now owns it)
   - network/error → local `failed`, **kept in the outbox** for retry
6. On reconnect (and via the **Retry** button) the outbox is replayed, **reusing the same
   `messageId`**, so the server deduplicates.

## Server side — temporary ciphertext queue

Implemented in `server/src/messages/service.js`.

- Each submitted message is stored once, keyed by `message_id` (primary key). Retries
  with the same id return the existing row (`duplicate: true`) instead of inserting.
- `expires_at = now + MESSAGE_TTL_MS` (default **7 days**).
- If the recipient has a live socket, the server emits `message:new` and marks the row
  `delivered` (transport delivery only).
- Otherwise the row stays `queued`.

### Acknowledgements

- `delivered` (transport) is set when the server hands the ciphertext to a socket. It is
  **not** proof the recipient saved anything.
- `acked` (persistence) is set only when the **recipient** calls
  `POST /api/v1/messages/ack` (or emits `message:ack` after storing the message
  locally). At that point the queued **ciphertext is erased** (`ciphertext = NULL`,
  `iv = NULL`); minimal metadata remains so the sender can observe final status.
- A lost ack is self-healing: the row stays in the queue, the recipient re-receives it on
  the next sync, **deduplicates by `messageId`**, and acknowledges again.

### Reconnect retrieval

On every socket `connect` (and once at startup) the client calls
`GET /api/v1/messages/pending`. All `queued`/`delivered` (non-acked, non-expired)
ciphertext is decrypted, persisted, and acknowledged.

## Expiry / cleanup

A background job (`server/src/index.js`, `CLEANUP_INTERVAL_MS`, default hourly) deletes:

- non-acked rows past `expires_at` (undelivered, expired), and
- acked rows older than `MESSAGE_TTL_MS` after ack.

`GET /api/v1/messages/status/:messageId` reports `expired` once a row is gone.

## Statuses in the UI

`pending` → `sent` (accepted/queued) → `delivered` (transport or acked) → `failed`
(retryable). See `ChatWindow.tsx`.

## Not implemented

- Native mobile push and production browser push. The MVP uses in-app updates and
  reconnect sync only.
- Multi-device history sync, delivery scheduling guarantees across restarts beyond the
  documented queue, and read receipts.
