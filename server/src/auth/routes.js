import { Router } from 'express';
import { registerUser, loginUser } from './service.js';
import { createSession, revokeSession } from './sessions.js';
import { createChallenge } from './challenges.js';
import { authMiddleware } from '../middleware/auth.js';
import { authRateLimit } from '../middleware/rateLimit.js';
import { SESSION_COOKIE } from '../middleware/cookies.js';
import { asyncHandler } from '../middleware/errors.js';
import { withTransaction } from '../database/db.js';
import { bindDeviceOnRegister, resolveLoginDevice } from '../devices/binding.js';
import { getDeviceRow, publicDevice } from '../devices/service.js';
import { disconnectDeviceSockets } from '../sockets/emitter.js';
import config from '../config.js';

const router = Router();

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    maxAge: config.sessionTtlMs,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function extractDevice(body) {
  const device = body?.device || {};
  return {
    clientDeviceId: device.clientDeviceId,
    name: device.name,
    signingPublicKey: device.signingPublicKey,
  };
}

router.post(
  '/challenge',
  authRateLimit(),
  asyncHandler((req, res) => {
    const username =
      typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : undefined;
    const { id, challenge, expiresAt } = createChallenge(username);
    res.json({ challengeId: id, challenge, expiresAt });
  }),
);

router.post(
  '/register',
  authRateLimit(),
  asyncHandler((req, res) => {
    const { username, displayName, password } = req.body || {};
    const deviceInput = extractDevice(req.body);
    const proof = req.body?.proof;

    // Creating the account and binding its one device are atomic: a failed
    // device proof must not leave an account without a device.
    const { user, device } = withTransaction(() => {
      const created = registerUser({ username, displayName, password });
      const { device: bound } = bindDeviceOnRegister(created.id, deviceInput, proof);
      return { user: created, device: bound };
    });

    const session = createSession(user.id, device.id);
    setSessionCookie(res, session.token);
    res.status(201).json({
      user,
      token: session.token,
      expiresAt: session.expiresAt,
      device: publicDevice(device),
    });
  }),
);

router.post(
  '/login',
  authRateLimit(),
  asyncHandler((req, res) => {
    const { username, password, replace } = req.body || {};
    const deviceInput = extractDevice(req.body);
    const proof = req.body?.proof;

    const user = loginUser({ username, password });

    const result = withTransaction(() =>
      resolveLoginDevice(user.id, deviceInput, proof, { replace: replace === true }),
    );

    // After an approved replacement, kill the previous device's live sockets.
    if (result.replacedDeviceId) {
      disconnectDeviceSockets(result.replacedDeviceId);
    }

    const session = createSession(user.id, result.device.id);
    setSessionCookie(res, session.token);
    res.json({
      user,
      token: session.token,
      expiresAt: session.expiresAt,
      device: publicDevice(result.device),
      replaced: result.replaced === true,
    });
  }),
);

router.post(
  '/logout',
  asyncHandler((req, res) => {
    const token =
      req.cookies?.[SESSION_COOKIE] ||
      (req.get('authorization')?.startsWith('Bearer ')
        ? req.get('authorization').slice(7).trim()
        : req.get('x-session-token'));
    if (token) revokeSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  authMiddleware,
  asyncHandler((req, res) => {
    const device = getDeviceRow(req.user.id, req.session.device_id);
    res.json({ user: req.user, device: publicDevice(device) });
  }),
);

export default router;
