import { storage } from '../../storage/repositories';
import { generateDeviceSigningKey } from '../../crypto/device';
import type { DeviceAuthRecord } from '../../types';

// Guards against concurrent generation (e.g. React StrictMode double-invokes).
let inFlight: Promise<DeviceAuthRecord> | null = null;

/** A short human-readable label for this browser, shown in the device list. */
export function describeDevice(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Web browser';
}

/**
 * Load this browser's device credential, generating a stable device id and a
 * non-extractable proof key on first use. Persisted in IndexedDB so the same
 * installation is recognizable across reloads and logins.
 */
export async function ensureDeviceAuth(): Promise<DeviceAuthRecord> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const existing = await storage.getDeviceAuth();
    if (existing) return existing;

    const generated = await generateDeviceSigningKey();
    const record: DeviceAuthRecord = {
      id: 'current',
      clientDeviceId: crypto.randomUUID(),
      signingPublicKey: generated.signingPublicKeyBase64,
      privateKey: generated.privateKey,
      createdAt: Date.now(),
    };
    await storage.saveDeviceAuth(record);
    return record;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}
