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

/**
 * Server view of an attachment (ticket before upload / row after upload).
 * All fields here are server-visible metadata only — no key, no plaintext.
 */
export interface AttachmentTicket {
  id: string;
  senderId: string;
  recipientId: string | null;
  messageId: string | null;
  kind: 'file' | 'image' | 'audio';
  name: string;
  contentType: string;
  plainSize: number;
  cipherSize: number;
  status: 'pending' | 'ready';
  createdAt: number;
  expiresAt: number;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function apiErrorFor(res: Response, payload: unknown): Promise<ApiError> {
  const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })
    ?.error;
  const code = err?.code || 'error';
  const deviceReason = sessionInvalidReasonFor(code);
  if (deviceReason) {
    notifySessionInvalid(deviceReason);
  } else if (res.status === 401) {
    notifySessionInvalid('session_expired');
  }
  return new ApiError(
    res.status,
    code,
    err?.message || `Request failed (${res.status})`,
    err?.details,
  );
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
    attachmentId?: string;
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
        attachmentId?: string;
      }>;
    }>('GET', '/messages/pending'),
  ackMessage: (messageId: string) =>
    request<{ ok: boolean; status: string }>('POST', '/messages/ack', { messageId }),
  messageStatus: (messageId: string) =>
    request<{ messageId: string; status: string }>(
      'GET',
      `/messages/status/${encodeURIComponent(messageId)}`,
    ),

  createAttachmentTicket: (body: {
    kind: string;
    name: string;
    contentType: string;
    plainSize: number;
    cipherSize: number;
  }) =>
    request<{ attachment: AttachmentTicket }>('POST', '/attachments', body),
  uploadAttachmentData: (id: string, blob: Blob, onProgress?: (p: number) => void) =>
    new Promise<{ ok: boolean; attachment: AttachmentTicket }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${BASE}/attachments/${encodeURIComponent(id)}/data`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            onProgress(event.loaded / event.total);
          }
        };
      }
      xhr.onload = () => {
        let payload: unknown = null;
        try {
          payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(1);
          resolve(payload as { ok: boolean; attachment: AttachmentTicket });
          return;
        }
        const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })
          ?.error;
        const code = err?.code || 'error';
        const deviceReason = sessionInvalidReasonFor(code);
        if (deviceReason) {
          notifySessionInvalid(deviceReason);
        } else if (xhr.status === 401) {
          notifySessionInvalid('session_expired');
        }
        reject(
          new ApiError(
            xhr.status,
            code,
            err?.message || `Upload failed (${xhr.status})`,
            err?.details,
          ),
        );
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Upload failed'));
      xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload aborted'));
      xhr.send(blob);
    }),
  downloadAttachment: async (id: string, onProgress?: (p: number) => void) => {
    const res = await fetch(`${BASE}/attachments/${encodeURIComponent(id)}/data`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) {
      throw await apiErrorFor(res, await readJson(res));
    }
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total) onProgress?.(received / total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer as ArrayBuffer;
  },
  deleteAttachment: (id: string) =>
    request<{ ok: boolean; deleted: boolean }>('DELETE', `/attachments/${encodeURIComponent(id)}`),

  getRtcConfig: () =>
    request<{ iceServers: RTCIceServer[] }>('GET', '/rtc-config'),
};

export default api;
