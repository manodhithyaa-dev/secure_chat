import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import {
  startTestServer,
  stopTestServer,
  api,
  makeUser,
  login,
  generateDevice,
} from './helpers.js';

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

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

test('a second device login is rejected unless replacement is authorized', async () => {
  const a = await makeUser(base);
  const other = await generateDevice();

  const rejected = await login(base, a, { device: other });
  assert.equal(rejected.res.status, 409);
  assert.equal(rejected.res.body.error.code, 'device_already_registered');

  // Still exactly one active device, and the original session is untouched.
  const list = await api(base, 'GET', '/devices', { token: a.token });
  assert.equal(list.body.devices.length, 1);
  const me = await api(base, 'GET', '/auth/me', { token: a.token });
  assert.equal(me.status, 200);
});

test('replacement revokes the old device and every old session', async () => {
  const a = await makeUser(base);
  const newDevice = await generateDevice();

  const { res } = await login(base, a, { device: newDevice, replace: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.replaced, true);
  assert.equal(res.body.device.clientDeviceId, newDevice.clientDeviceId);

  // Old token is dead.
  const oldMe = await api(base, 'GET', '/auth/me', { token: a.token });
  assert.equal(oldMe.status, 403);
  assert.equal(oldMe.body.error.code, 'device_revoked');

  // New session works and there is still exactly one active device.
  const newMe = await api(base, 'GET', '/auth/me', { token: res.body.token });
  assert.equal(newMe.status, 200);
  const list = await api(base, 'GET', '/devices', { token: res.body.token });
  assert.equal(list.body.devices.length, 1);
});

test('a client cannot impersonate a device by copying its client device id', async () => {
  const a = await makeUser(base);
  const attacker = await generateDevice();
  // Copy the victim's stable identifier but keep the attacker's own signing key.
  attacker.clientDeviceId = a.device.clientDeviceId;

  const { res } = await login(base, a, { device: attacker });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'device_not_authorized');
});

test('an existing session survives client IP changes', async () => {
  const a = await makeUser(base);
  const headersA = { 'x-forwarded-for': '203.0.113.10' };
  const headersB = { 'x-forwarded-for': '198.51.100.99' };

  const first = await api(base, 'GET', '/auth/me', { token: a.token, headers: headersA });
  const second = await api(base, 'GET', '/auth/me', { token: a.token, headers: headersB });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.user.id, second.body.user.id);
});

test('a legacy account without a device proof is upgraded in place', async () => {
  const a = await makeUser(base);
  const { getDb } = await import('../src/database/db.js');
  getDb()
    .prepare('UPDATE devices SET signing_public_key = NULL, client_device_id = NULL WHERE user_id = ?')
    .run(a.user.id);

  const { res } = await login(base, a, { device: await generateDevice() });
  assert.equal(res.status, 200);
  assert.equal(res.body.replaced, true);

  // Upgrade happens in place: still exactly one device row for the account.
  const rows = getDb()
    .prepare('SELECT COUNT(*) AS c FROM devices WHERE user_id = ? AND revoked_at IS NULL')
    .get(a.user.id);
  assert.equal(rows.c, 1);
});

test('replacing a device disconnects the old device socket', async () => {
  const a = await makeUser(base);
  const socket = await connect(a.token);
  const closed = new Promise((resolve) => socket.on('disconnect', () => resolve(true)));

  const { res } = await login(base, a, { device: await generateDevice(), replace: true });
  assert.equal(res.status, 200);

  await Promise.race([closed, timeout(2000)]);
  assert.equal(socket.connected, false);
});

test('concurrent replacement attempts leave exactly one active device', async () => {
  const a = await makeUser(base);
  const [d2, d3] = await Promise.all([generateDevice(), generateDevice()]);

  await Promise.all([
    login(base, a, { device: d2, replace: true }),
    login(base, a, { device: d3, replace: true }),
  ]);

  const { getDb } = await import('../src/database/db.js');
  const active = getDb()
    .prepare('SELECT COUNT(*) AS c FROM devices WHERE user_id = ? AND revoked_at IS NULL')
    .get(a.user.id);
  assert.equal(active.c, 1);
});
