import { AppError } from '../middleware/errors.js';

/**
 * Small input validation helpers. Keeps dependencies minimal while
 * producing consistent 400 errors with field-level details.
 */

export function isValidUsername(username) {
  return typeof username === 'string' && /^[a-z0-9_]{3,32}$/.test(username);
}

export function isValidDisplayName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 64;
}

export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

export function requireString(value, field, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string') {
    throw new AppError(400, 'validation_error', `${field} must be a string`, { field });
  }
  const trimmed = value;
  if (trimmed.length < min || trimmed.length > max) {
    throw new AppError(400, 'validation_error', `${field} length must be between ${min} and ${max}`, {
      field,
    });
  }
  return trimmed;
}

export function requireObject(value, field = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'validation_error', `${field} must be an object`, { field });
  }
  return value;
}
