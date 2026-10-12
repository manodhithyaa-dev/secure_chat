import type { AttachmentMeta } from '../crypto/payload';

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt?: number;
}

export interface Friend {
  id: string;
  username: string;
  displayName: string;
  friendsSince?: number;
}

export interface SearchResult {
  id: string;
  username: string;
  displayName: string;
  relationship: 'none' | 'pending' | 'friends';
}

export interface FriendRequestUser {
  id: string;
  username: string;
  displayName: string;
}

export interface FriendRequest {
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  from: FriendRequestUser | { id: string };
  to: FriendRequestUser | { id: string };
  createdAt: number;
  respondedAt?: number | null;
}

export type MessageDirection = 'in' | 'out';

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'failed';

export type LocalAttachmentStatus =
  | 'preparing'
  | 'uploading'
  | 'downloading'
  | 'available'
  | 'failed'
  | 'cancelled';

/** Client-side view of an attachment attached to a message. */
export interface LocalAttachment {
  /** Server's opaque attachment id (null until the ticket exists). */
  serverId: string | null;
  kind: 'file' | 'image' | 'audio';
  name: string;
  mime: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Encrypted size in bytes. */
  cipherSize: number | null;
  /**
   * Metadata envelope (id/key/salt). Present once the message plaintext is
   * built (outgoing) or decrypted (incoming).
   */
  meta: AttachmentMeta | null;
  status: LocalAttachmentStatus;
  /** 0..1 upload/download progress. */
  progress: number;
  /** Decrypted media, persisted locally for offline viewing. */
  blob?: Blob;
  /** Transient object URL for rendering; never persisted. */
  objectUrl?: string;
  error?: string;
}

export interface LocalMessage {
  id: string;
  ownerId: string;
  conversationId: string;
  peerId: string;
  direction: MessageDirection;
  senderId: string;
  recipientId: string;
  plaintext: string;
  ciphertext: string;
  iv: string;
  alg: string;
  status: MessageStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** Present for attachment messages (images, files, voice). */
  attachment?: LocalAttachment;
}

export interface OutboxRecord {
  id: string;
  ownerId: string;
  recipientId: string;
  ciphertext: string;
  iv: string;
  alg: string;
  createdAt: number;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError?: string;
  /** Server attachment id to link when the message is submitted. */
  attachmentId?: string;
}

export interface Conversation {
  id: string;
  ownerId: string;
  peerId: string;
  peerUsername: string;
  peerDisplayName: string;
  lastMessageAt: number;
  lastMessagePreview: string;
  unread: number;
}

/** Unattributed pre-v2 record kept in the recoverable legacy archive. */
export interface LegacyRecord {
  legacyId: string;
  sourceStore: string;
  schemaVersion: number;
  migratedAt: number;
  data: Record<string, unknown>;
}

export interface IdentityRecord {
  userId: string;
  publicKeyBase64: string;
  privateKey: CryptoKey;
  algorithm: string;
  createdAt: number;
}

/**
 * This browser's single device credential. The signing private key proves
 * possession of the registered device without ever leaving the client.
 */
export interface DeviceAuthRecord {
  id: 'current';
  clientDeviceId: string;
  signingPublicKey: string;
  privateKey: CryptoKey;
  createdAt: number;
}

export interface Device {
  id: string;
  name: string;
  clientDeviceId: string | null;
  identityPublicKey: string | null;
  algorithm: string | null;
  hasSigningKey: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface DeviceRegistration {
  clientDeviceId: string;
  name: string;
  signingPublicKey: string;
}

export interface DeviceProof {
  challengeId: string;
  signature: string;
}

export interface PendingEnvelope {
  messageId: string;
  senderId: string;
  recipientId?: string;
  ciphertext: string;
  iv: string;
  alg: string;
  createdAt?: number;
}

export interface KeyBundle {
  userId: string;
  username: string;
  displayName: string;
  devices: Array<{
    id: string;
    name: string;
    identityPublicKey: string;
    algorithm: string;
  }>;
}
