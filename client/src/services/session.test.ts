import { describe, it, expect, afterEach } from 'vitest';
import {
  notifySessionInvalid,
  onSessionInvalid,
  sessionInvalidReasonFor,
  type SessionInvalidReason,
} from './session';

const unsubs: Array<() => void> = [];

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.();
});

describe('session invalidation signal', () => {
  it('maps device auth codes to a reason and ignores others', () => {
    expect(sessionInvalidReasonFor('device_replacement_required')).toBe('device_replaced');
    expect(sessionInvalidReasonFor('device_not_authorized')).toBe('device_replaced');
    expect(sessionInvalidReasonFor('device_revoked')).toBe('device_revoked');
    expect(sessionInvalidReasonFor('invalid_credentials')).toBeNull();
    expect(sessionInvalidReasonFor(undefined)).toBeNull();
  });

  it('notifies subscribers with a human-readable message', () => {
    const seen: SessionInvalidReason[] = [];
    const messages: string[] = [];
    unsubs.push(
      onSessionInvalid((notice) => {
        seen.push(notice.reason);
        messages.push(notice.message);
      }),
    );

    notifySessionInvalid('device_replaced');

    expect(seen).toEqual(['device_replaced']);
    expect(messages[0]).toMatch(/another device/i);
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    const off = onSessionInvalid(() => {
      calls += 1;
    });
    off();
    notifySessionInvalid('device_revoked');
    expect(calls).toBe(0);
  });
});
