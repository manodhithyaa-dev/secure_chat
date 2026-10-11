import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { badRequest, forbidden, notFound } from '../middleware/errors.js';

const ALLOWED_ALGORITHMS = new Set(['ECDH-P256', 'ECDH-P384']);

function validateSigningPublicKey(signingPublicKey) {
  if (typeof signingPublicKey !== 'string' || signingPublicKey.length < 16 || signingPublicKey.length > 4096) {
    throw badRequest('device.signingPublicKey is required', { field: 'signingPublicKey' });
  }
  try {
    crypto.createPublicKey({
      key: Buffer.from(signingPublicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw badRequest('device.signingPublicKey must be a valid SPKI public key', {
      field: 'signingPublicKey',
    });
  }
}

function validateClientDeviceId(clientDeviceId) {
  if (typeof clientDeviceId !== 'string' || clientDeviceId.length < 8 || clientDeviceId.length > 128) {
    throw badRequest('device.clientDeviceId is required', { field: 'clientDeviceId' });
  }
}

export function publicDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    clientDeviceId: row.client_device_id ?? null,
    identityPublicKey: row.identity_public_key ?? null,
    algorithm: row.algorithm ?? null,
    hasSigningKey: Boolean(row.signing_public_key),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

/** The single active device for an account, or null. */
export function getActiveDeviceRow(userId) {
  const db = getDb();
  return (
    db
      .prepare(
        'SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get(userId) || null
  );
}

export function getDeviceRow(userId, deviceId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!row) return null;
  if (row.user_id !== userId) return null;
  return row;
}

/**
 * Insert the one active device for an account. Assumes the caller has already
 * verified that no other active device exists and holds the surrounding
 * transaction; a partial unique index is the final backstop.
 */
export function insertDevice(userId, { clientDeviceId, name, signingPublicKey }) {
  validateClientDeviceId(clientDeviceId);
  validateSigningPublicKey(signingPublicKey);
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO devices
       (id, user_id, name, client_device_id, identity_public_key, algorithm, signing_public_key, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
  ).run(id, userId, (name || 'Web browser').slice(0, 64), clientDeviceId, signingPublicKey, now);
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

/**
 * Legacy accounts predate device proofs: their active device has no signing
 * key. Upgrade it in place, binding it to the proof key supplied by the client
 * that is signing in. Returns the row.
 */
export function upgradeLegacyDevice(deviceRow, { clientDeviceId, name, signingPublicKey }) {
  validateClientDeviceId(clientDeviceId);
  validateSigningPublicKey(signingPublicKey);
  const db = getDb();
  db.prepare(
    `UPDATE devices
        SET client_device_id = ?, name = ?, signing_public_key = ?, last_seen_at = ?
      WHERE id = ?`,
  ).run(clientDeviceId, (name || deviceRow.name).slice(0, 64), signingPublicKey, Date.now(), deviceRow.id);
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceRow.id);
}

export function revokeDeviceRow(deviceId) {
  const db = getDb();
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    Date.now(),
    deviceId,
  );
}

export function touchDevice(deviceId) {
  getDb().prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), deviceId);
}

/**
 * Attach (or refresh) the account's E2EE identity public key on the caller's
 * bound device. This is the only place the encryption key is published.
 */
export function setIdentityKey(userId, deviceId, { identityPublicKey, algorithm }) {
  if (typeof identityPublicKey !== 'string' || identityPublicKey.length < 16) {
    throw badRequest('identityPublicKey is required', { field: 'identityPublicKey' });
  }
  if (!ALLOWED_ALGORITHMS.has(algorithm)) {
    throw badRequest(`algorithm must be one of ${[...ALLOWED_ALGORITHMS].join(', ')}`, {
      field: 'algorithm',
    });
  }
  const row = getDeviceRow(userId, deviceId);
  if (!row) throw notFound('device not found');
  if (row.revoked_at) throw forbidden('device is revoked');
  const db = getDb();
  db.prepare(
    'UPDATE devices SET identity_public_key = ?, algorithm = ? WHERE id = ?',
  ).run(identityPublicKey, algorithm, deviceId);
  return publicDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId));
}

export function listDevices(userId, { includeRevoked = false } = {}) {
  const db = getDb();
  const rows = includeRevoked
    ? db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId)
    : db
        .prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at')
        .all(userId);
  return rows.map(publicDevice);
}

export function revokeDevice(userId, deviceId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!row) throw notFound('device not found');
  if (row.user_id !== userId) throw forbidden('not your device');
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), deviceId);
  return publicDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId));
}

/**
 * Public key bundle for a user's active devices that have published an
 * encryption key. Used by peers to derive a shared secret. Public material only.
 */
export function getPublicKeyBundle(targetUserId, requesterId) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(targetUserId);
  if (!user) throw notFound('user not found');
  const devices = listDevices(targetUserId).filter((d) => d.identityPublicKey && d.algorithm);
  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    requestedBy: requesterId,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      identityPublicKey: d.identityPublicKey,
      algorithm: d.algorithm,
    })),
  };
}
