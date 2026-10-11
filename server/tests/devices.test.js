import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, api, makeUser, befriend } from './helpers.js';

let base;
test('setup server', async () => {
  ({ base } = await startTestServer());
});

after(stopTestServer);

const KEY_A = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAdeviceKeyAAAAAAAAAAAAAAAAAA';
const KEY_B = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBBBBdeviceKeyBBBBBBBBBBBBBBBBBBBBBB';

test('register creates exactly one active device', async () => {
  const a = await makeUser(base);
  const list = await api(base, 'GET', '/devices', { token: a.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].hasSigningKey, true);
  assert.equal(list.body.devices[0].clientDeviceId, a.device.clientDeviceId);
});

test('current device can publish its E2EE identity key', async () => {
  const a = await makeUser(base);
  const res = await api(base, 'PUT', '/devices/current/identity', {
    token: a.token,
    body: { identityPublicKey: KEY_A, algorithm: 'ECDH-P256' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.device.identityPublicKey, KEY_A);

  const list = await api(base, 'GET', '/devices', { token: a.token });
  assert.equal(list.body.devices[0].identityPublicKey, KEY_A);
});

test('key bundle exposes only active devices with a published encryption key', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);

  // No identity key published yet -> excluded from the bundle.
  let bundle = await api(base, 'GET', `/keys/${a.user.id}`, { token: b.token });
  assert.equal(bundle.body.bundle.devices.length, 0);

  await api(base, 'PUT', '/devices/current/identity', {
    token: a.token,
    body: { identityPublicKey: KEY_B, algorithm: 'ECDH-P256' },
  });
  bundle = await api(base, 'GET', `/keys/${a.user.id}`, { token: b.token });
  assert.equal(bundle.body.bundle.devices.length, 1);
  assert.equal(bundle.body.bundle.devices[0].identityPublicKey, KEY_B);

  // Revoking the only device empties the bundle and kills its session.
  const list = await api(base, 'GET', '/devices', { token: a.token });
  await api(base, 'DELETE', `/devices/${list.body.devices[0].id}`, { token: a.token });
  bundle = await api(base, 'GET', `/keys/${a.user.id}`, { token: b.token });
  assert.equal(bundle.body.bundle.devices.length, 0);

  const me = await api(base, 'GET', '/auth/me', { token: a.token });
  assert.ok(me.status === 403 || me.status === 401);
});
