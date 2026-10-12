import { test, expect } from '@playwright/test';
import { register, uniqueUsername } from './support';

test.describe('calls', () => {
  test('a friend can ring, accept and hang up an audio call', async ({ browser }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext({ permissions: ['microphone'] });
    const bobCtx = await browser.newContext({ permissions: ['microphone'] });
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();

      await register(alice, aliceName, 'Alice Call');
      await register(bob, bobName, 'Bob Call');

      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob Call' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();

      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob Call' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice Call' }).click();

      // Both peers must be online before a call can be started.
      await expect(alice.locator('.chat-peer')).toContainText('online');
      await expect(bob.locator('.chat-peer')).toContainText('online');

      await alice.getByTestId('start-call').click();
      await expect(alice.getByTestId('call-screen')).toBeVisible();
      await expect(alice.getByTestId('call-status')).toContainText('Calling');
      await expect(bob.getByTestId('incoming-call')).toBeVisible();
      await expect(bob.getByTestId('incoming-call')).toContainText('Alice Call');

      await bob.getByTestId('accept-call').click();
      await expect(bob.getByTestId('incoming-call')).toHaveCount(0);
      await expect(alice.getByTestId('call-status')).toContainText('In call', { timeout: 20000 });
      await expect(bob.getByTestId('call-status')).toContainText('In call', { timeout: 20000 });
      await expect(alice.getByTestId('call-status')).toContainText(/\d:\d\d/);

      await alice.getByTestId('hangup-button').click();
      await expect(alice.getByTestId('call-screen')).toHaveCount(0);
      await expect(bob.getByTestId('call-screen')).toHaveCount(0);
      await expect(bob.locator('.call-notice')).toContainText(/ended/i);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('a callee can decline an incoming call', async ({ browser }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext({ permissions: ['microphone'] });
    const bobCtx = await browser.newContext({ permissions: ['microphone'] });
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();

      await register(alice, aliceName, 'Alice Decline');
      await register(bob, bobName, 'Bob Decline');

      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob Decline' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();

      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob Decline' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice Decline' }).click();

      await expect(alice.locator('.chat-peer')).toContainText('online');
      await expect(bob.locator('.chat-peer')).toContainText('online');

      await alice.getByTestId('start-call').click();
      await expect(bob.getByTestId('incoming-call')).toBeVisible();

      await bob.getByTestId('decline-call').click();
      await expect(bob.getByTestId('incoming-call')).toHaveCount(0);
      await expect(alice.getByTestId('call-screen')).toHaveCount(0);
      await expect(alice.locator('.call-notice')).toContainText(/declined/i);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('a video call shows live local and remote video after acceptance', async ({ browser }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const bobCtx = await browser.newContext({ permissions: ['microphone', 'camera'] });
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();

      await register(alice, aliceName, 'Alice Video');
      await register(bob, bobName, 'Bob Video');

      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob Video' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();

      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob Video' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice Video' }).click();

      await expect(alice.locator('.chat-peer')).toContainText('online');
      await expect(bob.locator('.chat-peer')).toContainText('online');

      await alice.getByTestId('start-video-call').click();
      await expect(alice.getByTestId('local-video')).toBeVisible();
      await expect(bob.getByTestId('incoming-call')).toContainText('Incoming video call');

      await bob.getByTestId('accept-call').click();
      await expect(alice.getByTestId('remote-video')).toBeVisible({ timeout: 25000 });
      await expect(bob.getByTestId('remote-video')).toBeVisible({ timeout: 25000 });
      await expect(alice.getByTestId('call-status')).toContainText('In call', { timeout: 25000 });

      await alice.getByTestId('hangup-button').click();
      await expect(alice.getByTestId('call-screen')).toHaveCount(0);
      await expect(bob.getByTestId('call-screen')).toHaveCount(0);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});