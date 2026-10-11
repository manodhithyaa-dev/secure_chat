/**
 * Cross-cutting signal for "this browser's session is no longer valid".
 *
 * The server binds every session to a single active device. When that device is
 * replaced (or its session expires), REST calls fail and the socket handshake is
 * rejected. Those failures are reported here so the auth layer can sign the
 * browser out instead of leaving it on a broken, half-authenticated screen.
 */
export type SessionInvalidReason = 'device_replaced' | 'device_revoked' | 'session_expired';

interface SessionNotice {
  reason: SessionInvalidReason;
  message: string;
}

type Handler = (notice: SessionNotice) => void;

const handlers = new Set<Handler>();

const MESSAGES: Record<SessionInvalidReason, string> = {
  device_replaced: 'This account was signed in on another device, so this one was signed out.',
  device_revoked: 'This device is no longer authorized for this account.',
  session_expired: 'Your session expired. Please sign in again.',
};

export function onSessionInvalid(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function notifySessionInvalid(reason: SessionInvalidReason): void {
  const notice: SessionNotice = { reason, message: MESSAGES[reason] };
  for (const handler of handlers) handler(notice);
}

/** Map a server/Socket.IO error into a reason, or null if it is not session-fatal. */
export function sessionInvalidReasonFor(code: string | undefined): SessionInvalidReason | null {
  switch (code) {
    case 'device_replacement_required':
    case 'device_not_authorized':
      return 'device_replaced';
    case 'device_revoked':
      return 'device_revoked';
    default:
      return null;
  }
}
