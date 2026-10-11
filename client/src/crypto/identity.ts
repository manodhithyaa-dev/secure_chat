import { base64ToBytes, bytesToBase64 } from './encoding';

export const ECDH_ALGORITHM = 'ECDH-P256' as const;

export interface GeneratedIdentity {
  publicKeyBase64: string;
  privateKey: CryptoKey;
  algorithm: typeof ECDH_ALGORITHM;
}

/**
 * Generate a fresh identity key pair.
 *
 * The private key is re-imported as NON-extractable before it is returned, so
 * the exported PKCS#8 material only exists transiently in memory. The public
 * key is exported as SPKI for publication to the server.
 */
export async function generateIdentity(): Promise<GeneratedIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKeySpki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const privateKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyPkcs8,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );

  return {
    publicKeyBase64: bytesToBase64(new Uint8Array(publicKeySpki)),
    privateKey,
    algorithm: ECDH_ALGORITHM,
  };
}

/** Import a peer's published public key (SPKI base64). */
export async function importPeerPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKeyBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}
