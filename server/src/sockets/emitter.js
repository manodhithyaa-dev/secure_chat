let io = null;

export function setIo(instance) {
  io = instance;
}

export function getIo() {
  return io;
}

export function userRoom(userId) {
  return `user:${userId}`;
}

export function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
}

export function isUserOnline(userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(userRoom(userId));
  return !!room && room.size > 0;
}

/**
 * Force-disconnect every socket belonging to a specific device. Used when a
 * device is revoked or replaced so it cannot keep receiving events.
 */
export function disconnectDeviceSockets(deviceId) {
  if (!io || !deviceId) return 0;
  let disconnected = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.deviceId === deviceId) {
      socket.disconnect(true);
      disconnected += 1;
    }
  }
  return disconnected;
}
