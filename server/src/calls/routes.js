import { Router } from 'express';
import config from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

/**
 * ICE server configuration for WebRTC calls. TURN credentials stay
 * server-side; an authenticated client fetches them when starting a call.
 */
router.get('/rtc-config', (_req, res) => {
  res.json({ iceServers: config.rtcIceServers });
});

export default router;