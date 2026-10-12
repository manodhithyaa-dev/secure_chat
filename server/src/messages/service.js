import { getDb, withTransaction } from '../database/db.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';
import { areFriends } from '../friends/service.js';
import { linkAttachmentToMessage } from '../attachments/service.js';
import config from '../config.js';

const ALLOWED_ALGORITHMS = new Set(['AES-256-GCM']);
const MAX_CIPHERTEXT_BYTES = 128 * 1024;

function validateMessageInput(input) {
  const { messageId, recipientId, ciphertext, iv, alg } = input || {};
  if (typeof messageId !== 'string' || messageId.length < 8 || messageId.length > 128) {
    throw badRequest('messageId is required', { field: 'messageId' });
  }
  if (typeof recipientId !== 'string' || recipientId.length < 8) {
    throw badRequest('recipientId is required', { field: 'recipientId' });
  }
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw badRequest('ciphertext is required', { field: 'ciphertext' });
  }
  if (Buffer.byteLength(ciphertext, 'utf8') > MAX_CIPHERTEXT_BYTES) {
    throw badRequest('ciphertext too large', { field: 'ciphertext' });
  }
  if (typeof iv !== 'string' || iv.length === 0) {
    throw badRequest('iv is required', { field: 'iv' });
  }
  if (!ALLOWED_ALGORITHMS.has(alg)) {
    throw badRequest(`alg must be one of ${[...ALLOWED_ALGORITHMS].join(', ')}`, { field: 'alg' });
  }
}

function publicMessage(row) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    deviceId: row.device_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    alg: row.alg,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
    ackedAt: row.acked_at,
    attachmentId: row.attachment_id || null,
  };
}

/**
 * Persist a ciphertext message for a recipient. Uses the message_id primary
 * key to guarantee idempotency: retries with the same id never duplicate.
 */
export function submitMessage(senderId, input) {
  validateMessageInput(input);
  const { messageId, recipientId, ciphertext, iv, alg, deviceId, attachmentId } = input;

  if (senderId === recipientId) {
    throw badRequest('cannot message yourself');
  }
  if (!areFriends(senderId, recipientId)) {
    throw forbidden('you can only message accepted friends');
  }

  const db = getDb();
  const now = Date.now();
  const expiresAt = now + config.messageTtlMs;

  return withTransaction((tx) => {
    const existing = tx.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
    if (existing) {
      if (existing.sender_id !== senderId) {
        throw conflict('message id is already used by another sender');
      }
      return { message: publicMessage(existing), duplicate: true };
    }

    tx.prepare(
      `INSERT INTO messages
         (message_id, sender_id, recipient_id, device_id, ciphertext, iv, alg, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(messageId, senderId, recipientId, deviceId || null, ciphertext, iv, alg, now, expiresAt);

    // Link the (already uploaded) ciphertext attachment to this message inside
    // the same transaction: either both commit or neither does.
    if (attachmentId) {
      linkAttachmentToMessage({ attachmentId, senderId, recipientId, messageId, expiresAt });
    }

    return {
      message: publicMessage(
        tx
          .prepare(
            `SELECT m.*, a.id AS attachment_id
             FROM messages m LEFT JOIN attachments a ON a.message_id = m.message_id
             WHERE m.message_id = ?`,
          )
          .get(messageId),
      ),
      duplicate: false,
    };
  });
}

export function getMessage(messageId) {
  return getDb().prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
}

export function getMessageStatus(messageId, requesterId) {
  const row = getMessage(messageId);
  if (!row) return { messageId, status: 'expired' };
  if (row.sender_id !== requesterId && row.recipient_id !== requesterId) {
    throw forbidden('not your message');
  }
  return {
    messageId: row.message_id,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    ackedAt: row.acked_at,
    expiresAt: row.expires_at,
  };
}

export function getAttachmentIdForMessage(messageId) {
  const row = getDb()
    .prepare('SELECT id FROM attachments WHERE message_id = ?')
    .get(messageId);
  return row ? row.id : null;
}

/** Messages awaiting recipient persistence acknowledgement. */
export function getPendingForRecipient(recipientId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.*, a.id AS attachment_id
       FROM messages m
       LEFT JOIN attachments a ON a.message_id = m.message_id
       WHERE m.recipient_id = ? AND m.status IN ('queued', 'delivered')
         AND m.expires_at > ?
       ORDER BY m.created_at ASC`,
    )
    .all(recipientId, Date.now());
  return rows.map(publicMessage);
}

/** Mark transport delivery (recipient socket received the ciphertext). */
export function markDelivered(messageId) {
  const db = getDb();
  db.prepare(
    `UPDATE messages SET status = 'delivered', delivered_at = ?
     WHERE message_id = ? AND status = 'queued'`,
  ).run(Date.now(), messageId);
  return getMessage(messageId);
}

/**
 * Recipient confirms the ciphertext was persisted locally. Only now is the
 * queued ciphertext erased (the payload is cleared; minimal metadata is kept
 * so the sender can observe final delivery status).
 */
export function acknowledgeMessage(messageId, recipientId) {
  const row = getMessage(messageId);
  if (!row) {
    // Already acked and purged, or never existed. Treat acked-and-gone as ok.
    return { messageId, status: 'acked', senderId: null };
  }
  if (row.recipient_id !== recipientId) {
    throw forbidden('only the recipient can acknowledge');
  }
  if (row.status === 'acked') {
    return { messageId, status: 'acked', senderId: row.sender_id };
  }
  getDb()
    .prepare(
      `UPDATE messages
         SET status = 'acked', acked_at = ?, ciphertext = NULL, iv = NULL
       WHERE message_id = ?`,
    )
    .run(Date.now(), messageId);
  return { messageId, status: 'acked', senderId: row.sender_id };
}

export function cleanupExpiredMessages() {
  const db = getDb();
  const now = Date.now();
  const undelivered = db
    .prepare(`DELETE FROM messages WHERE status <> 'acked' AND expires_at < ?`)
    .run(now);
  const acked = db
    .prepare(`DELETE FROM messages WHERE status = 'acked' AND acked_at IS NOT NULL AND acked_at < ?`)
    .run(now - config.messageTtlMs);
  return undelivered.changes + acked.changes;
}
