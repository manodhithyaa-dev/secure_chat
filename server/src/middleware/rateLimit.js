import config from '../config.js';
import { tooMany } from './errors.js';

/**
 * Minimal in-memory fixed-window rate limiter. The MVP backend is
 * single-instance by design, so no shared store is required.
 */
export function rateLimit({
  windowMs = config.rateLimitWindowMs,
  max = config.rateLimitMax,
  keyFn = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
} = {}) {
  const hits = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = keyFn(req);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return next(tooMany());
    }
    return next();
  };
}

/** Stricter limiter for credential endpoints. */
export function authRateLimit() {
  return rateLimit({ windowMs: 60_000, max: config.authRateLimitMax });
}
