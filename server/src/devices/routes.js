import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import { getPublicKeyBundle, listDevices, revokeDevice, setIdentityKey } from '../devices/service.js';
import { disconnectDeviceSockets } from '../sockets/emitter.js';

const router = Router();
router.use(authMiddleware);

// Publish (or refresh) the E2EE identity key on the caller's bound device.
// Devices are created during register/login, not here.
router.put(
  '/devices/current/identity',
  asyncHandler((req, res) => {
    const { identityPublicKey, algorithm } = req.body || {};
    const device = setIdentityKey(req.user.id, req.session.device_id, {
      identityPublicKey,
      algorithm,
    });
    res.json({ device });
  }),
);

router.get(
  '/devices',
  asyncHandler((req, res) => {
    res.json({ devices: listDevices(req.user.id) });
  }),
);

router.delete(
  '/devices/:id',
  asyncHandler((req, res) => {
    const device = revokeDevice(req.user.id, req.params.id);
    // Revocation takes effect on the next request via the device check; also
    // drop the live socket so it cannot keep receiving events.
    disconnectDeviceSockets(req.params.id);
    res.json({ device });
  }),
);

router.get(
  '/keys/:userId',
  asyncHandler((req, res) => {
    const bundle = getPublicKeyBundle(req.params.userId, req.user.id);
    res.json({ bundle });
  }),
);

export default router;
