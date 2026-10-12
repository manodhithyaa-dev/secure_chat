// Test bootstrap. MUST set env before importing the app/config.
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = ':memory:';
process.env.RATE_LIMIT_MAX = '10000';
process.env.AUTH_RATE_LIMIT_MAX = '10000';
process.env.CLEANUP_INTERVAL_MS = '600000';

const { startServer } = await import('../src/index.js');
const { cleanupExpiredMessages } = await import('../src/messages/service.js');

let handle = null;

export async function startTestServer() {
  if (handle) return handle;
  handle = await startServer({ port: 0 });
  const { port } = handle.httpServer.address();
  handle.base = `http://127.0.0.1:${port}`;
  return handle;
}

export async function stopTestServer() {
  if (!handle) return;
  await new Promise((resolve) => handle.httpServer.close(resolve));
  handle = null;
}

export { cleanupExpiredMessages };

export async function forceExpire(messageId) {
  const { getDb } = await import('../src/database/db.js');
  getDb()
    .prepare('UPDATE messages SET expires_at = ? WHERE message_id = ?')
    .run(Date.now() - 1000, messageId);
}

export async function countMessageRows(messageId) {
  const { getDb } = await import('../src/database/db.js');
  return getDb().prepare('SELECT COUNT(*) AS c FROM messages WHERE message_id = ?').get(messageId).c;
}

export async function api(base, method, path, { token, body, headers: extraHeaders } = {}) {
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, body: json };
}

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

/** Generate a browser-like device identity: stable id + ECDSA proof key. */
export async function generateDevice() {
  const pair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = await subtle.exportKey('spki', pair.publicKey);
  return {
    clientDeviceId: `dev-${crypto.randomUUID()}`,
    signingPublicKey: Buffer.from(spki).toString('base64'),
    privateKey: pair.privateKey,
  };
}

function deviceBody(device) {
  return {
    clientDeviceId: device.clientDeviceId,
    name: 'Test device',
    signingPublicKey: device.signingPublicKey,
  };
}

/** Fetch a challenge and sign it with the device's private key. */
export async function authProof(base, device, { username } = {}) {
  const res = await api(base, 'POST', '/auth/challenge', { body: { username } });
  if (res.status !== 200) throw new Error(`challenge failed: ${JSON.stringify(res.body)}`);
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    device.privateKey,
    Buffer.from(res.body.challenge, 'utf8'),
  );
  return { challengeId: res.body.challengeId, signature: Buffer.from(sig).toString('base64') };
}

let counter = 0;
export async function makeUser(base, overrides = {}) {
  counter += 1;
  const username = overrides.username || `user${Date.now().toString(36)}${counter}`.toLowerCase();
  const password = overrides.password || 'password123';
  const displayName = overrides.displayName || `User ${counter}`;
  const device = overrides.device || (await generateDevice());
  const proof = await authProof(base, device, { username });
  const reg = await api(base, 'POST', '/auth/register', {
    body: {
      username,
      displayName,
      password,
      device: deviceBody(device),
      proof,
    },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  return {
    username,
    password,
    displayName,
    token: reg.body.token,
    user: reg.body.user,
    device,
  };
}

/** Log in (optionally from a specific device) and return the raw response. */
export async function login(base, { username, password }, { device, replace } = {}) {
  const dev = device || (await generateDevice());
  const proof = await authProof(base, dev, { username });
  const res = await api(base, 'POST', '/auth/login', {
    body: { username, password, device: deviceBody(dev), proof, replace },
  });
  return { res, device: dev };
}


export async function befriend(base, a, b) {
  await api(base, 'POST', '/friend-requests', { token: a.token, body: { username: b.username } });
  const incoming = await api(base, 'GET', '/friend-requests/incoming', { token: b.token });
  const request = incoming.body.requests.find((r) => r.from.id === a.user.id);
  await api(base, 'POST', `/friend-requests/${request.id}/accept`, { token: b.token });
  return request;
}
