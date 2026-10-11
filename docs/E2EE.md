# End-to-End Encryption

> **Status: prototype. Not production-grade.** This document describes exactly what is
> implemented and every known limitation. Do not market this as secure messaging.

## What is implemented

All cryptography lives in `client/src/crypto` and uses the browser's Web Crypto API
(`crypto.subtle`). It has no React imports, so a future Flutter client could port or
replace it.

### Identity keys

- Each client generates an **ECDH key pair on NIST P-256** on first login.
- The **public key** is exported as SPKI and published on the account's bound device
  (`PUT /api/v1/devices/current/identity`). The server stores only public material.
- The **private key** is re-imported as **non-extractable** before storage and kept in
  IndexedDB. It never leaves the browser and is not persisted to `localStorage`.

### Session key derivation

For each 1:1 conversation:

1. `ECDH(privateKey, peerPublicKey)` → 256-bit shared secret.
2. `HKDF-SHA-256(sharedSecret, salt, info)` → **AES-256-GCM** key.
3. `salt` and `info` are bound to the ordered pair of user IDs, so both peers derive the
   same key and it is unique per conversation.

### Message encryption

- **AES-256-GCM** with a random 96-bit IV per message.
- **Additional authenticated data (AAD)** = `senderId|recipientId|messageId`, binding the
  ciphertext to its conversation context and preventing reflection/replay across ids.
- The server receives `{ ciphertext, iv, alg }` only.
- Decryption throws on any authentication failure. **There is no plaintext fallback**;
  undecryptable messages are stored/flagged as `Unable to decrypt`, never shown as
  plaintext.

### Integrity

GCM authentication tags reject tampered ciphertext and mismatched context. This is
covered by tests in `client/src/crypto/crypto.test.ts`:
derive-equal-keys, round-trip, ciphertext≠plaintext, tamper rejection, wrong-key rejection.

## Limitations (important)

1. **No forward secrecy.** Static-static ECDH means compromising a long-term private key
   compromises all past and future messages in that conversation.
2. **No post-compromise security.** There is no ratchet, so a compromised key is not
   healed by subsequent messages.
3. **No key verification ceremony.** Public keys are fetched from the server, which could
   theoretically substitute them (MITM). There is no safety-number / QR verification UI.
   The Profile panel shows a fingerprint for manual comparison only.
4. **One device per user account.** The server enforces a single active device (unique
   partial index) and binds each session to it. Replacing a device is explicit, revokes
   the previous device, and disconnects its sockets. The E2EE identity key lives on that
   device; multi-device key agreement and fan-out are out of scope.
5. **`identityPublicKey` is not signed**, so the server cannot be treated as untrusted
   for key distribution.
6. **No sealed sender / metadata protection.** The server knows who talks to whom and
   when, though not the message contents.
7. **AAD binds ids, not timestamps/nonces**, so an attacker who controls the queue could
   reorder messages (dedup by `messageId` limits replay).

## Recommendation

For production, replace the session layer with a vetted, audited protocol such as the
**Signal Protocol (X3DH + Double Ratchet)** via a maintained library, add key
verification, and add multi-device session management. The `ChatStorage` and
`crypto/` boundaries were designed so this can be swapped in without touching the UI.
