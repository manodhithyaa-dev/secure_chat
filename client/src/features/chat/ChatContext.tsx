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
import { storage } from '../../storage/repositories';
import {
  clearSessionCache,
  decryptMessage,
  encryptMessage,
  generateIdentity,
  getSessionKey,
} from '../../crypto';
import type {
  Conversation,
  Friend,
  FriendRequest,
  IdentityRecord,
  LocalMessage,
  MessageStatus,
  OutboxRecord,
  SearchResult,
  User,
} from '../../types';
import type { Socket } from 'socket.io-client';

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
  retryOutbox: () => Promise<void>;
  refresh: () => Promise<void>;
  search: (q: string) => Promise<SearchResult[]>;
  addFriend: (username: string) => Promise<void>;
  acceptRequest: (id: string) => Promise<void>;
  rejectRequest: (id: string) => Promise<void>;
  cancelRequest: (id: string) => Promise<void>;
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

  const userRef = useRef(user);
  const identityRef = useRef<IdentityRecord | null>(null);
  const friendsRef = useRef<Friend[]>([]);
  const activePeerRef = useRef<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const peerKeysRef = useRef<Map<string, string>>(new Map());
  const socketRef = useRef<Socket | null>(null);

  userRef.current = user;
  identityRef.current = identity;
  friendsRef.current = friends;
  activePeerRef.current = activePeerId;

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
    conversation.lastMessagePreview = message.plaintext || '[encrypted message]';
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
      };
      await storage.saveMessage(me.id, message);
      addMessageToState(message);
      await upsertConversation(message);
      await acknowledge(message.id);
    },
    [acknowledge, addMessageToState, getPeerPublicKey, upsertConversation],
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
      const loaded = await storage.listMessages(ownerId, peerId);
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
      socketRef.current?.close();
      socketRef.current = null;
      peerKeysRef.current.clear();
      clearSessionCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

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
      retryOutbox,
      refresh,
      search,
      addFriend,
      acceptRequest,
      rejectRequest,
      cancelRequest,
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
      retryOutbox,
      refresh,
      search,
      addFriend,
      acceptRequest,
      rejectRequest,
      cancelRequest,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
