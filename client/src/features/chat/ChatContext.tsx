import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../../services/api';
import { notifySessionInvalid, sessionInvalidReasonFor } from '../../services/session';
import { createSocket, type ConnectionState, type IncomingMessageEvent } from '../../services/socket';
import {
  CALL_EVENTS,
  newCallId,
  type CallRingEvent,
  type CallRole,
  type CallSignalEvent,
  type CallSignalMessage,
  type CallStatus,
} from '../../services/callSignaling';
import { RtcPeer } from '../../services/peer';
import { storage } from '../../storage/repositories';
import {
  clearSessionCache,
  decryptMessage,
  encryptMessage,
  generateIdentity,
  getSessionKey,
} from '../../crypto';
import {
  base64ToBytes,
  bytesToBase64,
  decryptAttachmentBlob,
  encryptAttachmentBlob,
} from '../../crypto/attachment';
import {
  buildAttachmentPayload,
  parseMessagePayload,
  type AttachmentMeta,
} from '../../crypto/payload';
import type {
  Conversation,
  Friend,
  FriendRequest,
  IdentityRecord,
  LocalAttachment,
  LocalMessage,
  MessageStatus,
  OutboxRecord,
  SearchResult,
  User,
} from '../../types';
import type { Socket } from 'socket.io-client';

const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

