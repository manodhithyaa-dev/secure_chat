import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler, badRequest } from '../middleware/errors.js';
import {
  acknowledgeMessage,
  getPendingForRecipient,
  getMessageStatus,
  markDelivered,
  submitMessage,
} from '../messages/service.js';
import { emitToUser, isUserOnline } from '../sockets/emitter.js';

const router = Router();
router.use(authMiddleware);

router.post(
  '/messages',
  asyncHandler((req, res) => {
    const result = submitMessage(req.user.id, req.body || {});
    const { message } = result;
    let status = message.status;

    // Attempt real-time delivery. This is a transport delivery, not the
    // recipient's persistence acknowledgement.
    if (status !== 'acked' && isUserOnline(message.recipientId)) {
      emitToUser(message.recipientId, 'message:new', {
        messageId: message.messageId,
        senderId: message.senderId,
        ciphertext: message.ciphertext,
        iv: message.iv,
        alg: message.alg,
        createdAt: message.createdAt,
        attachmentId: message.attachmentId,
      });
      markDelivered(message.messageId);
      status = 'delivered';
    }

    res.status(201).json({
      messageId: message.messageId,
      status,
      queued: status === 'queued',
      duplicate: Boolean(result.duplicate),
    });
  }),
);

router.get(
  '/messages/pending',
  asyncHandler((req, res) => {
    res.json({ messages: getPendingForRecipient(req.user.id) });
  }),
);

router.post(
  '/messages/ack',
  asyncHandler((req, res) => {
    const { messageId } = req.body || {};
    if (typeof messageId !== 'string' || !messageId) {
      throw badRequest('messageId is required', { field: 'messageId' });
    }
    const result = acknowledgeMessage(messageId, req.user.id);
    if (result.senderId) {
      emitToUser(result.senderId, 'message:status', {
        messageId: result.messageId,
        status: 'acked',
      });
    }
    res.json({ ok: true, messageId: result.messageId, status: result.status });
  }),
);

router.get(
  '/messages/status/:messageId',
  asyncHandler((req, res) => {
    res.json(getMessageStatus(req.params.messageId, req.user.id));
  }),
);

export default router;
