/**
 * Types shared between the Socket.IO signaling channel and the local RTC
 * layer. These mirror the server's call:handle payloads exactly.
 */

export type CallRole = 'caller' | 'callee';

/** Server-side call lifecycle states (mirrors server/service.js). */
export type CallStatus = 'ringing' | 'connecting' | 'active';

export type CallEndReason = 'ended' | 'declined' | 'cancelled' | 'timeout' | 'peer_left';

/** Minimal peer identity carried in a ring notification. */
export interface CallPeer {
  id: string;
  username: string;
  displayName: string;
}

export interface CallRingEvent {
  callId: string;
  kind: 'audio' | 'video';
  caller: CallPeer;
}

export interface CallAcceptedEvent {
  callId: string;
}

export interface CallEndedEvent {
  callId: string;
  reason: CallEndReason;
}

export interface CallSignalMessage {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: string | null;
  candidate?: string | null;
}

export interface CallSignalEvent {
  callId: string;
  from: string;
  data: CallSignalMessage;
}

export interface CallAck {
  ok: boolean;
  callId?: string;
  error?: string;
  code?: string;
}

export const CALL_EVENTS = {
  ring: 'call:ring',
  accepted: 'call:accepted',
  ended: 'call:ended',
  signal: 'call:signal',
  invite: 'call:invite',
  accept: 'call:accept',
  decline: 'call:decline',
  cancel: 'call:cancel',
  end: 'call:end',
  connected: 'call:connected',
} as const;

export function newCallId(): string {
  return crypto.randomUUID();
}