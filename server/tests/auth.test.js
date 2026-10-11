import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, api, makeUser, login } from './helpers.js';

let base;
test('setup server', async () => {
  ({ base } = await startTestServer());
  assert.ok(base);
});

after(stopTestServer);

test('health endpoint responds', async () => {
  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('register returns user and token', async () => {
  const u = await makeUser(base);
  assert.ok(u.token);
  assert.equal(u.user.username, u.username);
  assert.equal(u.user.password, undefined);
});

test('me requires authentication', async () => {
  const res = await api(base, 'GET', '/auth/me');
  assert.equal(res.status, 401);
});

test('me returns current user with token', async () => {
  const u = await makeUser(base);
  const res = await api(base, 'GET', '/auth/me', { token: u.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, u.user.id);
});

test('duplicate username is rejected', async () => {
  const u = await makeUser(base);
  const res = await api(base, 'POST', '/auth/register', {
    body: { username: u.username, displayName: 'X', password: 'password123' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'conflict');
});

test('invalid username and weak password are rejected', async () => {
  const bad1 = await api(base, 'POST', '/auth/register', {
    body: { username: 'AB', displayName: 'X', password: 'password123' },
  });
  assert.equal(bad1.status, 400);
  const bad2 = await api(base, 'POST', '/auth/register', {
    body: { username: 'validname', displayName: 'X', password: 'short' },
  });
  assert.equal(bad2.status, 400);
});

test('login fails with wrong password and succeeds with right one', async () => {
  const u = await makeUser(base);
  const bad = await api(base, 'POST', '/auth/login', {
    body: { username: u.username, password: 'wrongpassword' },
  });
  assert.equal(bad.status, 401);
  const good = await login(base, u, { device: u.device });
  assert.equal(good.res.status, 200);
  assert.ok(good.res.body.token);
});

test('logout revokes the session', async () => {
  const u = await makeUser(base);
  const out = await api(base, 'POST', '/auth/logout', { token: u.token });
  assert.equal(out.status, 200);
  const me = await api(base, 'GET', '/auth/me', { token: u.token });
  assert.equal(me.status, 401);
});

test('malformed JSON body returns 400', async () => {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
});
