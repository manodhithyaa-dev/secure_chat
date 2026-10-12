/**
 * In-memory call state machine for 1:1 WebRTC calls.
 *
 * The backend is single-instance by design, and calls are inherently realtime,
 * so a volatile Map is the correct store (exactly like presence). All media
 * flows peer-to-peer; the server only relays signaling and enforces policy
 * (friendship, online state, one active call per user, ring timeout).
 */

import config from '../config.js';
import { areFriends } from '../friends/service.js';
import { emitToUser, isUserOnline } from '../sockets/emitter.js';

/** callId -> call record. */
const calls = new Map();

const RINGING = 'ringing'; // callee has been offered a call
const CONNECTING = 'connecting'; // both parties joined, ICE in flight
const ACTIVE = 'active'; // ICE connected (caller signalled call:connected)

function record(call) {
  calls.set(call.callId, call);
}

function timersFor(callId) {
  const call = calls.get(callId);
  return call?.timers || new Set();
}

function clearTimers(callId) {
  const timers = timersFor(callId);
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
}

function endCallRecord(callId, reason) {
  const call = calls.get(callId);
  if (!call) return null;
  clearTimers(callId);
  calls.delete(callId);
  for (const userId of call.participants) {
    emitToUser(userId, 'call:ended', { callId, reason });
  }
  return call;
}

/** Find a non-ended call a user is involved in. */
export function activeCallForUser(userId) {
  for (const call of calls.values()) {
    if (call.participants.has(userId)) return call;
  }
  return null;
}

export function getCall(callId) {
  return calls.get(callId) || null;
}

export function isMember(callId, userId) {
  return calls.get(callId)?.participants.has(userId) ?? false;
}

/**
 * Start ringing `calleeId` from `callerId`. Returns an error object
 * (message) or null on success.
 */
export function createCall({ callId, callerId, calleeId, kind = 'audio' }) {
  if (!callId || typeof callId !== 'string') {
    return { error: 'callId required' };
  }
  if (callerId === calleeId) return { error: 'cannot call yourself' };
  if (calls.has(callId)) return { error: 'callId already in use' };
  if (!areFriends(callerId, calleeId)) return { error: 'not_friends' };
  if (activeCallForUser(callerId)) return { error: 'caller_busy' };
  if (activeCallForUser(calleeId)) return { error: 'callee_busy' };
  if (!isUserOnline(calleeId)) return { error: 'callee_offline' };

  const call = {
    callId,
    callerId,
    calleeId,
    kind: kind === 'video' ? 'video' : 'audio',
    status: RINGING,
    participants: new Set([callerId, calleeId]),
    createdAt: Date.now(),
    timers: new Set(),
  };
  record(call);

  const timer = setTimeout(() => {
    // Nobody accepted within the ring window.
    endCallRecord(callId, 'timeout');
  }, config.callRingTimeoutMs);
  call.timers.add(timer);

  return { call, error: null };
}

/** Callee accepted; both sides now exchange SDP/ICE. */
export function acceptCall(callId, userId) {
  const call = calls.get(callId);
  if (!call) return { error: 'call_not_found' };
  if (userId !== call.calleeId) return { error: 'not_callee' };
  if (call.status !== RINGING) return { error: 'call_not_ringing' };
  call.status = CONNECTING;
  return { call, error: null };
}

/** Either participant marked the peer connection established. */
export function markConnected(callId, userId) {
  const call = calls.get(callId);
  if (!call) return { error: 'call_not_found' };
  if (!call.participants.has(userId)) return { error: 'not_participant' };
  clearTimers(callId);
  call.status = ACTIVE;
  return { call, error: null };
}

/** Callee (during ringing) declines; cleanup and tell the caller. */
export function declineCall(callId, userId) {
  const call = calls.get(callId);
  if (!call) return { error: 'call_not_found' };
  if (userId !== call.calleeId) return { error: 'not_callee' };
  if (call.status !== RINGING) return { error: 'call_not_ringing' };
  endCallRecord(callId, 'declined');
  return { call, error: null };
}

/** Caller cancels while ringing. */
export function cancelCall(callId, userId) {
  const call = calls.get(callId);
  if (!call) return { error: 'call_not_found' };
  if (userId !== call.callerId) return { error: 'not_caller' };
  endCallRecord(callId, 'cancelled');
  return { call, error: null };
}

/** Either participant ends an active/connecting call. */
export function endCall(callId, userId) {
  const call = calls.get(callId);
  if (!call) return { error: 'call_not_found' };
  if (!call.participants.has(userId)) return { error: 'not_participant' };
  endCallRecord(callId, call.status === RINGING ? 'declined' : 'ended');
  return { call, error: null };
}

/** A participant's socket went away unexpectedly. */
export function handleParticipantDisconnect(userId) {
  const call = activeCallForUser(userId);
  if (!call) return;
  endCallRecord(call.callId, 'peer_left');
}

/**
 * Relay a signaling message between participants. Draft messages are
 * still allowed after the other party has ring-cancelled/left; the server
 * just drops signals for unknown/gone calls.
 */
export function relaySignal(callId, fromUserId, data) {
  const call = calls.get(callId);
  if (!call || !call.participants.has(fromUserId)) return false;
  if (!data || typeof data.type !== 'string') return false;
  const to = fromUserId === call.callerId ? call.calleeId : call.callerId;
  // A stalled call must not be flooded: signals expire shortly after the
  // connection would have completed.
  if (
    call.status === CONNECTING &&
    Date.now() - call.createdAt > config.callSignalingTtlMs
  ) {
    return false;
  }
  emitToUser(to, 'call:signal', {
    callId,
    from: fromUserId,
    data: {
      type: data.type,
      sdp: data.sdp ?? null,
      candidate: data.candidate ?? null,
    },
  });
  return true;
}

/** In-memory diagnostics (used by tests). */
export function __resetCallsForTests() {
  calls.clear();
}