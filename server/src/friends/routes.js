import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler, badRequest } from '../middleware/errors.js';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  listFriends,
  listIncoming,
  listOutgoing,
  rejectFriendRequest,
  sendFriendRequest,
} from '../friends/service.js';
import { emitToUser, isUserOnline } from '../sockets/emitter.js';

const router = Router();
router.use(authMiddleware);

router.get(
  '/friends',
  asyncHandler((req, res) => {
    res.json({ friends: listFriends(req.user.id) });
  }),
);

router.post(
  '/friend-requests',
  asyncHandler((req, res) => {
    const { username } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
      throw badRequest('username is required', { field: 'username' });
    }
    const request = sendFriendRequest(req.user.id, username);
    const payload = {
      id: request.id,
      status: request.status,
      from: { id: request.from_user_id },
      to: { id: request.to_user_id },
      createdAt: request.created_at,
    };
    emitToUser(request.to_user_id, 'friend:request', payload);
    res.status(201).json({ request: { ...payload } });
  }),
);

router.get(
  '/friend-requests/incoming',
  asyncHandler((req, res) => {
    res.json({ requests: listIncoming(req.user.id) });
  }),
);

router.get(
  '/friend-requests/outgoing',
  asyncHandler((req, res) => {
    res.json({ requests: listOutgoing(req.user.id) });
  }),
);

router.post(
  '/friend-requests/:id/accept',
  asyncHandler((req, res) => {
    const request = acceptFriendRequest(req.params.id, req.user.id);
    emitToUser(request.from.id, 'friend:accepted', request);
    emitToUser(request.to.id, 'friend:accepted', request);
    // Both users were already online before they became friends, so neither
    // received the other's connect-time presence. Send a snapshot now.
    if (isUserOnline(request.from.id)) {
      emitToUser(request.to.id, 'presence', { userId: request.from.id, online: true });
    }
    if (isUserOnline(request.to.id)) {
      emitToUser(request.from.id, 'presence', { userId: request.to.id, online: true });
    }
    res.json({ request });
  }),
);

router.post(
  '/friend-requests/:id/reject',
  asyncHandler((req, res) => {
    const request = rejectFriendRequest(req.params.id, req.user.id);
    emitToUser(request.from.id, 'friend:request:update', request);
    res.json({ request });
  }),
);

router.delete(
  '/friend-requests/:id',
  asyncHandler((req, res) => {
    const request = cancelFriendRequest(req.params.id, req.user.id);
    emitToUser(request.to.id, 'friend:request:update', request);
    res.json({ request });
  }),
);

export default router;
