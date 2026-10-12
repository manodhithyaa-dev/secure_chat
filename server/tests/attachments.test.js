import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startTestServer,
  stopTestServer,
  api,
  makeUser,
  befriend,
} from './helpers.js';
import config from '../src/config.js';

let base;
test('setup server', async () => {
  ({ base } = await startTestServer());
});

after(stopTestServer);

const tick = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function rawPut(token, urlPath, data, requestHeaders = {}) {
  const res = await fetch(`${base}/api/v1${urlPath}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      ...requestHeaders,
    },
    body: data,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function rawGet(token, urlPath) {
  const res = await fetch(`${base}/api/v1${urlPath}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

async function createTicket(token, overrides = {}) {
  return api(base, 'POST', '/attachments', {
    token,
    body: {
      kind: 'file',
      name: 'notes.txt',
      contentType: 'text/plain',
      plainSize: 13,
      cipherSize: 1024 * 1024,
      ...overrides,
    },
  });
}

function envelope(id, recipientId, overrides = {}) {
  return {
    messageId: id,
    recipientId,
    ciphertext: 'base64ciphertextxxx',
    iv: 'base64ivvalue',
    alg: 'AES-256-GCM',
    ...overrides,
  };
}

test('attachments require authentication', async () => {
  const res = await api(base, 'POST', '/attachments', {
    body: { kind: 'file', name: 'x.txt', plainSize: 1, cipherSize: 64 },
  });
  assert.equal(res.status, 401);
});

test('create + upload + download round trip for the sender', async () => {
  const a = await makeUser(base);
  const created = await createTicket(a.token);
  assert.equal(created.status, 201);
  const id = created.body.attachment.id;
  assert.match(id, /^[0-9a-f]{32}$/);

  const payload = Buffer.from('this-is-encrypted-bytes-foo', 'utf8');
  const up = await rawPut(a.token, `/attachments/${id}/data`, payload);
  assert.equal(up.status, 200);
  assert.equal(up.body.attachment.status, 'ready');
  assert.equal(up.body.attachment.cipherSize, payload.length);

  const dl = await rawGet(a.token, `/attachments/${id}/data`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.toString('utf8'), payload.toString('utf8'));
  assert.equal(fs.existsSync(path.join(config.attachmentDir, id)), true);
});

test('rejects invalid ticket metadata', async () => {
  const a = await makeUser(base);
  assert.equal((await createTicket(a.token, { kind: 'exe' })).status, 400);
  assert.equal((await createTicket(a.token, { name: '  ' })).status, 400);
  assert.equal((await createTicket(a.token, { name: 'x'.repeat(300) })).status, 400);
  assert.equal((await createTicket(a.token, { plainSize: -1 })).status, 400);
  assert.equal((await createTicket(a.token, { cipherSize: 2 })).status, 400);
});

test('rejects over-limit uploads and empty/broken bodies', async () => {
  const a = await makeUser(base);

  // Oversized streamed body → aborted at the counting transform, no blob left.
  const created = await createTicket(a.token);
  const id = created.body.attachment.id;
  const oversized = await rawPut(
    a.token,
    `/attachments/${id}/data`,
    Buffer.alloc(config.attachmentMaxBytes + 1),
  );
  assert.equal(oversized.status, 413);

  // A fresh ticket that gets a too-small body is rejected outright.
  const created2 = await createTicket(a.token);
  const id2 = created2.body.attachment.id;
  const tiny = await rawPut(a.token, `/attachments/${id2}/data`, Buffer.alloc(2));
  assert.equal(tiny.status, 400);
  assert.equal(fs.existsSync(path.join(config.attachmentDir, id2)), false);
});

test('download is scoped to sender/recipient and links via the message', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  const c = await makeUser(base);
  await befriend(base, a, b);

  const created = await createTicket(a.token);
  const id = created.body.attachment.id;
  await rawPut(a.token, `/attachments/${id}/data`, Buffer.from('secret-encrypted-bytes!'));

  // Recipient cannot download before the attachment is linked to a message.
  const before = await rawGet(b.token, `/attachments/${id}/data`);
  assert.equal(before.status, 403);

  // Unrelated user can never download.
  const stranger = await rawGet(c.token, `/attachments/${id}/data`);
  assert.equal(stranger.status, 403);

  // Link by sending a message that references the attachment.
  const messageId = `msg-${tick()}`;
  const sent = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(messageId, b.user.id, { attachmentId: id }),
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.messageId, messageId);

  // Recipient sees the attachmentId in the pending queue.
  const pending = await api(base, 'GET', '/messages/pending', { token: b.token });
  const row = pending.body.messages.find((m) => m.messageId === messageId);
  assert.equal(row.attachmentId, id);

  // Recipient can now download.
  const now = await rawGet(b.token, `/attachments/${id}/data`);
  assert.equal(now.status, 200);
  assert.equal(now.body.toString('utf8'), 'secret-encrypted-bytes!');
});

