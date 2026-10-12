import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Runs the real server against an in-memory SQLite database and the real Vite
 * client on dedicated, isolated ports so the E2E run never touches the
 * development database or the dev servers on :4000 / :5173.
 */
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT || 4500);
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT || 5573);

const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: CLIENT_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start -w server',
      url: `${SERVER_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_FILE: ':memory:',
        CORS_ORIGIN: CLIENT_URL,
        NODE_ENV: 'test',
        RATE_LIMIT_MAX: '1000',
      },
    },
    {
      command: `npm run dev -w client -- --port ${CLIENT_PORT} --strictPort`,
      url: CLIENT_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_API_PROXY_TARGET: SERVER_URL,
      },
    },
  ],
});
