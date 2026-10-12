import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

// Short ring window so the timeout path is testable fast.
// Set BEFORE helpers loads config > config.js.
process.env.CALL_RING_TIMEOUT_MS = '800';
process.env.CALL_SIGNALING_TTL_MS = '1200';

const { startTestServer, stopTestServer, api, makeUser, befriend } = await import('./helpers.js');

let base;
test('setup server', async () => {
  ({ base } = await startTestServer());
});

after(stopTestServer);

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function connectUsers() {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const socketA = await connect(a.token);
  const socketB = await connect(b.token);
  await new Promise((r) => setTimeout(r, 50));
  return { a, b, socketA, socketB };
}

test('GET /rtc-config requires auth and returns ICE servers', async () => {
  const anon = await api(base, 'GET', '/rtc-config');
  assert.equal(anon.status, 401);
  const u = await makeUser(base);
  const res = await api(base, 'GET', '/rtc-config', { token: u.token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.iceServers));
  assert.ok(res.body.iceServers.every((s) => Array.isArray(s.urls)));
});

test('a friend can ring an online peer and exchange signaling', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  try {
    const callId = `c-${Date.now()}-ok`;
    const ringP = waitFor(socketB, 'call:ring');
    const res = await emitAck(socketA, 'call:invite', { callId, recipientId: b.user.id });
    assert.equal(res.ok, true);
    const ring = await ringP;
    assert.equal(ring.callId, callId);
    assert.equal(ring.kind, 'audio');
    assert.equal(ring.caller.id, a.user.id);
    assert.equal(ring.caller.username, a.username);
    assert.equal(ring.caller.displayName, a.displayName);

    const acceptedP = waitFor(socketA, 'call:accepted');
    const acc = await emitAck(socketB, 'call:accept', { callId });
    assert.equal(acc.ok, true);
    const accepted = await acceptedP;
    assert.equal(accepted.callId, callId);

    // Offer flows caller -> callee; candidate flows callee -> caller.
    const sigP = waitFor(socketB, 'call:signal');
    await emitAck(socketA, 'call:signal', { callId, data: { type: 'offer', sdp: 'SDP-OFFER-A' } });
    const offer = await sigP;
    assert.equal(offer.callId, callId);
    assert.equal(offer.data.type, 'offer');
    assert.equal(offer.data.sdp, 'SDP-OFFER-A');

    const candP = waitFor(socketA, 'call:signal');
    await emitAck(socketB, 'call:signal', { callId, data: { type: 'candidate', candidate: 'CAND-1' } });
    const cand = await candP;
    assert.equal(cand.data.candidate, 'CAND-1');

    const conn = await emitAck(socketA, 'call:connected', { callId });
    assert.equal(conn.ok, true);

    const endedP = waitFor(socketB, 'call:ended');
    await emitAck(socketA, 'call:end', { callId });
    assert.equal((await endedP).reason, 'ended');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('decline notifies the caller with reason declined', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  try {
    const callId = `c-${Date.now()}-decline`;
    const ringP = waitFor(socketB, 'call:ring');
    await emitAck(socketA, 'call:invite', { callId, recipientId: b.user.id });
    await ringP;
    const endedP = waitFor(socketA, 'call:ended');
    await emitAck(socketB, 'call:decline', { callId });
    assert.equal((await endedP).reason, 'declined');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('the caller can cancel before the callee answers', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  try {
    const callId = `c-${Date.now()}-cancel`;
    const ringP = waitFor(socketB, 'call:ring');
    await emitAck(socketA, 'call:invite', { callId, recipientId: b.user.id });
    await ringP;
    const cancelledP = waitFor(socketB, 'call:ended');
    await emitAck(socketA, 'call:cancel', { callId });
    assert.equal((await cancelledP).reason, 'cancelled');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('an unanswered call times out server-side', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  try {
    const callId = `c-${Date.now()}-timeout`;
    const endedP = waitFor(socketA, 'call:ended');
    const res = await emitAck(socketA, 'call:invite', { callId, recipientId: b.user.id });
    assert.equal(res.ok, true);
    assert.equal((await endedP).reason, 'timeout');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('an offline callee cannot be reached', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const socketA = await connect(a.token);
  try {
    const res = await emitAck(socketA, 'call:invite', {
      callId: `c-${Date.now()}-off`,
      recipientId: b.user.id,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'callee_offline');
  } finally {
    socketA.close();
  }
});

test('the ring advertises the call kind (video)', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  try {
    const callId = `c-${Date.now()}-video`;
    const ringP = waitFor(socketB, 'call:ring');
    await emitAck(socketA, 'call:invite', {
      callId,
      recipientId: b.user.id,
      kind: 'video',
    });
    const ring = await ringP;
    assert.equal(ring.kind, 'video');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('a busy callee rejects a second call', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  const d = await makeUser(base);
  await befriend(base, b, d);
  const socketD = await connect(d.token);
  try {
    await new Promise((r) => setTimeout(r, 50));
    const callId1 = `c-${Date.now()}-busy1`;
    await emitAck(socketA, 'call:invite', { callId: callId1, recipientId: b.user.id });
    const res = await emitAck(socketD, 'call:invite', {
      callId: `c-${Date.now()}-busy2`,
      recipientId: b.user.id,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'callee_busy');
  } finally {
    socketA.close();
    socketB.close();
    socketD.close();
  }
});

test('signaling from a non-participant is rejected', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  const outsider = await makeUser(base);
  const socketO = await connect(outsider.token);
  try {
    const callId = `c-${Date.now()}-nope`;
    await emitAck(socketA, 'call:invite', { callId, recipientId: b.user.id });
    const res = await emitAck(socketO, 'call:signal', { callId, data: { type: 'offer' } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_participant');
  } finally {
    socketA.close();
    socketB.close();
    socketO.close();
  }
});

test('friendship is enforced before a call can start', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  const socketA = await connect(a.token);
  const socketB = await connect(b.token);
  try {
    await new Promise((r) => setTimeout(r, 50));
    const res = await emitAck(socketA, 'call:invite', {
      callId: `c-${Date.now()}-notfriends`,
      recipientId: b.user.id,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_friends');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('disconnecting a participant ends the call for the peer', async () => {
  const { a, b, socketA, socketB } = await connectUsers();
  try {
    const callId = `c-${Date.now()}-drop`;
    const ringP = waitFor(socketB, 'call:ring');
    await emitAck(socketA, 'call:invite', { callId, recipientId: b.user.id });
    await ringP;
    const endedP = waitFor(socketA, 'call:ended');
    socketB.close();
    assert.equal((await endedP).reason, 'peer_left');
  } finally {
    socketA.close();
  }
});