test('cannot link an attachment that is not uploaded/ready', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const created = await createTicket(a.token);
  const res = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(`msg-${tick()}`, b.user.id, { attachmentId: created.body.attachment.id }),
  });
  assert.equal(res.status, 400);
});

test('cannot link another users attachment or reuse a linked one', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const created = await createTicket(a.token);
  const id = created.body.attachment.id;
  await rawPut(a.token, `/attachments/${id}/data`, Buffer.from('encrypted-bytes-here!'));

  // b tries to send a message whose attachment belongs to a.
  const stolen = await api(base, 'POST', '/messages', {
    token: b.token,
    body: envelope(`msg-${tick()}`, a.user.id, { attachmentId: id }),
  });
  assert.equal(stolen.status, 403);

  // Link it once for real, then a second link attempt must fail.
  const m1 = `msg-${tick()}`;
  await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(m1, b.user.id, { attachmentId: id }),
  });
  const again = await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(`msg-${tick()}`, b.user.id, { attachmentId: id }),
  });
  assert.equal(again.status, 409);
});

test('sender can delete an unsent attachment idempotently', async () => {
  const a = await makeUser(base);
  const created = await createTicket(a.token);
  const id = created.body.attachment.id;
  const b = await makeUser(base);

  assert.equal((await api(base, 'DELETE', `/attachments/${id}`, { token: b.token })).status, 403);
  const del = await api(base, 'DELETE', `/attachments/${id}`, { token: a.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  const again = await api(base, 'DELETE', `/attachments/${id}`, { token: a.token });
  assert.equal(again.body.deleted, false);
});

test('expired attachments are no longer downloadable', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const created = await createTicket(a.token);
  const id = created.body.attachment.id;
  await rawPut(a.token, `/attachments/${id}/data`, Buffer.from('encrypted-bytes-here!'));

  const messageId = `msg-${tick()}`;
  await api(base, 'POST', '/messages', {
    token: a.token,
    body: envelope(messageId, b.user.id, { attachmentId: id }),
  });

  const { getDb } = await import('../src/database/db.js');
  getDb().prepare('UPDATE attachments SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);

  const dl = await rawGet(a.token, `/attachments/${id}/data`);
  assert.equal(dl.status, 404);
});

test('cleanup removes expired attachment rows and blobs', async () => {
  const a = await makeUser(base);
  const created = await createTicket(a.token);
  const id = created.body.attachment.id;
  await rawPut(a.token, `/attachments/${id}/data`, Buffer.from('encrypted-bytes-here!'));
  const blob = path.join(config.attachmentDir, id);
  assert.equal(fs.existsSync(blob), true);

  const { getDb } = await import('../src/database/db.js');
  getDb().prepare('UPDATE attachments SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);

  const { cleanupExpiredAttachments } = await import('../src/attachments/service.js');
  const removed = cleanupExpiredAttachments();
  assert.ok(removed >= 1);

  const left = getDb().prepare('SELECT COUNT(*) AS c FROM attachments WHERE id = ?').get(id).c;
  assert.equal(left, 0);
  assert.equal(fs.existsSync(blob), false);
});