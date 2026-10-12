import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import config from '../config.js';
import { getDb } from '../database/db.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  payloadTooLarge,
} from '../middleware/errors.js';

const ID_HEX = /^[0-9a-f]{32}$/;
const ALLOWED_KINDS = new Set(['file', 'image', 'audio']);
const MAX_NAME_BYTES = 255;
const MIN_UPLOAD_BYTES = 16; // GCM tag + header minimum; a real encrypted file is larger.

function filePathFor(id) {
  return path.join(config.attachmentDir, id);
}

function isValidId(id) {
  return typeof id === 'string' && ID_HEX.test(id);
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name
    .replace(/[\\/\u0000-\u001F\u007F/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || Buffer.byteLength(cleaned, 'utf8') > MAX_NAME_BYTES) return null;
  return cleaned;
}

function publicAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id || null,
    messageId: row.message_id || null,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    plainSize: row.plain_size,
    cipherSize: row.cipher_size,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function getAttachmentRow(id) {
  if (!isValidId(id)) return null;
  return getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

/** Total ciphertext bytes currently stored (non-expired) for a user. */
export function totalActiveBytes(userId) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(cipher_size), 0) AS total FROM attachments
       WHERE sender_id = ? AND expires_at > ?`,
    )
    .get(userId, Date.now());
  return Number(row.total || 0);
}

/**
 * Create an upload ticket. The ciphertext itself is streamed separately via
 * PUT /attachments/:id/data so large files never sit in an Express body.
 */
export function createAttachment(senderId, input) {
  const body = input || {};
  const kind = body.kind;
  if (!ALLOWED_KINDS.has(kind)) {
    throw badRequest('kind must be one of file, image, audio', { field: 'kind' });
  }
  const name = sanitizeName(body.name);
  if (!name) {
    throw badRequest('name is required and must be <= 255 bytes', { field: 'name' });
  }
  const plainSize = Number.isSafeInteger(body.plainSize) ? body.plainSize : -1;
  const cipherSize = Number.isSafeInteger(body.cipherSize) ? body.cipherSize : -1;
  if (plainSize < 0 || plainSize > config.attachmentMaxBytes) {
    throw badRequest('plainSize must be between 0 and the maximum attachment size', {
      field: 'plainSize',
    });
  }
  if (cipherSize < MIN_UPLOAD_BYTES || cipherSize > config.attachmentMaxBytes) {
    throw badRequest('cipherSize must be within the maximum attachment size', {
      field: 'cipherSize',
    });
  }

  if (totalActiveBytes(senderId) + cipherSize > config.attachmentQuotaBytes) {
    throw new AppError(413, 'quota_exceeded', 'Attachment quota exceeded');
  }

  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO attachments
       (id, sender_id, kind, name, content_type, plain_size, cipher_size, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    senderId,
    kind,
    name,
    body.contentType || 'application/octet-stream',
    plainSize,
    cipherSize,
    now,
    now + config.attachmentPendingTtlMs,
  );

  return publicAttachment(getAttachmentRow(id));
}

/**
 * Stream the raw (already encrypted) attachment body to disk. Never buffers
 * the whole upload in memory; enforces size and quota while streaming.
 */
export async function streamAttachmentData(id, senderId, req) {
  if (!isValidId(id)) throw notFound('attachment not found');
  const row = getAttachmentRow(id);
  if (!row) throw notFound('attachment not found');
  if (row.sender_id !== senderId) throw forbidden('not your attachment');

  const declaredLength = Number(req.headers['content-length']) || 0;
  if (declaredLength > config.attachmentMaxBytes) {
    throw payloadTooLarge(`upload exceeds maximum of ${config.attachmentMaxBytes} bytes`);
  }

  const finalPath = filePathFor(id);
  const partPath = `${finalPath}.part`;
  await fs.promises.mkdir(config.attachmentDir, { recursive: true });

  let received = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > config.attachmentMaxBytes) {
        return cb(payloadTooLarge(`upload exceeds maximum of ${config.attachmentMaxBytes} bytes`));
      }
      cb(null, chunk);
    },
  });

  const out = fs.createWriteStream(partPath, { flags: 'w' });
  try {
    await pipeline(req, counter, out);
  } catch (e) {
    await fs.promises.unlink(partPath).catch(() => {});
    throw e;
  }

  if (received < MIN_UPLOAD_BYTES) {
    await fs.promises.unlink(partPath).catch(() => {});
    throw badRequest('upload is too small to be a valid encrypted attachment');
  }

  // Re-check quota against the ACTUAL stored size (ticket size was an estimate).
  const quota = totalActiveBytes(senderId) + received - (row.cipher_size || 0);
  if (quota > config.attachmentQuotaBytes) {
    await fs.promises.unlink(partPath).catch(() => {});
    throw new AppError(413, 'quota_exceeded', 'Attachment quota exceeded');
  }

  await fs.promises.rename(partPath, finalPath);
  getDb()
    .prepare(
      `UPDATE attachments
         SET status = 'ready', cipher_size = ?, content_type = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(received, row.content_type, id);

  return publicAttachment(getAttachmentRow(id));
}

