# API Reference

Base URL: `http://localhost:4000/api/v1` (the Vite dev server proxies `/api`).

## Authentication

All `/auth` endpoints set an **HttpOnly `sc_token` cookie** (`SameSite=Lax`) and also
return the token in the JSON body for non-browser clients.

Send the token either as the cookie or as `Authorization: Bearer <token>`.

Errors: `{ "error": { "code": string, "message": string, "details"?: object } }`.

### `POST /auth/register`
Body: `{ username, displayName, password, device, proof }`
- `username`: 3–32 chars, `a-z0-9_`, unique, lowercased.
- `password`: >= 8 chars. Hashed with scrypt (never stored plaintext).
- `device`: `{ clientDeviceId, name, signingPublicKey }` — the client's stable device
  id and the public half of its proof-of-possession key.
- `proof`: `{ challengeId, signature }` — a signature over a server challenge.
- Creates the account and its **single** device atomically.
- Returns `201 { user, token, expiresAt, device }`.

### `POST /auth/challenge`
Body: `{ username? }` → `200 { challengeId, challenge, expiresAt }`.
- Issues a short-lived, single-use nonce that the client signs with its device key.

### `POST /auth/login`
Body: `{ username, password, device, proof, replace? }` → `200 { user, token, expiresAt, device, replaced }`.
- Wrong credentials → `401`.
- From the account's already-registered device → succeeds (proof verified).
- From a **different** device while one is active → `409 device_already_registered`
  (body `details.activeDevice`). Re-submit with `replace: true` to explicitly sign the
  old device out, revoke it, and bind this one.
- For a legacy account whose device has no proof key, the device is upgraded in place.
- Errors: `device_not_authorized` (403) when a proof fails, `device_revoked` (403) when a
  session's device was revoked.

### `POST /auth/logout`
Revokes the session and clears the cookie → `200 { ok: true }`.

### `GET /auth/me`
Requires auth → `200 { user, device }`. If the session's device is no longer the active
one, returns `403 device_replacement_required` (or `device_revoked`).

## Users

### `GET /users/search?q=`
Requires auth. → `200 { results: [{ id, username, displayName, relationship }] }`
`relationship` ∈ `none | pending | friends`. Excludes self.

## Friends

Requires auth.

- `GET /friends` → `{ friends: [...] }`
- `POST /friend-requests` `{ username }` → `201 { request }` — no self-requests,
  no duplicates, no request if already friends. `409` on conflict, `404` if not found.
- `GET /friend-requests/incoming` → `{ requests: [...] }`
- `GET /friend-requests/outgoing` → `{ requests: [...] }`
- `POST /friend-requests/:id/accept` → `{ request }` (recipient only)
- `POST /friend-requests/:id/reject` → `{ request }` (recipient only)
- `DELETE /friend-requests/:id` → `{ request }` (canceller only)

## Devices & keys

Requires auth. **One active device per account.** The device is created at
register/login (see above); there is no `POST /devices`.

- `PUT /devices/current/identity` `{ identityPublicKey, algorithm }` → `{ device }`
  - Publishes the account's **E2EE** identity key on the bound device.
  - `algorithm` must be `ECDH-P256`. Idempotent for the same key.
- `GET /devices` → `{ devices: [...] }` (active + revoked history; no signing keys exposed)
- `DELETE /devices/:id` → `{ device }` (owner only; revokes and disconnects its sockets)
- `GET /keys/:userId` → `{ bundle: { userId, username, displayName, devices: [{ id, name, identityPublicKey, algorithm }] } }`
  - Public material only; devices without a published identity key are omitted.
  - Used by peers to derive a session key.

## Messages

Requires auth. Server stores ciphertext only.

- `POST /messages`
  Body: `{ messageId, recipientId, ciphertext, iv, alg, deviceId? }`
  - `alg` must be `AES-256-GCM`.
  - Requires an **accepted friendship** (otherwise `403`); self-messaging → `400`.
  - `messageId` is the idempotency key.
  - → `201 { messageId, status, queued, duplicate }`
  - `status`: `delivered` (recipient socket received it) or `queued` (offline).

- `GET /messages/pending` → `{ messages: [...] }`
  Non-acked, non-expired ciphertext for the authenticated recipient.

- `POST /messages/ack` `{ messageId }` → `{ ok, messageId, status }`
  Recipient confirms local persistence; queued ciphertext is erased.
  Notifies the sender via `message:status`. Only the recipient may ack (`403`).

- `GET /messages/status/:messageId` → `{ messageId, status, ... }`
  `queued | delivered | acked | expired`. Participants only (`403` for others).

## Health

- `GET /api/v1/health` → `{ ok: true, version }`

## Socket.IO

Path `/socket.io`, `withCredentials: true`. The handshake must carry a valid session
cookie (or `socket.handshake.auth.token`) **and** the session's device must still be the
account's active device, otherwise `connect_error: unauthorized`. Sensitive client events
(`message:ack`) re-check device authorization and disconnect a socket whose device was
replaced.

**Server → client**

| Event | Payload | Meaning |
| --- | --- | --- |
| `presence:snapshot` | `{ onlineFriends: string[] }` | On connect |
| `presence` | `{ userId, online }` | Friend presence change |
| `message:new` | `{ messageId, senderId, ciphertext, iv, alg, createdAt }` | Ciphertext delivered |
| `message:status` | `{ messageId, status }` | Status change (`acked`) |
| `friend:request` | request | New incoming request |
| `friend:accepted` | request | Request accepted (both users) |
| `friend:request:update` | request | Rejected/cancelled |

**Client → server**

| Event | Payload | Meaning |
| --- | --- | --- |
| `message:ack` | `{ messageId }` | Recipient persisted the message; erases queued ciphertext, notifies sender |
| `sync:request` | — | Triggers a reconnect sync (`ack`'d) |
