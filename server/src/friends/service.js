import crypto from 'node:crypto';
import { getDb, withTransaction } from '../database/db.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';

export function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

export function areFriends(a, b) {
  if (!a || !b || a === b) return false;
  const [x, y] = orderedPair(a, b);
  const db = getDb();
  return !!db
    .prepare('SELECT 1 FROM friendships WHERE user_a_id = ? AND user_b_id = ?')
    .get(x, y);
}

export function getFriendship(a, b) {
  const [x, y] = orderedPair(a, b);
  const db = getDb();
  return db.prepare('SELECT * FROM friendships WHERE user_a_id = ? AND user_b_id = ?').get(x, y);
}

export function listFriends(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name,
              CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END AS friend_id,
              f.created_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END
       WHERE f.user_a_id = ? OR f.user_b_id = ?
       ORDER BY u.display_name COLLATE NOCASE ASC`,
    )
    .all(userId, userId, userId, userId);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    friendsSince: r.created_at,
  }));
}

export function getPendingRequestBetween(a, b) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM friend_requests
       WHERE status = 'pending'
         AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
       LIMIT 1`,
    )
    .get(a, b, b, a);
}

export function sendFriendRequest(fromUserId, toUsername) {
  const db = getDb();
  const target = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(toUsername || '').trim().toLowerCase());

  if (!target) {
    throw notFound('user not found');
  }
  if (target.id === fromUserId) {
    throw badRequest('you cannot add yourself');
  }
  if (areFriends(fromUserId, target.id)) {
    throw conflict('you are already friends');
  }
  if (getPendingRequestBetween(fromUserId, target.id)) {
    throw conflict('a friend request is already pending');
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, fromUserId, target.id, now);

  return db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(id);
}

export function requestWithUsers(row) {
  if (!row) return null;
  const db = getDb();
  const from = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(row.from_user_id);
  const to = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(row.to_user_id);
  const map = (u) => (u ? { id: u.id, username: u.username, displayName: u.display_name } : null);
  return {
    id: row.id,
    status: row.status,
    from: map(from),
    to: map(to),
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

export function listIncoming(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM friend_requests WHERE to_user_id = ? AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(userId);
  return rows.map(requestWithUsers);
}

export function listOutgoing(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM friend_requests WHERE from_user_id = ? AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(userId);
  return rows.map(requestWithUsers);
}

export function getRequest(id) {
  return getDb().prepare('SELECT * FROM friend_requests WHERE id = ?').get(id);
}

export function acceptFriendRequest(requestId, userId) {
  const request = getRequest(requestId);
  if (!request) throw notFound('friend request not found');
  if (request.to_user_id !== userId) throw forbidden('not your friend request');
  if (request.status !== 'pending') throw conflict('request is no longer pending');

  return withTransaction((db) => {
    const now = Date.now();
    db.prepare(`UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?`).run(
      now,
      requestId,
    );
    const [x, y] = orderedPair(request.from_user_id, request.to_user_id);
    db.prepare(
      `INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, created_at) VALUES (?, ?, ?)`,
    ).run(x, y, now);
    return requestWithUsers(getRequest(requestId));
  });
}

export function rejectFriendRequest(requestId, userId) {
  const request = getRequest(requestId);
  if (!request) throw notFound('friend request not found');
  if (request.to_user_id !== userId) throw forbidden('not your friend request');
  if (request.status !== 'pending') throw conflict('request is no longer pending');
  getDb()
    .prepare(`UPDATE friend_requests SET status = 'rejected', responded_at = ? WHERE id = ?`)
    .run(Date.now(), requestId);
  return requestWithUsers(getRequest(requestId));
}

export function cancelFriendRequest(requestId, userId) {
  const request = getRequest(requestId);
  if (!request) throw notFound('friend request not found');
  if (request.from_user_id !== userId) throw forbidden('not your friend request');
  if (request.status !== 'pending') throw conflict('request is no longer pending');
  getDb()
    .prepare(`UPDATE friend_requests SET status = 'cancelled', responded_at = ? WHERE id = ?`)
    .run(Date.now(), requestId);
  return requestWithUsers(getRequest(requestId));
}

export function searchUsers(query, currentUserId) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 1) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, username, display_name FROM users
       WHERE username LIKE ? AND id <> ?
       ORDER BY username ASC
       LIMIT 20`,
    )
    .all(`%${q}%`, currentUserId);

  return rows.map((r) => {
    const friends = areFriends(currentUserId, r.id);
    const pending = getPendingRequestBetween(currentUserId, r.id);
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      relationship: friends ? 'friends' : pending ? 'pending' : 'none',
    };
  });
}
