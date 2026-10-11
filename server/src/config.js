import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');

function loadEnvFile(file) {
  try {
    if (fs.existsSync(file)) {
      if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(file);
      }
      return true;
    }
  } catch {
    // ignore malformed env files
  }
  return false;
}

loadEnvFile(path.join(serverRoot, '.env'));
loadEnvFile(path.join(repoRoot, '.env'));

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveFromServer(p) {
  if (!p) return p;
  if (p === ':memory:') return p;
  return path.isAbsolute(p) ? p : path.resolve(serverRoot, p);
}

export const config = {
  serverRoot,
  repoRoot,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  databaseFile: resolveFromServer(process.env.DATABASE_FILE || './data/securechat.sqlite'),
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  challengeTtlMs: int(process.env.CHALLENGE_TTL_MS, 2 * 60 * 1000),
  messageTtlMs: int(process.env.MESSAGE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  cleanupIntervalMs: int(process.env.CLEANUP_INTERVAL_MS, 60 * 60 * 1000),
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 120),
};

export default config;
