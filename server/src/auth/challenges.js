import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import config from '../config.js';
import { badRequest, deviceNotAuthorized } from '../middleware/errors.js';

const CHALLENGE_BYTES = 32;

/**
 * Issue a short-lived, single-use nonce. The client signs it with the private
 * half of its device key to prove possession; the server stores only the nonce.
 */
export function createChallenge(username) {
  const db = getDb();
  const id = crypto.randomUUID();
  const challenge = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');
  const now = Date.now();
  const expiresAt = now + config.challengeTtlMs;
  db.prepare(
    `INSERT INTO auth_challenges (id, challenge, username, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, challenge, username ?? null, now, expiresAt);
  return { id, challenge, expiresAt };
}

/**
 * Atomically consume a challenge (single use, unexpired) and return its nonce.
 * Rejects reuse, expiry and unknown ids.
 */
export function consumeChallenge(id) {
  if (typeof id !== 'string' || !id) {
    throw badRequest('proof is required', { field: 'proof' });
  }
  const db = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(id);
  if (!row || row.used_at || row.expires_at <= now) {
    throw deviceNotAuthorized('challenge is missing, expired or already used');
  }
  const result = db
    .prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .run(now, id);
  if (result.changes === 0) {
    throw deviceNotAuthorized('challenge is missing, expired or already used');
  }
  return row.challenge;
}

/** Best-effort cleanup of expired/used challenge rows. */
export function cleanupChallenges() {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM auth_challenges WHERE expires_at < ? OR used_at IS NOT NULL')
    .run(Date.now());
  return result.changes;
}

function importSigningKey(signingPublicKey) {
  if (typeof signingPublicKey !== 'string' || signingPublicKey.length < 16) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.from(signingPublicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/**
 * Verify an ECDSA P-256 / SHA-256 proof-of-possession over a challenge string.
 * Returns false for any malformed input rather than throwing.
 */
export function verifyDeviceProof({ signingPublicKey, challenge, signature }) {
  if (typeof challenge !== 'string' || typeof signature !== 'string') return false;
  const key = importSigningKey(signingPublicKey);
  if (!key) return false;
  // A raw ECDSA (r||s) WebCrypto signature is 64 bytes for P-256; allow x9.62 too.
  if (signature.length > 512) return false;
  const data = Buffer.from(challenge, 'utf8');
  const sig = Buffer.from(signature, 'base64');
  try {
    return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    try {
      return crypto.verify('sha256', data, key, sig);
    } catch {
      return false;
    }
  }
}
