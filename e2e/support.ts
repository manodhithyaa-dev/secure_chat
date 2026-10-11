import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-passw0rd';

let counter = 0;

/** Unique, valid (server accepts a-z0-9_, <=32 chars) username per call. */
export function uniqueUsername(prefix = 'e2e'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter}`.toLowerCase();
}

/** Fill the auth form and submit it. Assumes the app is showing the auth screen. */
async function submitAuthForm(
  page: Page,
  opts: { username: string; password: string; displayName?: string },
): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.auth-screen')).toBeVisible();

  if (opts.displayName !== undefined) {
    await page.locator('.auth-tabs').getByRole('button', { name: 'Register' }).click();
    await page.getByLabel('Display name').fill(opts.displayName);
  } else {
    await page.locator('.auth-tabs').getByRole('button', { name: 'Log in' }).click();
  }

  await page.getByLabel('Username').fill(opts.username);
  await page.getByLabel('Password').fill(opts.password);
  await page.locator('button.primary[type="submit"]').click();
}

export async function assertInApp(page: Page): Promise<void> {
  await expect(page.locator('.app-shell')).toBeVisible();
  // The boot overlay disappears once encryption is ready.
  await expect(page.locator('.boot-overlay')).toBeHidden();
}

export async function register(
  page: Page,
  username: string,
  displayName: string,
): Promise<void> {
  await submitAuthForm(page, { username, password: PASSWORD, displayName });
  await assertInApp(page);
}

/** Submit a plain login (no replacement). Does not assert the outcome. */
export async function attemptLogin(
  page: Page,
  username: string,
): Promise<void> {
  await submitAuthForm(page, { username, password: PASSWORD });
}

export async function assertAuthScreen(page: Page): Promise<void> {
  await expect(page.locator('.auth-screen')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
}
