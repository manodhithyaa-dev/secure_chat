import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import config from '../config.js';

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(userId, deviceId = null) {
  const db = getDb();
  const token = generateSessionToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;
  db.prepare(
    `INSERT INTO sessions (id, user_id, device_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, deviceId, hashToken(token), now, expiresAt);
  return { id, token, expiresAt };
}

export function findValidSession(token) {
  if (!token || typeof token !== 'string') return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(hashToken(token), Date.now());
  return row || null;
}

export function revokeSession(token) {
  if (!token) return false;
  const db = getDb();
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(Date.now(), hashToken(token));
  return result.changes > 0;
}

export function revokeAllSessions(userId) {
  const db = getDb();
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
    Date.now(),
    userId,
  );
}

export function cleanupExpiredSessions() {
  const db = getDb();
  const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return result.changes;
}
