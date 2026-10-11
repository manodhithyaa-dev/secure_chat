import { utf8Encode } from './encoding';
import { importPeerPublicKey } from './identity';

export const SESSION_KDF_INFO = 'SecureChat-v1-session';

/**
 * Derive a symmetric AES-256-GCM key for a 1:1 conversation.
 *
 * Design: static ECDH between the two identities, followed by HKDF-SHA-256.
 * The `info` and `salt` bind the key to the ordered pair of user IDs so both
 * peers derive the same key and it cannot be reused across conversations.
 *
 * LIMITATION: static static ECDH provides no forward secrecy and no
 * post-compromise security (no ratchet). This is acceptable for the MVP test
 * scope only. See docs/E2EE.md.
 */
export async function deriveSessionKey(
  myPrivateKey: CryptoKey,
  peerPublicKeyBase64: string,
  myUserId: string,
  peerUserId: string,
): Promise<CryptoKey> {
  const peerPublicKey = await importPeerPublicKey(peerPublicKeyBase64);

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    256,
  );

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  const pairId = [myUserId, peerUserId].sort().join('|');
  const info = utf8Encode(`${SESSION_KDF_INFO}|${pairId}`);
  const salt = utf8Encode(pairId);

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
