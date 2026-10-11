export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const tooMany = (message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message);

// Device-binding errors. Kept distinct so clients can drive the right UX
// (e.g. offer an explicit replacement flow) without leaking server internals.
export const deviceAlreadyRegistered = (details) =>
  new AppError(
    409,
    'device_already_registered',
    'Another device is already registered for this account',
    details,
  );
export const deviceNotAuthorized = (message = 'This device is not authorized for this account') =>
  new AppError(403, 'device_not_authorized', message);
export const deviceRevoked = (message = 'This device has been revoked') =>
  new AppError(403, 'device_revoked', message);
export const deviceReplacementRequired = (
  message = 'This session is no longer bound to the active device',
) => new AppError(403, 'device_replacement_required', message);

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
