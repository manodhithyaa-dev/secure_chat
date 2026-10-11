import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { badRequest, conflict, unauthorized } from '../middleware/errors.js';
import {
  isValidUsername,
  isValidDisplayName,
  isValidPassword,
} from '../middleware/validate.js';

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export function registerUser({ username, displayName, password }) {
  const normalized = typeof username === 'string' ? username.trim().toLowerCase() : username;
  if (!isValidUsername(normalized)) {
    throw badRequest(
      'username must be 3-32 chars, lowercase letters, numbers or underscore',
      { field: 'username' },
    );
  }
  if (!isValidDisplayName(displayName)) {
    throw badRequest('displayName must be 1-64 chars', { field: 'displayName' });
  }
  if (!isValidPassword(password)) {
    throw badRequest('password must be at least 8 characters', { field: 'password' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalized);
  if (existing) {
    throw conflict('username is already taken', { field: 'username' });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, normalized, displayName.trim(), hashPassword(password), now);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return publicUser(row);
}

export function loginUser({ username, password }) {
  const normalized = typeof username === 'string' ? username.trim().toLowerCase() : username;
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(normalized);
  if (!row || !verifyPassword(password || '', row.password_hash)) {
    throw unauthorized('invalid username or password');
  }
  return publicUser(row);
}

export function getUserById(id) {
  const db = getDb();
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}
