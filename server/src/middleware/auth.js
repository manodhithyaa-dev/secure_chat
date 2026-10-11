import { findValidSession } from '../auth/sessions.js';
import { getUserById } from '../auth/service.js';
import {
  deviceNotAuthorized,
  deviceReplacementRequired,
  deviceRevoked,
  unauthorized,
} from './errors.js';
import { SESSION_COOKIE } from './cookies.js';
import { getActiveDeviceRow, getDeviceRow } from '../devices/service.js';

function extractToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  if (req.get('x-session-token')) {
    return req.get('x-session-token').trim();
  }
  if (req.cookies && req.cookies[SESSION_COOKIE]) {
    return req.cookies[SESSION_COOKIE];
  }
  return null;
}

/**
 * Authenticate a request AND enforce that the session is bound to the account's
 * single active device. Device state is re-read from the database on every
 * request, so revoking or replacing a device takes effect immediately even
 * though the session token itself is unchanged.
 */
export function authMiddleware(req, _res, next) {
  const token = extractToken(req);
  const session = findValidSession(token);
  if (!session) {
    return next(unauthorized());
  }
  const user = getUserById(session.user_id);
  if (!user) {
    return next(unauthorized());
  }

  if (!session.device_id) {
    return next(deviceReplacementRequired());
  }
  const device = getDeviceRow(session.user_id, session.device_id);
  if (!device) {
    return next(deviceNotAuthorized());
  }
  if (device.revoked_at) {
    return next(deviceRevoked());
  }
  const active = getActiveDeviceRow(session.user_id);
  if (!active || active.id !== device.id) {
    return next(deviceReplacementRequired());
  }

  req.user = user;
  req.sessionToken = token;
  req.session = session;
  req.device = device;
  next();
}

export { extractToken };
