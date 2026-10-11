import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  api,
  makeUser,
  befriend,
  forceExpire,
  countMessageRows,
  cleanupExpiredMessages,
} from './helpers.js';

let base;
test('setup server', async () => {
  ({ base } = await startTestServer());
});

after(stopTestServer);

function envelope(id, overrides = {}) {
  return {
    messageId: id,
    recipientId: overrides.recipientId,
    ciphertext: 'base64ciphertextxxx',
    iv: 'base64ivvalue',
    alg: 'AES-256-GCM',
    deviceId: overrides.deviceId,
  };
}

test('cannot message a non-friend', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  const res = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(`msg-${Date.now()}-a`, { recipientId: b.user.id }),
  });
  assert.equal(res.status, 403);
});

test('cannot message self', async () => {
  const a = await makeUser(base);
  const res = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(`msg-${Date.now()}-self`, { recipientId: a.user.id }),
  });
  assert.equal(res.status, 400);
});

test('offline recipient message is queued and pending', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const id = `msg-${Date.now()}-queued`;
  const res = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(id, { recipientId: b.user.id }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'queued');
  assert.equal(res.body.queued, true);

  const pending = await api(base, 'GET', '/messages/pending', { token: b.token });
  assert.equal(pending.body.messages.length, 1);
  assert.equal(pending.body.messages[0].messageId, id);
  assert.equal(pending.body.messages[0].ciphertext, 'base64ciphertextxxx');
});

test('duplicate submission is idempotent', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const id = `msg-${Date.now()}-dupe`;
  const first = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(id, { recipientId: b.user.id }),
  });
  assert.equal(first.body.duplicate ?? false, false);
  const second = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(id, { recipientId: b.user.id }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.duplicate, true);
  assert.equal(await countMessageRows(id), 1);
});

test('acknowledgement clears ciphertext and updates status', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const id = `msg-${Date.now()}-ack`;
  await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(id, { recipientId: b.user.id }),
  });

  const ack = await api(base, 'POST', '/messages/ack', {
    token: b.token,
    body: { messageId: id },
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.status, 'acked');

  const status = await api(base, 'GET', `/messages/status/${id}`, { token: a.token });
  assert.equal(status.body.status, 'acked');

  // Payload must be gone after ack.
  const { getDb } = await import('../src/database/db.js');
  const row = getDb().prepare('SELECT * FROM messages WHERE message_id = ?').get(id);
  assert.equal(row.ciphertext, null);
  assert.equal(row.iv, null);

  const pending = await api(base, 'GET', '/messages/pending', { token: b.token });
  assert.equal(pending.body.messages.length, 0);
});

test('only recipient can acknowledge; only participants can view status', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  const c = await makeUser(base);
  await befriend(base, a, b);
  const id = `msg-${Date.now()}-authz`;
  await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(id, { recipientId: b.user.id }),
  });

  const wrongAck = await api(base, 'POST', '/messages/ack', {
    token: c.token,
    body: { messageId: id },
  });
  assert.equal(wrongAck.status, 403);

  const wrongStatus = await api(base, 'GET', `/messages/status/${id}`, { token: c.token });
  assert.equal(wrongStatus.status, 403);
});

test('malformed message is rejected', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const res = await api(base, 'POST', '/messages', {
    token: a.token,
    body: { messageId: 'x', recipientId: b.user.id, ciphertext: '', iv: '', alg: 'AES-256-GCM' },
  });
  assert.equal(res.status, 400);
});

test('expired queued messages are removed and reported expired', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const id = `msg-${Date.now()}-expire`;
  await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(id, { recipientId: b.user.id }),
  });
  await forceExpire(id);
  const removed = cleanupExpiredMessages();
  assert.ok(removed >= 1);

  const pending = await api(base, 'GET', '/messages/pending', { token: b.token });
  assert.equal(pending.body.messages.find((m) => m.messageId === id), undefined);

  const status = await api(base, 'GET', `/messages/status/${id}`, { token: a.token });
  assert.equal(status.body.status, 'expired');
});
