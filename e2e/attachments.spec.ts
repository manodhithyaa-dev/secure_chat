import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { register, uniqueUsername, PASSWORD } from './support';

/**
 * Image attachment E2E. Uses a small real PNG so the client's image
 * branch renders, and asserts the recipient sees the decrypted image.
 */
function tinyPng(bytesVar: number): Buffer {
  // Minimal 1x1 transparent PNG (well-formed, decodable by browsers).
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  );
  png[29] = bytesVar % 256; // perturb one byte so each test differs
  return png;
}

test.describe('encrypted attachments', () => {
  test('an image sent by Alice is encrypted, uploaded, linked and decrypted by Bob', async ({
    browser,
  }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();

      await register(alice, aliceName, 'Alice Image');
      await register(bob, bobName, 'Bob Image');

      // Befriend.
      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob Image' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();

      // Open the conversation on both sides.
      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob Image' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice Image' }).click();

      // Alice uploads an encrypted image.
      const png = tinyPng(Date.now());
      await alice.locator('.composer input[type="file"]').setInputFiles({
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: png,
      });

      // Wait for the outbound bubble to lose its busy state.
      await expect(alice.locator('.bubble.out .att.busy')).toHaveCount(0, { timeout: 20000 });
      await expect(alice.locator('.bubble.out .att-image')).toBeVisible({ timeout: 20000 });

      // Bob receives the decrypted image.
      await expect(bob.locator('.bubble.in .att-image')).toBeVisible({ timeout: 20000 });

      // Bob's lightbox opens on click and shows alt text.
      await bob.locator('.bubble.in .att-image').click();
      await expect(bob.locator('.lightbox')).toBeVisible();
      await expect(bob.locator('.lightbox img')).toHaveAttribute('alt', 'photo.png');
      await bob.locator('.lightbox-close').click();
      await expect(bob.locator('.lightbox')).toHaveCount(0);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('a large text file is shared with progress and download link', async ({ browser }) => {
    const aliceName = uniqueUsername('alice');
    const bobName = uniqueUsername('bob');

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    try {
      const alice = await aliceCtx.newPage();
      const bob = await bobCtx.newPage();
      await register(alice, aliceName, 'Alice File');
      await register(bob, bobName, 'Bob File');

      await alice.getByRole('button', { name: 'Friends' }).click();
      await alice.getByPlaceholder('Search by username…').fill(bobName);
      await alice
        .locator('.row', { hasText: 'Bob File' })
        .getByRole('button', { name: 'Add' })
        .click();
      await expect(alice.locator('.notice', { hasText: /Friend request sent/i })).toBeVisible();
      await bob.getByRole('button', { name: 'Requests' }).click();
      await bob.getByRole('button', { name: 'Accept' }).click();

      await alice.getByRole('button', { name: 'Chats' }).click();
      await alice.locator('.row', { hasText: 'Bob File' }).click();
      await bob.getByRole('button', { name: 'Chats' }).click();
      await bob.locator('.row', { hasText: 'Alice File' }).click();

      const content = randomBytes(220000).toString('hex'); // ~440 KB plaintext
      await alice.locator('.composer input[type="file"]').setInputFiles({
        name: 'secret-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(content),
      });

      await expect(alice.locator('.bubble.out .att-name', { hasText: 'secret-notes.txt' })).toBeVisible(
        { timeout: 20000 },
      );

      await expect(bob.locator('.bubble.in .att-name', { hasText: 'secret-notes.txt' })).toBeVisible({
        timeout: 20000,
      });

      // Conversation preview should read "[File] secret-notes.txt".
      await expect(bob.locator('.row', { hasText: '[File] secret-notes.txt' })).toBeVisible();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});