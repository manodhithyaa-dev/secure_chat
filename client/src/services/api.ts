import type {
  Device,
  DeviceProof,
  DeviceRegistration,
  Friend,
  FriendRequest,
  KeyBundle,
  SearchResult,
  User,
} from '../types';
import { notifySessionInvalid, sessionInvalidReasonFor } from './session';

const BASE = '/api/v1';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    const code = err?.code || 'error';
    const deviceReason = sessionInvalidReasonFor(code);
    if (deviceReason) {
      notifySessionInvalid(deviceReason);
    } else if (res.status === 401 && !path.startsWith('/auth/')) {
      notifySessionInvalid('session_expired');
    }
    throw new ApiError(
      res.status,
      code,
      err?.message || `Request failed (${res.status})`,
      err?.details,
    );
  }
  return payload as T;
}

export const api = {
  challenge: (username?: string) =>
    request<{ challengeId: string; challenge: string; expiresAt: number }>(
      'POST',
      '/auth/challenge',
      { username },
    ),
  register: (body: {
    username: string;
    displayName: string;
    password: string;
    device: DeviceRegistration;
    proof: DeviceProof;
  }) => request<{ user: User; token: string; device: Device }>('POST', '/auth/register', body),
  login: (body: {
    username: string;
    password: string;
    device: DeviceRegistration;
    proof: DeviceProof;
    replace?: boolean;
  }) => request<{ user: User; token: string; device: Device; replaced: boolean }>(
    'POST',
    '/auth/login',
    body,
  ),
  logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
  me: () => request<{ user: User; device: Device | null }>('GET', '/auth/me'),

  searchUsers: (q: string) =>
    request<{ results: SearchResult[] }>('GET', `/users/search?q=${encodeURIComponent(q)}`),

  listFriends: () => request<{ friends: Friend[] }>('GET', '/friends'),
  sendFriendRequest: (username: string) =>
    request<{ request: FriendRequest }>('POST', '/friend-requests', { username }),
  incomingRequests: () =>
    request<{ requests: FriendRequest[] }>('GET', '/friend-requests/incoming'),
  outgoingRequests: () =>
    request<{ requests: FriendRequest[] }>('GET', '/friend-requests/outgoing'),
  acceptRequest: (id: string) =>
    request<{ request: FriendRequest }>('POST', `/friend-requests/${id}/accept`),
  rejectRequest: (id: string) =>
    request<{ request: FriendRequest }>('POST', `/friend-requests/${id}/reject`),
  cancelRequest: (id: string) =>
    request<{ request: FriendRequest }>('DELETE', `/friend-requests/${id}`),

  setDeviceIdentity: (body: { identityPublicKey: string; algorithm: string }) =>
    request<{ device: Device }>('PUT', '/devices/current/identity', body),
  listDevices: () => request<{ devices: Device[] }>('GET', '/devices'),
  revokeDevice: (id: string) => request<{ device: Device }>('DELETE', `/devices/${id}`),
  getKeyBundle: (userId: string) =>
    request<{ bundle: KeyBundle }>('GET', `/keys/${encodeURIComponent(userId)}`),

  sendMessage: (body: {
    messageId: string;
    recipientId: string;
    ciphertext: string;
    iv: string;
    alg: string;
    deviceId?: string;
  }) =>
    request<{ messageId: string; status: string; queued: boolean; duplicate: boolean }>(
      'POST',
      '/messages',
      body,
    ),
  getPending: () =>
    request<{
      messages: Array<{
        messageId: string;
        senderId: string;
        recipientId: string;
        ciphertext: string;
        iv: string;
        alg: string;
        createdAt: number;
      }>;
    }>('GET', '/messages/pending'),
  ackMessage: (messageId: string) =>
    request<{ ok: boolean; status: string }>('POST', '/messages/ack', { messageId }),
  messageStatus: (messageId: string) =>
    request<{ messageId: string; status: string }>(
      'GET',
      `/messages/status/${encodeURIComponent(messageId)}`,
    ),
};

export default api;
