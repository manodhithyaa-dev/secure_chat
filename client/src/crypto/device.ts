import { bytesToBase64, utf8Encode } from './encoding';

export const DEVICE_SIGNING_ALGORITHM = 'ECDSA-P256' as const;

export interface GeneratedDeviceKey {
  signingPublicKeyBase64: string;
  privateKey: CryptoKey;
}

/**
 * Generate the device's proof-of-possession key pair.
 *
 * The private key is NON-extractable: it can be stored in IndexedDB and used to
 * sign challenges, but its raw bytes can never be read out. Only the public
 * half is published to the server, which uses it to verify login proofs.
 */
export async function generateDeviceSigningKey(): Promise<GeneratedDeviceKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    signingPublicKeyBase64: bytesToBase64(new Uint8Array(spki)),
    privateKey: pair.privateKey,
  };
}

/** Sign a server-issued challenge string with the device's private key. */
export async function signChallenge(privateKey: CryptoKey, challenge: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    utf8Encode(challenge),
  );
  return bytesToBase64(new Uint8Array(signature));
}
