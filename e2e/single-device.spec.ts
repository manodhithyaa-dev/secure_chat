import { test, expect } from '@playwright/test';
import {
  PASSWORD,
  assertAuthScreen,
  assertInApp,
  attemptLogin,
  register,
  uniqueUsername,
} from './support';

test.describe('single-device account sessions', () => {
  test('a new account registers its first device and can access the app', async ({
    page,
  }) => {
    const username = uniqueUsername('first');
    await register(page, username, 'First Device');

    // The authenticated shell is usable and a legitimate refresh keeps it.
    await expect(page.getByRole('heading', { name: 'Welcome to SecureChat' })).toBeVisible();
    await page.reload();
    await assertInApp(page);
  });

  test('a second device is rejected without explicit replacement authorization', async ({
    browser,
  }) => {
    const username = uniqueUsername('second');
    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext();
    try {
      const pageA = await deviceA.newPage();
      const pageB = await deviceB.newPage();

      await register(pageA, username, 'Owner A');

      await pageB.goto('/');
      await pageB.getByLabel('Username').fill(username);
      await pageB.getByLabel('Password').fill(PASSWORD);
      const [response] = await Promise.all([
        pageB.waitForResponse(
          (r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST',
        ),
        pageB.locator('button.primary[type="submit"]').click(),
      ]);

      // Server rejects by default with a machine-readable code...
      expect(response.status()).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('device_already_registered');

      // ...and the UI explains the situation without granting access.
      await expect(pageB.getByText(/already has a registered device/i)).toBeVisible();
      await expect(
        pageB.getByRole('button', { name: /sign out the other device/i }),
      ).toBeVisible();
      await assertAuthScreen(pageB);
    } finally {
      await deviceA.close();
      await deviceB.close();
    }
  });

  test('authorized replacement signs out the previous device; the new device authenticates', async ({
    browser,
  }) => {
    const username = uniqueUsername('replace');
    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext();
    try {
      const pageA = await deviceA.newPage();
      const pageB = await deviceB.newPage();

      await register(pageA, username, 'Owner A');

      // Second device attempts a plain login, then explicitly replaces.
      await attemptLogin(pageB, username);
      await expect(
        pageB.getByRole('button', { name: /sign out the other device/i }),
      ).toBeVisible();
      await pageB.getByRole('button', { name: /sign out the other device/i }).click();
      await assertInApp(pageB);

      // The replaced device is denied access and is returned to the login screen.
      await pageA.reload();
      await assertAuthScreen(pageA);
      await expect(
        pageA.getByText(/no longer authorized|signed in on another device/i),
      ).toBeVisible();

      // The replacement device keeps legitimate access across a refresh/reconnect.
      await pageB.reload();
      await assertInApp(pageB);
      await expect(pageB.getByText('Connected')).toBeVisible();
    } finally {
      await deviceA.close();
      await deviceB.close();
    }
  });
});
