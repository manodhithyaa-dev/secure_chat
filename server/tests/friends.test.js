import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, api, makeUser, befriend } from './helpers.js';

let base;
test('setup server', async () => {
  ({ base } = await startTestServer());
});

after(stopTestServer);

test('search finds users by username and excludes self', async () => {
  const a = await makeUser(base, { username: 'searchtarget' });
  const b = await makeUser(base);
  const res = await api(base, 'GET', '/users/search?q=searchtarget', { token: b.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].id, a.user.id);
  assert.equal(res.body.results[0].relationship, 'none');

  const self = await api(base, 'GET', '/users/search?q=searchtarget', { token: a.token });
  assert.equal(self.body.results.length, 0);
});

test('cannot send friend request to self', async () => {
  const a = await makeUser(base);
  const res = await api(base, 'POST', '/friend-requests', {
    token: a.token,
    body: { username: a.username },
  });
  assert.equal(res.status, 400);
});

test('friend request flow: pending, duplicate blocked, accept, friends list', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);

  const sent = await api(base, 'POST', '/friend-requests', {
    token: a.token,
    body: { username: b.username },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.request.status, 'pending');

  const dup = await api(base, 'POST', '/friend-requests', {
    token: a.token,
    body: { username: b.username },
  });
  assert.equal(dup.status, 409);

  const reverse = await api(base, 'POST', '/friend-requests', {
    token: b.token,
    body: { username: a.username },
  });
  assert.equal(reverse.status, 409);

  const incoming = await api(base, 'GET', '/friend-requests/incoming', { token: b.token });
  assert.equal(incoming.body.requests.length, 1);
  const outgoing = await api(base, 'GET', '/friend-requests/outgoing', { token: a.token });
  assert.equal(outgoing.body.requests.length, 1);

  const requestId = incoming.body.requests[0].id;
  // Only the recipient can accept.
  const wrongAccept = await api(base, 'POST', `/friend-requests/${requestId}/accept`, {
    token: a.token,
  });
  assert.equal(wrongAccept.status, 403);

  const accept = await api(base, 'POST', `/friend-requests/${requestId}/accept`, { token: b.token });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.request.status, 'accepted');

  const friends = await api(base, 'GET', '/friends', { token: a.token });
  assert.equal(friends.body.friends.length, 1);
  assert.equal(friends.body.friends[0].id, b.user.id);
});

test('reject and cancel flows update request status', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  const sent = await api(base, 'POST', '/friend-requests', {
    token: a.token,
    body: { username: b.username },
  });
  const reject = await api(base, 'POST', `/friend-requests/${sent.body.request.id}/reject`, {
    token: b.token,
  });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.request.status, 'rejected');

  // After rejection a new request may be sent, then cancelled.
  const again = await api(base, 'POST', '/friend-requests', {
    token: a.token,
    body: { username: b.username },
  });
  assert.equal(again.status, 201);
  const cancel = await api(base, 'DELETE', `/friend-requests/${again.body.request.id}`, {
    token: a.token,
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.request.status, 'cancelled');
});

test('friend endpoints require authentication', async () => {
  const res = await api(base, 'GET', '/friends');
  assert.equal(res.status, 401);
});

test('befriend helper produces a friendship', async () => {
  const a = await makeUser(base);
  const b = await makeUser(base);
  await befriend(base, a, b);
  const friends = await api(base, 'GET', '/friends', { token: b.token });
  assert.ok(friends.body.friends.some((f) => f.id === a.user.id));
});
