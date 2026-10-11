import { Server } from 'socket.io';
import config from '../config.js';
import { findValidSession } from '../auth/sessions.js';
import { getUserById } from '../auth/service.js';
import { getActiveDeviceRow, getDeviceRow } from '../devices/service.js';
import { acknowledgeMessage } from '../messages/service.js';
import { listFriends } from '../friends/service.js';
import { setIo, userRoom, emitToUser, isUserOnline } from './emitter.js';

const SESSION_COOKIE = 'sc_token';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function tokenFromSocket(socket) {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return authToken;
  const cookies = parseCookies(socket.handshake.headers?.cookie);
  return cookies[SESSION_COOKIE] || null;
}

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
  });

  // userId -> number of active sockets
  const presence = new Map();

  io.use((socket, next) => {
    const token = tokenFromSocket(socket);
    const session = findValidSession(token);
    if (!session) return next(new Error('unauthorized'));
    const user = getUserById(session.user_id);
    if (!user) return next(new Error('unauthorized'));

    // Enforce the same single-device rule as the REST middleware. Sockets do
    // not outlive a device revocation/replacement.
    if (!session.device_id) return next(new Error('device_replacement_required'));
    const device = getDeviceRow(session.user_id, session.device_id);
    if (!device) return next(new Error('device_not_authorized'));
    if (device.revoked_at) return next(new Error('device_revoked'));
    const active = getActiveDeviceRow(session.user_id);
    if (!active || active.id !== device.id) return next(new Error('device_replacement_required'));

    socket.data.user = user;
    socket.data.deviceId = device.id;
    return next();
  });

  function broadcastPresence(userId, online) {
    for (const friend of listFriends(userId)) {
      emitToUser(friend.id, 'presence', { userId, online });
    }
  }

  /**
   * Re-check the device on sensitive events rather than trusting the
   * connection-time check alone (the device may have been replaced since).
   */
  function deviceStillAuthorized(socket) {
    const user = socket.data.user;
    if (!user || !socket.data.deviceId) return false;
    const active = getActiveDeviceRow(user.id);
    return Boolean(active && active.id === socket.data.deviceId && !active.revoked_at);
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(userRoom(user.id));

    const nextCount = (presence.get(user.id) || 0) + 1;
    presence.set(user.id, nextCount);
    if (nextCount === 1) {
      broadcastPresence(user.id, true);
    }

    // Tell the connecting client which of their friends are currently online.
    const onlineFriends = listFriends(user.id)
      .filter((f) => isUserOnline(f.id))
      .map((f) => f.id);
    socket.emit('presence:snapshot', { onlineFriends });

    socket.on('message:ack', (payload, ack) => {
      try {
        if (!deviceStillAuthorized(socket)) {
          throw new Error('device_not_authorized');
        }
        const messageId = payload?.messageId;
        if (!messageId) throw new Error('messageId required');
        const result = acknowledgeMessage(messageId, user.id);
        if (result.senderId) {
          emitToUser(result.senderId, 'message:status', {
            messageId: result.messageId,
            status: 'acked',
          });
        }
        if (typeof ack === 'function') ack({ ok: true, messageId, status: 'acked' });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('sync:request', (_payload, ack) => {
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('disconnect', () => {
      const count = (presence.get(user.id) || 1) - 1;
      if (count <= 0) {
        presence.delete(user.id);
        broadcastPresence(user.id, false);
      } else {
        presence.set(user.id, count);
      }
    });
  });

  setIo(io);
  return io;
}

export default createSocketServer;
