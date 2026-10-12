import { test, expect } from '@playwright/test';
import { register, uniqueUsername } from './support';

test.describe('voice messages', () => {
  test('a recording is encrypted, uploaded and plays for the recipient', async ({ browser }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext({
      permissions: ['microphone'],
    });
    const bobCtx = await browser.newContext();
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();

      await register(alice, aliceName, 'Alice Voice');
      await register(bob, bobName, 'Bob Voice');

      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob Voice' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();

      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob Voice' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice Voice' }).click();

      // Start a recording; the composer switches to a recorder bar with a timer.
      await alice.getByRole('button', { name: 'Record a voice message' }).click();
      await expect(alice.locator('.recorder')).toBeVisible();
      await expect(alice.getByTestId('recorder-timer')).toContainText(/^\d/);

      // Record ~1.5s then stop and send.
      await alice.waitForTimeout(1500);
      await expect(alice.getByTestId('recorder-timer')).toContainText('0:0');
      await alice.getByRole('button', { name: 'Send' }).click();

      // Sender reaches "available" with a playable audio element.
      await expect(alice.locator('.bubble.out .att audio')).toBeVisible({ timeout: 20000 });
      await expect(alice.locator('.bubble.in .att audio')).toHaveCount(0);

      // Recipient decrypts and can play it too.
      await expect(bob.locator('.bubble.in .att audio')).toBeVisible({ timeout: 20000 });
      await expect(bob.locator('.bubble.in .att', { hasText: '[Voice message]' })).toBeVisible();

      // Conversation preview shows the voice label.
      await expect(alice.locator('.row', { hasText: '[Voice message]' })).toBeVisible();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});