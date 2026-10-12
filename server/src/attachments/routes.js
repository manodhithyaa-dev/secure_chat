import fs from 'node:fs';
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import {
  createAttachment,
  deleteAttachment,
  openAttachmentForDownload,
  streamAttachmentData,
} from './service.js';

const router = Router();
router.use(authMiddleware);

/**
 * Two-step upload keeps large binary payloads out of Express's JSON parsing
 * and avoids the multipart parsing dependency:
 *   1. POST /attachments        → JSON ticket with metadata, returns an opaque id
 *   2. PUT /attachments/:id/data → streamed raw ciphertext (octet-stream)
 * The id is then referenced from POST /messages, which links the attachment to
 * the message and grants the recipient read access inside the same transaction.
 */
router.post(
  '/attachments',
  asyncHandler((req, res) => {
    res.status(201).json({ attachment: createAttachment(req.user.id, req.body || {}) });
  }),
);

router.put(
  '/attachments/:id/data',
  asyncHandler(async (req, res) => {
    const attachment = await streamAttachmentData(req.params.id, req.user.id, req);
    res.status(200).json({ ok: true, attachment });
  }),
);

router.get(
  '/attachments/:id/data',
  asyncHandler(async (_req, res) => {
    const { row, filePath, safeName } = openAttachmentForDownload(
      _req.params.id,
      _req.user.id,
    );
    res.setHeader('Content-Type', `${row.contentType}; charset=binary`);
    res.setHeader('Content-Length', row.cipherSize);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    );
    await pipeline(fs.createReadStream(filePath), res);
  }),
);

// Sender-only deletion. Used to discard an unsent/cancelled upload.
router.delete(
  '/attachments/:id',
  asyncHandler((req, res) => {
    res.json(deleteAttachment(req.params.id, req.user.id));
  }),
);

export default router;