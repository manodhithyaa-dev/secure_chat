import { test, expect } from '@playwright/test';
import { register, uniqueUsername } from './support';

test.describe('chat remains usable after authentication', () => {
  test('two single-device accounts can become friends and exchange a message', async ({
    browser,
  }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();

      await register(alice, aliceName, 'Alice E2E');
      await register(bob, bobName, 'Bob E2E');

      // Alice finds Bob and sends a friend request.
      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob E2E' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();

      // Bob accepts it, then opens the new conversation from Chats.
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice E2E' }).click();
      await expect(bob.getByPlaceholder('Type an encrypted message…')).toBeVisible();

      // Alice opens the conversation with Bob.
      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob E2E' }).click();
      await expect(alice.getByPlaceholder('Type an encrypted message…')).toBeVisible();

      // Alice sends an encrypted message.
      const text = 'hello from a single device';
      await alice.getByPlaceholder('Type an encrypted message…').fill(text);
      const [sendResponse] = await Promise.all([
        alice.waitForResponse(
          (r) => r.url().includes('/api/v1/messages') && r.request().method() === 'POST',
        ),
        alice.getByRole('button', { name: 'Send' }).click(),
      ]);
      expect(sendResponse.status()).toBe(201);

      // Bob receives and can read it (conversation already open).
      await expect(bob.locator('.bubble-text', { hasText: text })).toBeVisible();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
