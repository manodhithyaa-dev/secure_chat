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
  Body: `{ messageId, recipientId, ciphertext, iv, alg, deviceId?, attachmentId? }`
  - `alg` must be `AES-256-GCM`.
  - Requires an **accepted friendship** (otherwise `403`); self-messaging → `400`.
  - `messageId` is the idempotency key.
  - `attachmentId` (optional) links an uploaded, still-pending attachment; it must be
    owned by the sender, `ready`, and not already linked to another message.
  - → `201 { messageId, status, queued, duplicate, attachmentId }`
  - `status`: `delivered` (recipient socket received it) or `queued` (offline).

- `GET /messages/pending` → `{ messages: [...] }`
  Non-acked, non-expired ciphertext for the authenticated recipient. Each row includes
  `attachmentId` when the message carries an attachment.

- `POST /messages/ack` `{ messageId }` → `{ ok, messageId, status }`
  Recipient confirms local persistence; queued ciphertext is erased.
  Notifies the sender via `message:status`. Only the recipient may ack (`403`).

- `GET /messages/status/:messageId` → `{ messageId, status, ... }`
  `queued | delivered | acked | expired`. Participants only (`403` for others).

## Attachments

Requires auth. The server stores **opaque ciphertext only** (never keys, salt, or
plaintext). Upload is two-step: create a ticket, then stream the ciphertext.

- `POST /attachments`
  Body: `{ kind, name, contentType, plainSize, cipherSize }`
  - `kind` one of `file | image | audio`; `contentType` must be a non-executable,
    known-safe MIME type (allowlist; `text/html`, `image/svg+xml`, … rejected → `400`).
  - `plainSize`/`cipherSize` are metadata only (no size check at ticket time).
  - → `201 { attachment: {...} }` — `status: "pending"`, `expiresAt` (24 h).

- `PUT /attachments/:id/data`
  Raw `application/octet-stream` upload of the ciphertext.
  - Streams to disk without buffering; enforces a 16 MiB cap (→ `413`) and a
    256 MiB/user running quota (→ `413`) *after* the body.

- `GET /attachments/:id/data`
  - Authorized to the **sender or recipient** only; others → `403`.
  - Copy is not stale (`expires_at`/deleted → `410 Gone`).
  - Served `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`,
    `Content-Disposition: attachment; filename*=UTF-8''<name>`.

- `DELETE /attachments/:id`
  Sender only (→ `403` otherwise); idempotent. Also cancels unlinked/unsent uploads.

Cleanup: a background job periodically removes expired rows and their server blobs and
reconciles orphaned files.

## Calls

Requires auth.

- `GET /rtc-config`
  - → `200 { iceServers: [{ urls: [...] }, ...] }`. STUN candidates from
    `RTC_STUN_SERVERS` (default: Google STUN); a `RTC_TURN_URL` with
    `RTC_TURN_USERNAME`/`RTC_TURN_CREDENTIAL` appends a TURN entry, so credentials never
    live in client configuration.
  - Stale TURN credentials can be rotated server-side without redeploying the client.

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
| `message:new` | `{ messageId, senderId, ciphertext, iv, alg, createdAt, attachmentId? }` | Ciphertext delivered |
| `message:status` | `{ messageId, status }` | Status change (`acked`) |
| `friend:request` | request | New incoming request |
| `friend:accepted` | request | Request accepted (both users) |
| `friend:request:update` | request | Rejected/cancelled |
| `call:ring` | `{ callId, kind, caller: { id, username, displayName } }` | Callee is being called (`kind`: `audio`\|`video`) |
| `call:accepted` | `{ callId }` | Callee accepted (to caller) |
| `call:ended` | `{ callId, reason }` | `ended | declined | cancelled | timeout | peer_left` |
| `call:signal` | `{ callId, from, data: { type, sdp?, candidate? } }` | Relayed SDP/ICE from the peer |

**Client → server**

| Event | Payload | Meaning |
| --- | --- | --- |
| `message:ack` | `{ messageId }` | Recipient persisted the message; erases queued ciphertext, notifies sender |
| `sync:request` | — | Triggers a reconnect sync (`ack`'d) |
| `call:invite` | `{ callId, recipientId, kind? }` | Start a call (`kind` defaults to `audio`; `ack`: `{ ok, callId }` or `{ ok:false, error }`; rejects `not_friends`, `callee_offline`, `caller_busy`, `callee_busy`) |
| `call:accept` | `{ callId }` | Callee answers |
| `call:decline` | `{ callId }` | Callee declines while ringing |
| `call:cancel` | `{ callId }` | Caller cancels while ringing |
| `call:end` | `{ callId }` | Either participant hangs up |
| `call:connected` | `{ callId }` | Peer connection established (marks the call active) |
| `call:signal` | `{ callId, data }` | Send SDP/ICE to the peer (non-participants rejected) |

All call events re-check device authorization; a ring times out server-side after
`CALL_RING_TIMEOUT_MS` (45 s) and signaling expires after `CALL_SIGNALING_TTL_MS` (60 s).