function inferAttachmentKind(blob: Blob): LocalAttachment['kind'] {
  const t = (blob.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}

function attachmentPreviewFor(message: LocalMessage): string {
  const att = message.attachment;
  if (!att) return '';
  if (att.kind === 'image') return '[Photo]';
  if (att.kind === 'audio') return '[Voice message]';
  return `[File] ${att.name}`;
}

/** Locally-tracked 1:1 call. `peer` is always the other participant. */
export interface ActiveCall {
  callId: string;
  peer: Friend;
  role: CallRole;
  status: CallStatus;
  startedAt: number;
  muted: boolean;
  video: boolean;
}

export interface IncomingCallInfo {
  callId: string;
  caller: Friend;
  video: boolean;
}

interface ChatContextValue {
  user: User;
  identity: IdentityRecord | null;
  ready: boolean;
  bootError: string | null;
  connection: ConnectionState;
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  conversations: Conversation[];
  onlineUsers: string[];
  messages: Record<string, LocalMessage[]>;
  activePeerId: string | null;
  peerError: string | null;
  setActivePeerId: (peerId: string | null) => void;
  openConversation: (peerId: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  sendAttachment: (file: File) => Promise<void>;
  retryAttachment: (conversationId: string, messageId: string) => Promise<void>;
  retryAttachmentDownload: (conversationId: string, messageId: string) => Promise<void>;
  retryOutbox: () => Promise<void>;
  refresh: () => Promise<void>;
  search: (q: string) => Promise<SearchResult[]>;
  addFriend: (username: string) => Promise<void>;
  acceptRequest: (id: string) => Promise<void>;
  rejectRequest: (id: string) => Promise<void>;
  cancelRequest: (id: string) => Promise<void>;
call: ActiveCall | null;
  incomingCall: IncomingCallInfo | null;
  callError: string | null;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  callNotice: string | null;
  startCall: (peerId: string, kind?: 'audio' | 'video') => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

// Guards against concurrent identity creation. React StrictMode mounts
// effects twice in development; without this the app would generate two
// distinct key pairs and publish two devices, so peers could fetch the
// wrong public key and fail to decrypt.
const identityInit = new Map<string, Promise<IdentityRecord>>();

export function ChatProvider({ user, children }: { user: User; children: React.ReactNode }) {
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [messages, setMessages] = useState<Record<string, LocalMessage[]>>({});
  const [activePeerId, setActivePeerIdState] = useState<string | null>(null);
  const [peerError, setPeerError] = useState<string | null>(null);
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  const userRef = useRef(user);
  const identityRef = useRef<IdentityRecord | null>(null);
  const friendsRef = useRef<Friend[]>([]);
  const activePeerRef = useRef<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const peerKeysRef = useRef<Map<string, string>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const incomingRef = useRef<IncomingCallInfo | null>(null);
  const peerRef = useRef<RtcPeer | null>(null);

  userRef.current = user;
  identityRef.current = identity;
  friendsRef.current = friends;
  activePeerRef.current = activePeerId;
  callRef.current = call;
  incomingRef.current = incomingCall;

  const setActivePeerId = useCallback((peerId: string | null) => {
    activePeerRef.current = peerId;
    setActivePeerIdState(peerId);
  }, []);

  /**
   * The web client uses one device per account, enforced by the server. The
   * device itself is created during login/register, so here we only make sure
   * this account has an E2EE identity and publish its public key on that
   * device. No competing device is ever registered.
   */
  const ensureIdentity = useCallback(
    (userId: string): Promise<IdentityRecord> => {
      const inFlight = identityInit.get(userId);
      if (inFlight) return inFlight;

      const task = (async () => {
        let record = await storage.getIdentity(userId);
        if (!record) {
          const generated = await generateIdentity();
          record = {
            userId,
            publicKeyBase64: generated.publicKeyBase64,
            privateKey: generated.privateKey,
            algorithm: generated.algorithm,
            createdAt: Date.now(),
          };
          await storage.saveIdentity(record);
        }
        const res = await api.setDeviceIdentity({
          identityPublicKey: record.publicKeyBase64,
          algorithm: record.algorithm,
        });
        deviceIdRef.current = res.device.id;
        return record;
      })().finally(() => identityInit.delete(userId));

      identityInit.set(userId, task);
      return task;
    },
    [],
  );

  const getPeerPublicKey = useCallback(async (peerId: string): Promise<string> => {
    const cached = peerKeysRef.current.get(peerId);
    if (cached) return cached;
    const res = await api.getKeyBundle(peerId);
    const device = res.bundle.devices[0];
    if (!device) throw new Error('peer has not published an encryption key yet');
    peerKeysRef.current.set(peerId, device.identityPublicKey);
    return device.identityPublicKey;
  }, []);

  const refresh = useCallback(async () => {
    const ownerId = userRef.current.id;
    const [friendsRes, incomingRes, outgoingRes, conversationsRes] = await Promise.all([
      api.listFriends(),
      api.incomingRequests(),
      api.outgoingRequests(),
      storage.listConversations(ownerId),
    ]);
    setFriends(friendsRes.friends);
    friendsRef.current = friendsRes.friends;
    setIncoming(incomingRes.requests);
    setOutgoing(outgoingRes.requests);
    setConversations(conversationsRes);
  }, []);

  const upsertConversation = useCallback(async (message: LocalMessage) => {
    const ownerId = userRef.current.id;
    const existing = await storage.getConversation(ownerId, message.peerId);
    const friend = friendsRef.current.find((f) => f.id === message.peerId);
    const conversation: Conversation = existing ?? {
      id: message.peerId,
      ownerId,
      peerId: message.peerId,
      peerUsername: friend?.username ?? '',
      peerDisplayName: friend?.displayName ?? 'Unknown',
      lastMessageAt: 0,
      lastMessagePreview: '',
      unread: 0,
    };
    if (friend) {
      conversation.peerUsername = friend.username;
      conversation.peerDisplayName = friend.displayName;
    }
    conversation.lastMessageAt = message.createdAt;
    conversation.lastMessagePreview =
      (message.attachment ? attachmentPreviewFor(message) : null) ||
      message.plaintext ||
      '[encrypted message]';
    if (message.direction === 'in' && activePeerRef.current !== message.peerId) {
      conversation.unread += 1;
    }
    await storage.upsertConversation(ownerId, conversation);
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== conversation.id);
      next.push(conversation);
      return next.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    });
  }, []);

  const addMessageToState = useCallback((message: LocalMessage) => {
    setMessages((prev) => {
      const list = prev[message.conversationId] ? [...prev[message.conversationId]] : [];
      if (list.some((m) => m.id === message.id)) return prev;
      list.push(message);
      list.sort((a, b) => a.createdAt - b.createdAt);
      return { ...prev, [message.conversationId]: list };
    });
  }, []);

  const patchMessageInState = useCallback(
    (conversationId: string, messageId: string, patch: Partial<LocalMessage>) => {
      setMessages((prev) => {
        const list = prev[conversationId];
        if (!list) return prev;
        return {
          ...prev,
          [conversationId]: list.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
        };
      });
    },
    [],
  );

  /**
   * Load a stored message, transform it, persist it and mirror it into React
   * state. Used by the attachment pipelines to keep status/progress fresh.
   */
  const updateStoredMessage = useCallback(
    async (messageId: string, fn: (m: LocalMessage) => LocalMessage) => {
      const ownerId = userRef.current.id;
      const existing = await storage.getMessage(ownerId, messageId);
      if (!existing) return undefined;
      const next = fn(existing);
      await storage.saveMessage(ownerId, next);
      patchMessageInState(next.conversationId, messageId, next);
      return next;
    },
    [patchMessageInState],
  );

  /**
   * Download (encrypted) + decrypt an incoming attachment, storing the plain
   * media blob locally so it renders offline. Revokes stale object URLs.
   */
  const downloadIncomingAttachment = useCallback(
    async (messageId: string, meta: AttachmentMeta) => {
      await updateStoredMessage(messageId, (m) => ({
        ...m,
        attachment: {
          ...m.attachment!,
          serverId: m.attachment!.serverId ?? meta.id,
          meta,
          status: 'downloading',
          progress: 0,
          error: undefined,
        },
      }));
      try {
        const cipherArray = await api.downloadAttachment(meta.id, (p) => {
          void updateStoredMessage(messageId, (m) => ({
            ...m,
            attachment: { ...m.attachment!, progress: p },
          }));
        });
        const decrypted = await decryptAttachmentBlob(
          new Blob([cipherArray]),
          base64ToBytes(meta.key),
          base64ToBytes(meta.salt),
          (p) => {
            void updateStoredMessage(messageId, (m) => ({
              ...m,
              attachment: { ...m.attachment!, progress: p.total ? p.done / p.total : 1 },
            }));
          },
        );
        const url = URL.createObjectURL(decrypted);
        await updateStoredMessage(messageId, (m) => {
          const prev = m.attachment;
          if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
          return {
            ...m,
            attachment: { ...m.attachment!, blob: decrypted, objectUrl: url, status: 'available', progress: 1 },
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'download failed';
        await updateStoredMessage(messageId, (m) => ({
          ...m,
          attachment: { ...m.attachment!, status: 'failed', error: message },
        }));
      }
    },
    [updateStoredMessage],
  );

  const acknowledge = useCallback(async (messageId: string) => {
    const socket = socketRef.current;
    if (socket && socket.connected) {
      socket.emit('message:ack', { messageId });
    }
    try {
      await api.ackMessage(messageId);
    } catch {
      // Socket emit may have succeeded; retry will happen on next sync.
    }
  }, []);

  const handleIncoming = useCallback(
    async (event: IncomingMessageEvent): Promise<void> => {
      const me = userRef.current;
      const currentIdentity = identityRef.current;
      if (!currentIdentity) return;

      const existing = await storage.getMessage(me.id, event.messageId);
      if (existing) {
        // Deduplicate and re-acknowledge (handles a previously lost ack).
        await acknowledge(event.messageId);
        return;
      }

      let plaintext = '';
      let error: string | undefined;
      let attachment: LocalAttachment | undefined;
      try {
        const peerKey = await getPeerPublicKey(event.senderId);
        const sessionKey = await getSessionKey({
          myUserId: me.id,
          myPrivateKey: currentIdentity.privateKey,
          peerUserId: event.senderId,
          peerPublicKeyBase64: peerKey,
        });
        plaintext = await decryptMessage(
          sessionKey,
          { ciphertext: event.ciphertext, iv: event.iv, alg: 'AES-256-GCM' },
          { senderId: event.senderId, recipientId: me.id, messageId: event.messageId },
        );
        const parsed = parseMessagePayload(plaintext);
        if (parsed.type === 'attachment') {
          const meta = parsed.meta;
          attachment = {
            serverId: meta.id,
            kind: meta.kind,
            name: meta.name,
            mime: meta.mime,
            size: meta.size,
            cipherSize: meta.cipherSize,
            meta,
            status: 'downloading',
            progress: 0,
          };
        }
      } catch {
        error = 'Unable to decrypt this message';
        setPeerError(error);
      }

      const message: LocalMessage = {
        id: event.messageId,
        ownerId: me.id,
        conversationId: event.senderId,
        peerId: event.senderId,
        direction: 'in',
        senderId: event.senderId,
        recipientId: me.id,
        plaintext,
        ciphertext: event.ciphertext,
        iv: event.iv,
        alg: event.alg,
        status: 'delivered',
        createdAt: event.createdAt || Date.now(),
        updatedAt: Date.now(),
        error,
        ...(attachment ? { attachment } : {}),
      };
      await storage.saveMessage(me.id, message);
      addMessageToState(message);
      await upsertConversation(message);
      await acknowledge(message.id);
      if (attachment) {
        // The metadata/key/salt are already persisted; fetch + decrypt the
        // media asynchronously so the timeline renders without blocking.
        void downloadIncomingAttachment(message.id, attachment.meta!);
      }
    },
    [acknowledge, addMessageToState, getPeerPublicKey, upsertConversation, downloadIncomingAttachment],
  );

  const syncPending = useCallback(async () => {
    const res = await api.getPending();
    for (const envelope of res.messages) {
      await handleIncoming(envelope);
    }
  }, [handleIncoming]);

  const deliverOutboxRecord = useCallback(
    async (record: OutboxRecord) => {
      const ownerId = userRef.current.id;
      try {
        const res = await api.sendMessage({
          messageId: record.id,
          recipientId: record.recipientId,
          ciphertext: record.ciphertext,
          iv: record.iv,
          alg: record.alg,
          deviceId: deviceIdRef.current ?? undefined,
          attachmentId: record.attachmentId,
        });
        const status: MessageStatus = res.status === 'delivered' ? 'delivered' : 'sent';
        await storage.updateMessageStatus(ownerId, record.id, status);
        patchMessageInState(record.recipientId, record.id, { status, error: undefined });
        await storage.deleteOutbox(ownerId, record.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'send failed';
        await storage.upsertOutbox(ownerId, {
          ...record,
          attempts: record.attempts + 1,
          status: 'failed',
          lastError: message,
        });
        await storage.updateMessageStatus(ownerId, record.id, 'failed', message);
        patchMessageInState(record.recipientId, record.id, { status: 'failed', error: message });
      }
    },
    [patchMessageInState],
  );

  /**
   * Full outbound attachment pipeline: encrypt locally → create a server
   * ticket → stream the ciphertext → build the E2EE envelope containing the
   * content key/salt → submit the message (which links the attachment).
   */
  const uploadAndSendAttachment = useCallback(
    async (peerId: string, messageId: string, file: Blob, fileName: string) => {
      const me = userRef.current;
      const currentIdentity = identityRef.current;
      if (!currentIdentity) return;
      const kind = inferAttachmentKind(file);
      const mime = file.type || 'application/octet-stream';
      setPeerError(null);
      try {
        await updateStoredMessage(messageId, (m) => ({
          ...m,
          attachment: { ...m.attachment!, status: 'uploading', progress: 0, error: undefined },
        }));

        const encrypted = await encryptAttachmentBlob(file, (p) => {
          void updateStoredMessage(messageId, (m) => ({
            ...m,
            attachment: {
              ...m.attachment!,
              progress: p.total ? p.done / p.total : 1,
            },
          }));
        });

        const ticket = await api.createAttachmentTicket({
          kind,
          name: fileName,
          contentType: mime,
          plainSize: encrypted.plainSize,
          cipherSize: encrypted.cipherSize,
        });

        await api.uploadAttachmentData(ticket.attachment.id, encrypted.ciphertext, (p) => {
          void updateStoredMessage(messageId, (m) => ({
            ...m,
            attachment: { ...m.attachment!, serverId: ticket.attachment.id, progress: p },
          }));
        });

        const meta: AttachmentMeta = {
          id: ticket.attachment.id,
          kind,
          name: fileName,
          mime,
          size: encrypted.plainSize,
          cipherSize: encrypted.cipherSize,
          key: bytesToBase64(encrypted.key),
          salt: bytesToBase64(encrypted.salt),
        };
        const payloadText = buildAttachmentPayload(meta);

        const peerKey = await getPeerPublicKey(peerId);
        const sessionKey = await getSessionKey({
          myUserId: me.id,
          myPrivateKey: currentIdentity.privateKey,
          peerUserId: peerId,
          peerPublicKeyBase64: peerKey,
        });
        const payload = await encryptMessage(sessionKey, payloadText, {
          senderId: me.id,
          recipientId: peerId,
          messageId,
        });

        const now = Date.now();
        await updateStoredMessage(messageId, (m) => ({
          ...m,
          plaintext: payloadText,
          ciphertext: payload.ciphertext,
          iv: payload.iv,
          alg: payload.alg,
          status: 'pending',
          error: undefined,
          attachment: {
            ...m.attachment!,
            serverId: meta.id,
            meta,
            blob: m.attachment!.blob ?? file,
            objectUrl: m.attachment!.objectUrl ?? URL.createObjectURL(file),
            cipherSize: meta.cipherSize,
            status: 'available',
            progress: 1,
            error: undefined,
          },
        }));

        const record: OutboxRecord = {
          id: messageId,
          ownerId: me.id,
          recipientId: peerId,
          ciphertext: payload.ciphertext,
          iv: payload.iv,
          alg: payload.alg,
          createdAt: now,
          status: 'pending',
          attempts: 0,
          attachmentId: meta.id,
        };
        await storage.upsertOutbox(me.id, record);
        await deliverOutboxRecord(record);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'attachment failed';
        await updateStoredMessage(messageId, (m) => ({
          ...m,
          status: 'failed',
          error: message,
          attachment: { ...m.attachment!, status: 'failed', error: message },
        }));
      }
    },
    [deliverOutboxRecord, getPeerPublicKey, updateStoredMessage],
  );

  const sendAttachment = useCallback(
    async (file: File) => {
      const peerId = activePeerRef.current;
      const me = userRef.current;
      if (!peerId) return;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setPeerError(`Files are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB.`);
        return;
      }
      const messageId = crypto.randomUUID();
      const now = Date.now();
      const attachment: LocalAttachment = {
        serverId: null,
        kind: inferAttachmentKind(file),
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        cipherSize: null,
        meta: null,
        status: 'preparing',
        progress: 0,
        blob: file,
      };
      const message: LocalMessage = {
        id: messageId,
        ownerId: me.id,
        conversationId: peerId,
        peerId,
        direction: 'out',
        senderId: me.id,
        recipientId: peerId,
        plaintext: '',
        ciphertext: '',
        iv: '',
        alg: '',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        attachment,
      };
      await storage.saveMessage(me.id, message);
      addMessageToState(message);
      await upsertConversation(message);
      void uploadAndSendAttachment(peerId, messageId, file, file.name);
    },
    [addMessageToState, uploadAndSendAttachment, upsertConversation],
  );

  const retryAttachment = useCallback(
    async (_conversationId: string, messageId: string) => {
      const ownerId = userRef.current.id;
      const m = await storage.getMessage(ownerId, messageId);
      if (!m?.attachment?.blob) return;
      if (m.attachment.serverId) {
        await api.deleteAttachment(m.attachment.serverId).catch(() => {});
      }
      await updateStoredMessage(messageId, (msg) => ({
        ...msg,
        status: 'pending',
        error: undefined,
        attachment: { ...msg.attachment!, status: 'preparing', progress: 0, error: undefined },
      }));
      void uploadAndSendAttachment(m.peerId, messageId, m.attachment.blob, m.attachment.name);
    },
    [updateStoredMessage, uploadAndSendAttachment],
  );

  const retryAttachmentDownload = useCallback(
    async (_conversationId: string, messageId: string) => {
      const ownerId = userRef.current.id;
      const m = await storage.getMessage(ownerId, messageId);
      if (!m?.attachment?.meta) return;
      void downloadIncomingAttachment(messageId, m.attachment.meta);
    },
    [downloadIncomingAttachment],
  );

  const retryOutbox = useCallback(async () => {
    const records = await storage.listOutbox(userRef.current.id);
    for (const record of records) {
      if (record.status !== 'sent') {
        await deliverOutboxRecord(record);
      }
    }
  }, [deliverOutboxRecord]);

  const sendMessage = useCallback(
    async (text: string) => {
      const peerId = activePeerRef.current;
      const me = userRef.current;
      const currentIdentity = identityRef.current;
      if (!peerId || !currentIdentity) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setPeerError(null);

      const messageId = crypto.randomUUID();
      let payload;
      try {
        const peerKey = await getPeerPublicKey(peerId);
        const sessionKey = await getSessionKey({
          myUserId: me.id,
          myPrivateKey: currentIdentity.privateKey,
          peerUserId: peerId,
          peerPublicKeyBase64: peerKey,
        });
        payload = await encryptMessage(sessionKey, trimmed, {
          senderId: me.id,
          recipientId: peerId,
          messageId,
        });
      } catch (err) {
        setPeerError(err instanceof Error ? err.message : 'encryption failed');
        return;
      }

      const now = Date.now();
      const message: LocalMessage = {
        id: messageId,
        ownerId: me.id,
        conversationId: peerId,
        peerId,
        direction: 'out',
        senderId: me.id,
        recipientId: peerId,
        plaintext: trimmed,
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        alg: payload.alg,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      await storage.saveMessage(me.id, message);
      addMessageToState(message);
      await upsertConversation(message);

      const record: OutboxRecord = {
        id: messageId,
        ownerId: me.id,
        recipientId: peerId,
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        alg: payload.alg,
        createdAt: now,
        status: 'pending',
        attempts: 0,
      };
      await storage.upsertOutbox(me.id, record);
      await deliverOutboxRecord(record);
    },
    [addMessageToState, deliverOutboxRecord, getPeerPublicKey, upsertConversation],
  );

  const openConversation = useCallback(
    async (peerId: string) => {
      const ownerId = userRef.current.id;
      setActivePeerId(peerId);
      setPeerError(null);
      const loaded = (await storage.listMessages(ownerId, peerId)).map((m) => {
        const att = m.attachment;
        if (att && att.status === 'available' && att.blob && !att.objectUrl) {
          const attachment: LocalAttachment = {
            ...att,
            objectUrl: URL.createObjectURL(att.blob),
          };
          const hydrated: LocalMessage = { ...m, attachment };
          void storage.saveMessage(ownerId, hydrated);
          return hydrated;
        }
        if (att && att.status === 'downloading' && !att.blob) {
          const attachment: LocalAttachment = {
            ...att,
            status: 'failed',
            error: 'download interrupted',
          };
          const interrupted: LocalMessage = { ...m, attachment };
          void storage.saveMessage(ownerId, interrupted);
          return interrupted;
        }
        return m;
      });
      setMessages((prev) => ({ ...prev, [peerId]: loaded }));
      const conversation = await storage.getConversation(ownerId, peerId);
      if (conversation && conversation.unread > 0) {
        conversation.unread = 0;
        await storage.upsertConversation(ownerId, conversation);
        setConversations((prev) =>
          prev.map((c) => (c.id === peerId ? { ...c, unread: 0 } : c)),
        );
      }
    },
    [setActivePeerId],
  );

  const search = useCallback((q: string) => api.searchUsers(q).then((r) => r.results), []);

  const addFriend = useCallback(
    async (username: string) => {
      await api.sendFriendRequest(username);
      await refresh();
    },
    [refresh],
  );

  const acceptRequest = useCallback(
    async (id: string) => {
      await api.acceptRequest(id);
      await refresh();
    },
    [refresh],
  );

  const rejectRequest = useCallback(
    async (id: string) => {
      await api.rejectRequest(id);
      await refresh();
    },
    [refresh],
  );

  const cancelRequest = useCallback(
    async (id: string) => {
      await api.cancelRequest(id);
      await refresh();
    },
    [refresh],
  );

  const teardownCall = useCallback((reason?: string) => {
    peerRef.current?.close();
    peerRef.current = null;
    setRemoteStream(null);
    setLocalStream(null);
    setCall(null);
    setIncomingCall(null);
    if (reason) setCallNotice(reason);
  }, []);

  const sendCallSignal = useCallback((callId: string, message: CallSignalMessage) => {
    socketRef.current?.emit(CALL_EVENTS.signal, { callId, data: message });
  }, []);

  const newRtcPeer = useCallback(
    async (callId: string, mode: 'audio' | 'video' = 'audio') => {
      const conf = await api.getRtcConfig();
      const peer = new RtcPeer({
        iceServers: conf.iceServers,
        mode,
        onSignal: (message) => sendCallSignal(callId, message),
        onRemoteStream: (stream) => setRemoteStream(stream),
        onConnectionChange: (state) => {
          if (state === 'connected') {
            socketRef.current?.emit(CALL_EVENTS.connected, { callId });
            setCall((prev) =>
              prev && prev.callId === callId ? { ...prev, status: 'active' } : prev,
            );
          }
        },
        onError: (err) => setCallError(err.message),
      });
      const local = await peer.startLocalMedia();
      setLocalStream(local);
      return peer;
    },
    [sendCallSignal],
  );

  const handleCallSignal = useCallback(async (event: CallSignalEvent) => {
    const active = callRef.current;
    const peer = peerRef.current;
    if (!peer || !active || active.callId !== event.callId) return;
    const data = event.data;
    if (data.type === 'offer' && data.sdp) {
      await peer.acceptOffer(data.sdp);
    } else if (data.type === 'answer' && data.sdp) {
      await peer.applyAnswer(data.sdp);
    } else if (data.type === 'candidate' && data.candidate) {
      await peer.addRemoteCandidate(data.candidate);
    }
  }, []);

  const handleCallEnded = useCallback(
    (event: { callId: string; reason: string }) => {
      const incoming = incomingRef.current;
      if (incoming && incoming.callId === event.callId) {
        const label =
          event.reason === 'cancelled'
            ? 'The caller cancelled.'
            : 'The caller is no longer reachable.';
        teardownCall(label);
        return;
      }
      const active = callRef.current;
      if (!active || active.callId !== event.callId) return;
      const label =
        event.reason === 'peer_left'
          ? 'The other participant left the call.'
          : event.reason === 'timeout'
            ? 'Nobody answered the call.'
            : event.reason === 'declined'
              ? 'The call was declined.'
              : 'The call ended.';
      teardownCall(label);
    },
    [teardownCall],
  );

  const startCall = useCallback(
    async (peerId: string, kind: 'audio' | 'video' = 'audio') => {
      const peer = friendsRef.current.find((f) => f.id === peerId);
      const socket = socketRef.current;
      if (!peer || !socket || callRef.current || peerRef.current) return;
      const callId = newCallId();
      setCallError(null);
      setCallNotice(null);
      try {
        const rtc = await newRtcPeer(callId, kind);
        const now = Date.now();
        const active: ActiveCall = {
          callId,
          peer,
          role: 'caller',
          status: 'ringing',
          startedAt: now,
          muted: false,
          video: kind === 'video',
        };
        setCall(active);
        peerRef.current = rtc;
        socket.emit(CALL_EVENTS.invite, { callId, recipientId: peerId, kind }, (ack: {
          ok?: boolean;
          error?: string;
        }) => {
          if (ack?.ok) return;
          setCallError(ack?.error || 'The call could not be started.');
          teardownCall();
        });
      } catch (err) {
        setCallError(err instanceof Error ? err.message : 'Could not access the microphone.');
      }
    },
    [newRtcPeer, teardownCall],
  );

  const acceptCall = useCallback(async () => {
    const incoming = incomingRef.current;
    const socket = socketRef.current;
    if (!incoming || !socket || callRef.current || peerRef.current) return;
    const callId = incoming.callId;
    setCallError(null);
    setCallNotice(null);
    try {
      const rtc = await newRtcPeer(callId, incoming.video ? 'video' : 'audio');
      peerRef.current = rtc;
      const active: ActiveCall = {
        callId,
        peer: incoming.caller,
        role: 'callee',
        status: 'connecting',
        startedAt: Date.now(),
        muted: false,
        video: incoming.video,
      };
      setCall(active);
      setIncomingCall(null);
      socket.emit(CALL_EVENTS.accept, { callId }, (ack: { ok?: boolean; error?: string }) => {
        if (ack?.ok) return;
        setCallError(ack?.error || 'The call could not be accepted.');
        teardownCall();
      });
    } catch (err) {
      setCallError(err instanceof Error ? err.message : 'Could not access the microphone.');
    }
  }, [newRtcPeer, teardownCall]);

  const declineCall = useCallback(() => {
    const socket = socketRef.current;
    const active = callRef.current;
    const incoming = incomingRef.current;
    if (!socket) return;
    setCallNotice(null);
    if (incoming) {
      socket.emit(CALL_EVENTS.decline, { callId: incoming.callId });
      teardownCall('Call declined.');
      return;
    }
    if (active) {
      const event = active.status === 'ringing' ? CALL_EVENTS.cancel : CALL_EVENTS.end;
      socket.emit(event, { callId: active.callId });
      teardownCall();
    }
  }, [teardownCall]);

  const endCall = useCallback(() => {
    const socket = socketRef.current;
    const active = callRef.current;
    if (!socket || !active) return;
    socket.emit(CALL_EVENTS.end, { callId: active.callId });
    teardownCall('Call ended.');
  }, [teardownCall]);

  const toggleMute = useCallback(() => {
    peerRef.current?.setMuted(!(callRef.current?.muted ?? false));
    setCall((prev) => (prev ? { ...prev, muted: !prev.muted } : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ownerId = user.id;

    (async () => {
      try {
        const record = await ensureIdentity(user.id);
        if (cancelled) return;
        setIdentity(record);
        identityRef.current = record;

        await refresh();
        if (cancelled) return;

        const socket = createSocket();
        socketRef.current = socket;
        socket.on('connect', () => {
          if (cancelled) return;
          setConnection('connected');
          void syncPending();
          void retryOutbox();
        });
        socket.on('disconnect', () => {
          if (cancelled) return;
          setConnection('disconnected');
        });
        socket.io.on('reconnect_attempt', () => {
          if (cancelled) return;
          setConnection('connecting');
        });
        socket.on('connect_error', (err: Error) => {
          if (cancelled) return;
          const reason = sessionInvalidReasonFor(err?.message);
          if (reason) {
            notifySessionInvalid(reason);
            return;
          }
          setConnection('disconnected');
        });

        socket.on('message:new', (event: IncomingMessageEvent) => {
          if (cancelled) return;
          void handleIncoming(event);
        });
        socket.on(
          'message:status',
          (event: { messageId: string; status: string }) => {
            if (cancelled) return;
            const status: MessageStatus =
              event.status === 'acked' ? 'delivered' : (event.status as MessageStatus);
            void (async () => {
              await storage.updateMessageStatus(ownerId, event.messageId, status);
              if (cancelled) return;
              setMessages((prev) => {
                const next = { ...prev };
                for (const [key, list] of Object.entries(prev)) {
                  if (list.some((m) => m.id === event.messageId)) {
                    next[key] = list.map((m) =>
                      m.id === event.messageId ? { ...m, status } : m,
                    );
                  }
                }
                return next;
              });
            })();
          },
        );
        socket.on('friend:request', () => {
          if (!cancelled) void refresh();
        });
        socket.on('friend:accepted', () => {
          if (!cancelled) void refresh();
        });
        socket.on('friend:request:update', () => {
          if (!cancelled) void refresh();
        });
        socket.on('presence', (event: { userId: string; online: boolean }) => {
          if (cancelled) return;
          setOnlineUsers((prev) => {
            const set = new Set(prev);
            if (event.online) set.add(event.userId);
            else set.delete(event.userId);
            return [...set];
          });
        });
        socket.on('presence:snapshot', (event: { onlineFriends: string[] }) => {
          if (cancelled) return;
          setOnlineUsers(event.onlineFriends);
        });

        socket.on(CALL_EVENTS.ring, (event: CallRingEvent) => {
          if (cancelled) return;
          const caller: Friend = {
            id: event.caller.id,
            username: event.caller.username,
            displayName: event.caller.displayName,
          };
          setIncomingCall({
            callId: event.callId,
            caller,
            video: event.kind === 'video',
          });
        });
        socket.on('call:accepted', (event: { callId: string }) => {
          if (cancelled) return;
          const active = callRef.current;
          if (!active || active.callId !== event.callId) return;
          setCall((prev) =>
            prev && prev.callId === event.callId ? { ...prev, status: 'connecting' } : prev,
          );
          const peer = peerRef.current;
          if (peer && active.role === 'caller') {
            void peer.createOffer();
          }
        });
        socket.on(CALL_EVENTS.signal, (event: CallSignalEvent) => {
          if (cancelled) return;
          void handleCallSignal(event);
        });
        socket.on(CALL_EVENTS.ended, (event: { callId: string; reason: string }) => {
          if (cancelled) return;
          handleCallEnded(event);
        });

        await syncPending();
        if (cancelled) return;
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setBootError(err instanceof Error ? err.message : 'failed to initialize');
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      peerRef.current?.close();
      peerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      peerKeysRef.current.clear();
      clearSessionCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  useEffect(() => {
    if (!callNotice) return;
    const timer = setTimeout(() => setCallNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [callNotice]);

  const value = useMemo<ChatContextValue>(
    () => ({
      user,
      identity,
      ready,
      bootError,
      connection,
      friends,
      incoming,
      outgoing,
      conversations,
      onlineUsers,
      messages,
      activePeerId,
      peerError,
      setActivePeerId,
      openConversation,
      sendMessage,
      sendAttachment,
      retryAttachment,
      retryAttachmentDownload,
      retryOutbox,
      refresh,
      search,
      addFriend,
      acceptRequest,
      rejectRequest,
      cancelRequest,
      call,
      incomingCall,
      callError,
      remoteStream,
      localStream,
      callNotice,
      startCall,
      acceptCall,
      declineCall,
      endCall,
      toggleMute,
    }),
    [
      user,
      identity,
      ready,
      bootError,
      connection,
      friends,
      incoming,
      outgoing,
      conversations,
      onlineUsers,
      messages,
      activePeerId,
      peerError,
      setActivePeerId,
      openConversation,
      sendMessage,
      sendAttachment,
      retryAttachment,
      retryAttachmentDownload,
      retryOutbox,
      refresh,
      search,
      addFriend,
      acceptRequest,
      rejectRequest,
      cancelRequest,
      call,
      incomingCall,
      callError,
      remoteStream,
      localStream,
      callNotice,
      startCall,
      acceptCall,
      declineCall,
      endCall,
      toggleMute,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
