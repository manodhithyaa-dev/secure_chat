import { deriveSessionKey } from './session';

const sessionCache = new Map<string, CryptoKey>();

function cacheKey(a: string, b: string, peerPublicKeyBase64: string): string {
  return [a, b].sort().join('|') + '|' + peerPublicKeyBase64.slice(-24);
}

/**
 * Get (and memoize) the AES-GCM session key for a conversation.
 * Independent from React so it can be reused by other clients (e.g. Flutter).
 */
export async function getSessionKey(params: {
  myUserId: string;
  myPrivateKey: CryptoKey;
  peerUserId: string;
  peerPublicKeyBase64: string;
}): Promise<CryptoKey> {
  const key = cacheKey(params.myUserId, params.peerUserId, params.peerPublicKeyBase64);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  const derived = await deriveSessionKey(
    params.myPrivateKey,
    params.peerPublicKeyBase64,
    params.myUserId,
    params.peerUserId,
  );
  sessionCache.set(key, derived);
  return derived;
}

export function clearSessionCache(): void {
  sessionCache.clear();
}

export * from './identity';
export * from './session';
export * from './message';
export * from './encoding';
export * from './device';