const CONTENT_DISPOSITION_SAFE = /[\r\n]/g;

/**
 * Authorize a download. Only the sender or (once linked) the recipient may
 * fetch, and only while the record has not expired. Returns the row and the
 * absolute file path.
 */
export function openAttachmentForDownload(id, requesterId) {
  const row = getAttachmentRow(id);
  if (!row) throw notFound('attachment not found');
  if (row.status !== 'ready') throw notFound('attachment not available');
  if (row.expires_at <= Date.now()) throw notFound('attachment expired');
  if (row.sender_id !== requesterId && row.recipient_id !== requesterId) {
    throw forbidden('not your attachment');
  }
  const filePath = filePathFor(id);
  if (!fs.existsSync(filePath)) {
    console.warn(`[attachments] missing blob for ${id}`);
    throw notFound('attachment data is unavailable');
  }
  const safeName = (row.name || 'file').replace(CONTENT_DISPOSITION_SAFE, ' ');
  return { row: publicAttachment(row), filePath, safeName };
}

/** Sender may delete an attachment (e.g. a cancelled upload). Idempotent. */
export function deleteAttachment(id, senderId) {
  const row = getAttachmentRow(id);
  if (!row) return { ok: true, deleted: false };
  if (row.sender_id !== senderId) throw forbidden('not your attachment');
  getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id);
  fs.rmSync(filePathFor(id), { force: true });
  return { ok: true, deleted: true };
}

/**
 * Bind a ready attachment to a delivered message. This is what grants the
 * recipient read access and pins expiry to the message lifecycle. Must run
 * inside the message submission transaction.
 */
export function linkAttachmentToMessage({ attachmentId, senderId, recipientId, messageId, expiresAt }) {
  if (!isValidId(attachmentId)) {
    throw badRequest('attachmentId is required', { field: 'attachmentId' });
  }
  const row = getAttachmentRow(attachmentId);
  if (!row) throw badRequest('attachment not found', { field: 'attachmentId' });
  if (row.sender_id !== senderId) throw forbidden('not your attachment');
  if (row.status !== 'ready') {
    throw badRequest('attachment is not ready yet', { field: 'attachmentId' });
  }
  if (row.message_id && row.message_id !== messageId) {
    throw conflict('attachment is already linked to another message', { field: 'attachmentId' });
  }
  getDb()
    .prepare(
      `UPDATE attachments
         SET recipient_id = ?, message_id = ?, expires_at = ?
       WHERE id = ?`,
    )
    .run(recipientId, messageId, expiresAt, attachmentId);
  return publicAttachment(getAttachmentRow(attachmentId));
}

/**
 * Garbage collect expired/pending-too-long attachments (row + blob) and
 * reconcile rows whose blob no longer exists. Idempotent.
 */
export function cleanupExpiredAttachments() {
  const db = getDb();
  const now = Date.now();
  const expired = db
    .prepare(
      `SELECT id FROM attachments
       WHERE expires_at <= ? OR (status = 'pending' AND created_at < ?)`,
    )
    .all(now, now - config.attachmentPendingTtlMs);

  for (const { id } of expired) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    fs.rmSync(filePathFor(id), { force: true });
  }

  let reconciled = 0;
  if (fs.existsSync(config.attachmentDir)) {
    for (const row of db.prepare(`SELECT id, status FROM attachments WHERE status = 'ready'`).all()) {
      if (!fs.existsSync(filePathFor(row.id))) {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
        reconciled += 1;
      }
    }
  }

  return expired.length + reconciled;
}

export const attachmentService = {
  createAttachment,
  streamAttachmentData,
  openAttachmentForDownload,
  deleteAttachment,
  linkAttachmentToMessage,
  cleanupExpiredAttachments,
  totalActiveBytes,
};

export default attachmentService;