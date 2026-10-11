import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { startTestServer, stopTestServer, api, makeUser, befriend } from './helpers.js';

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

test('socket connection requires a valid token', async () => {
  await assert.rejects(() => connect('not-a-real-token'));
});

test('online delivery, transport status and persistence ack', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);

  const socketA = await connect(a.token);
  const socketB = await connect(b.token);

  try {
    // Give presence a moment to register.
    await new Promise((r) => setTimeout(r, 50));

    const id = `msg-${Date.now()}-rt`;
    const newMessage = waitFor(socketB, 'message:new');
    const statusEvent = waitFor(socketA, 'message:status');

    const res = await api(base, 'POST', '/messages', {
      token: a.token,
      body: {
        messageId: id,
        recipientId: b.user.id,
        ciphertext: 'abc123ciphertext',
        iv: 'iv123',
        alg: 'AES-256-GCM',
      },
    });
    assert.equal(res.body.status, 'delivered');

    const received = await newMessage;
    assert.equal(received.messageId, id);
    assert.equal(received.ciphertext, 'abc123ciphertext');

    socketB.emit('message:ack', { messageId: id });
    const acked = await statusEvent;
    assert.equal(acked.messageId, id);
    assert.equal(acked.status, 'acked');
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('reconnect retrieval: pending returns queued ciphertext', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const id = `msg-${Date.now()}-reconnect`;
  await api(base, 'POST', '/messages', {
    token: a.token,
    body: {
      messageId: id,
      recipientId: b.user.id,
      ciphertext: 'offlinepayload',
      iv: 'iv999',
      alg: 'AES-256-GCM',
    },
  });
  // Recipient was offline; on reconnect, pending endpoint returns it.
  const socketB = await connect(b.token);
  try {
    const pending = await api(base, 'GET', '/messages/pending', { token: b.token });
    assert.ok(pending.body.messages.some((m) => m.messageId === id));
  } finally {
    socketB.close();
  }
});

test('presence snapshot lists already-online friends on connect', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);

  const socketB = await connect(b.token);
  const socketA = io(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
  const snapshotP = waitFor(socketA, 'presence:snapshot');
  await new Promise((resolve, reject) => {
    socketA.on('connect', resolve);
    socketA.on('connect_error', reject);
  });
  try {
    const snapshot = await snapshotP;
    assert.ok(snapshot.onlineFriends.includes(b.user.id));
  } finally {
    socketA.close();
    socketB.close();
  }
});

test('presence is delivered when friends connect while already online', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);

  // Both users are online before they become friends, so neither receives a
  // connect-time presence event for the other.
  const socketA = await connect(a.token);
  const socketB = await connect(b.token);
  try {
    await new Promise((r) => setTimeout(r, 50));
    const presenceA = waitFor(socketA, 'presence');
    const presenceB = waitFor(socketB, 'presence');
    await befriend(base, a, b);

    const pa = await presenceA;
    const pb = await presenceB;
    assert.deepEqual(pa, { userId: b.user.id, online: true });
    assert.deepEqual(pb, { userId: a.user.id, online: true });
  } finally {
    socketA.close();
    socketB.close();
  }
});
