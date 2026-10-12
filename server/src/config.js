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

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
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
  // Mark the session cookie Secure. Defaults on in production, but can be
  // overridden for deployments that terminate TLS elsewhere (or plain HTTP).
  cookieSecure: bool(process.env.COOKIE_SECURE, (process.env.NODE_ENV || 'development') === 'production'),
  challengeTtlMs: int(process.env.CHALLENGE_TTL_MS, 2 * 60 * 1000),
  messageTtlMs: int(process.env.MESSAGE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  cleanupIntervalMs: int(process.env.CLEANUP_INTERVAL_MS, 60 * 60 * 1000),
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 120),
  authRateLimitMax: int(process.env.AUTH_RATE_LIMIT_MAX, 20),
  // Encrypted attachment storage. Only ciphertext ever touches disk.
  attachmentDir: resolveFromServer(process.env.ATTACHMENT_DIR || './data/attachments'),
  // Size of the stored (encrypted) attachment, not the plaintext.
  attachmentMaxBytes: int(process.env.ATTACHMENT_MAX_BYTES, 16 * 1024 * 1024),
  // Total storage a single account may hold in non-expired attachments.
  attachmentQuotaBytes: int(process.env.ATTACHMENT_QUOTA_BYTES, 256 * 1024 * 1024),
  // Unpaid tickets are garbage collected after this long without being sent.
  attachmentPendingTtlMs: int(
    process.env.ATTACHMENT_PENDING_TTL_MS,
    24 * 60 * 60 * 1000,
  ),
  callRingTimeoutMs: int(process.env.CALL_RING_TIMEOUT_MS, 45 * 1000),
  callSignalingTtlMs: int(process.env.CALL_SIGNALING_TTL_MS, 60 * 1000),
  rtcIceServers: buildIceServers(),
};

function buildIceServers() {
  const servers = [];
  const stuns = (process.env.RTC_STUN_SERVERS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stuns.length > 0) {
    servers.push({ urls: stuns });
  }
  const turnUrl = process.env.RTC_TURN_URL;
  if (turnUrl) {
    const turn = { urls: turnUrl };
    const username = process.env.RTC_TURN_USERNAME;
    const credential = process.env.RTC_TURN_CREDENTIAL;
    if (username && credential) {
      turn.username = username;
      turn.credential = credential;
    }
    servers.push(turn);
  }
  return servers;
}

export default config;
