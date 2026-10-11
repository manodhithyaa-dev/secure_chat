import { io, type Socket } from 'socket.io-client';

export interface IncomingMessageEvent {
  messageId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  alg: string;
  createdAt: number;
}

export interface MessageStatusEvent {
  messageId: string;
  status: 'acked' | 'delivered';
}

export interface PresenceEvent {
  userId: string;
  online: boolean;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * Create an authenticated Socket.IO connection. Auth travels in the HttpOnly
 * session cookie (same-origin), so no token is exposed to JS.
 *
 * Polling is attempted first and then upgraded to WebSocket. This matters for
 * dev proxies (Vite): the session cookie is reliably forwarded on the initial
 * HTTP polling handshake, whereas a direct WebSocket upgrade may not carry it.
 * Once the socket is authenticated, the transport upgrade does not re-auth.
 */
export function createSocket(): Socket {
  return io({
    path: '/socket.io',
    withCredentials: true,
    transports: ['polling', 'websocket'],
    autoConnect: true,
  });
}
