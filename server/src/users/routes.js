import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler, badRequest } from '../middleware/errors.js';
import { searchUsers } from '../friends/service.js';

const router = Router();

router.get(
  '/search',
  authMiddleware,
  asyncHandler((req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length === 0) {
      throw badRequest('q query parameter is required', { field: 'q' });
    }
    res.json({ results: searchUsers(q, req.user.id) });
  }),
);

export default router;
