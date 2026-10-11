import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbChatStorage } from './repositories';
import { LEGACY_STORES, STORES, closeIdb, openIdb, resetIdb } from './idb';
import type { Conversation, LocalMessage, OutboxRecord } from '../types';

const DB = 'securechat-storage-test';

let storage: IndexedDbChatStorage;
let seq = 0;

function makeMessage(ownerId: string, id: string, conversationId: string): LocalMessage {
  seq += 1;
  return {
    id,
    ownerId,
    conversationId,
    peerId: conversationId,
    direction: 'out',
    senderId: ownerId,
    recipientId: conversationId,
    plaintext: `body ${id}`,
    ciphertext: `cipher ${id}`,
    iv: 'iv',
    alg: 'AES-256-GCM',
    status: 'pending',
    createdAt: seq,
    updatedAt: seq,
  };
}

function makeConversation(ownerId: string, peerId: string): Conversation {
  return {
    id: peerId,
    ownerId,
    peerId,
    peerUsername: peerId,
    peerDisplayName: peerId,
    lastMessageAt: 0,
    lastMessagePreview: '',
    unread: 0,
  };
}

function makeOutbox(ownerId: string, id: string): OutboxRecord {
  return {
    id,
    ownerId,
    recipientId: 'peer',
    ciphertext: 'c',
    iv: 'iv',
    alg: 'AES-256-GCM',
    createdAt: 1,
    status: 'pending',
    attempts: 0,
  };
}

async function rawCount(dbName: string, storeName: string): Promise<number> {
  const db = await openIdb(dbName);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteMetaFlag(dbName: string): Promise<void> {
  const db = await openIdb(dbName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.meta, 'readwrite');
    tx.objectStore(STORES.meta).delete('legacyArchiveVersion');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Build a v1 database with legacy (ownerless) records, then close it. */
function seedLegacyV1(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('identity', { keyPath: 'userId' });
      db.createObjectStore('meta', { keyPath: 'key' });
      const messages = db.createObjectStore('messages', { keyPath: 'id' });
      messages.createIndex('conversationId', 'conversationId', { unique: false });
      db.createObjectStore('conversations', { keyPath: 'id' });
      db.createObjectStore('outbox', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['messages', 'conversations', 'outbox'], 'readwrite');
      tx.objectStore('messages').put({
        id: 'legacy-msg-1',
        conversationId: 'peer-X',
        peerId: 'peer-X',
        direction: 'out',
        senderId: 'old-user',
        recipientId: 'peer-X',
        plaintext: 'legacy hello',
        ciphertext: 'c',
        iv: 'iv',
        alg: 'AES-256-GCM',
        status: 'delivered',
        createdAt: 1,
        updatedAt: 1,
      });
      tx.objectStore('conversations').put({
        id: 'peer-X',
        peerId: 'peer-X',
        peerUsername: 'x',
        peerDisplayName: 'X',
        lastMessageAt: 1,
        lastMessagePreview: 'legacy hello',
        unread: 0,
      });
      tx.objectStore('outbox').put({
        id: 'legacy-out-1',
        recipientId: 'peer-X',
        ciphertext: 'c',
        iv: 'iv',
        alg: 'AES-256-GCM',
        createdAt: 1,
        status: 'sent',
        attempts: 0,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  await resetIdb(DB);
  seq = 0;
  storage = new IndexedDbChatStorage(DB);
});

describe('account-scoped storage isolation', () => {
  it('keeps two accounts that share a peer id separate', async () => {
    const peer = 'peer-shared';
    await storage.saveMessage('account-A', makeMessage('account-A', 'a1', peer));
    await storage.saveMessage('account-B', makeMessage('account-B', 'b1', peer));
    await storage.upsertConversation('account-A', makeConversation('account-A', peer));
    await storage.upsertConversation('account-B', makeConversation('account-B', peer));

    const aMessages = await storage.listMessages('account-A', peer);
    const bMessages = await storage.listMessages('account-B', peer);
    expect(aMessages.map((m) => m.id)).toEqual(['a1']);
    expect(bMessages.map((m) => m.id)).toEqual(['b1']);
    expect(aMessages[0].ownerId).toBe('account-A');
    expect(bMessages[0].ownerId).toBe('account-B');

    const aConversations = await storage.listConversations('account-A');
    const bConversations = await storage.listConversations('account-B');
    expect(aConversations).toHaveLength(1);
    expect(bConversations).toHaveLength(1);
    expect((await storage.getConversation('account-A', peer))?.ownerId).toBe('account-A');
  });

  it("does not expose account A's messages to account B", async () => {
    await storage.saveMessage('account-A', makeMessage('account-A', 'secret-1', 'peer-shared'));
    expect(await storage.getMessage('account-B', 'secret-1')).toBeUndefined();
    expect(await storage.listMessages('account-B', 'peer-shared')).toEqual([]);
  });

  it('keeps conversations and outboxes independent', async () => {
    await storage.upsertOutbox('account-A', makeOutbox('account-A', 'shared-outbox-id'));
    await storage.upsertOutbox('account-B', makeOutbox('account-B', 'shared-outbox-id'));

    expect((await storage.listOutbox('account-A')).map((r) => r.ownerId)).toEqual(['account-A']);
    expect((await storage.listOutbox('account-B')).map((r) => r.ownerId)).toEqual(['account-B']);

    await storage.deleteOutbox('account-A', 'shared-outbox-id');
    expect(await storage.listOutbox('account-A')).toEqual([]);
    expect(await storage.listOutbox('account-B')).toHaveLength(1);
  });

  it("restores the correct account's history after logout/login", async () => {
    await storage.saveMessage('account-A', makeMessage('account-A', 'a1', 'peer-shared'));
    await storage.upsertConversation('account-A', makeConversation('account-A', 'peer-shared'));

    // "Logout / login" => new storage handle against the same database.
    const reopened = new IndexedDbChatStorage(DB);
    expect((await reopened.listConversations('account-A')).map((c) => c.peerId)).toEqual([
      'peer-shared',
    ]);
    expect(await reopened.listConversations('account-B')).toEqual([]);

    await reopened.saveMessage('account-B', makeMessage('account-B', 'b1', 'peer-shared'));
    expect((await reopened.listMessages('account-A', 'peer-shared')).map((m) => m.id)).toEqual([
      'a1',
    ]);
    expect((await reopened.listMessages('account-B', 'peer-shared')).map((m) => m.id)).toEqual([
      'b1',
    ]);
  });

  it('updates and deletions affect only the specified account', async () => {
    await storage.saveMessage('account-A', makeMessage('account-A', 'same-id', 'peer-shared'));
    await storage.saveMessage('account-B', makeMessage('account-B', 'same-id', 'peer-shared'));
    await storage.updateMessageStatus('account-A', 'same-id', 'failed', 'boom');

    expect((await storage.getMessage('account-A', 'same-id'))?.status).toBe('failed');
    expect(await storage.getMessage('account-B', 'same-id')).toMatchObject({
      status: 'pending',
    });
    expect((await storage.getMessage('account-B', 'same-id'))?.error).toBeUndefined();

    await storage.upsertOutbox('account-A', makeOutbox('account-A', 'same-out'));
    await storage.upsertOutbox('account-B', makeOutbox('account-B', 'same-out'));
    await storage.deleteOutbox('account-A', 'same-out');
    expect(await storage.listOutbox('account-A')).toEqual([]);
    expect(await storage.listOutbox('account-B')).toHaveLength(1);
  });

  it('prevents a delayed write from a previous account reaching the current one', async () => {
    // A late/slow operation carries account-A's owner id...
    await storage.saveMessage('account-A', makeMessage('account-A', 'late-1', 'peer-shared'));
    // ...and must never be visible to the now-active account B.
    expect(await storage.listMessages('account-B', 'peer-shared')).toEqual([]);
    expect(await storage.listConversations('account-B')).toEqual([]);
  });
});

describe('legacy migration', () => {
  it('preserves legacy history in a recoverable archive without showing it to accounts', async () => {
    await seedLegacyV1(DB);

    // Opening at v2 migrates the schema and archives legacy records.
    expect(await storage.listConversations('any-account')).toEqual([]);
    expect(await storage.listMessages('any-account', 'peer-X')).toEqual([]);

    const summary = await storage.getLegacySummary();
    const byStore = Object.fromEntries(summary.map((s) => [s.sourceStore, s.count]));
    expect(byStore).toEqual({ messages: 1, conversations: 1, outbox: 1 });

    const legacyMessages = await storage.listLegacyRecords('messages');
    expect(legacyMessages).toHaveLength(1);
    expect(legacyMessages[0].legacyId).toBe('messages:legacy-msg-1');
    expect(legacyMessages[0].data).toMatchObject({ plaintext: 'legacy hello' });

    // Originals are never deleted: the v1 stores still hold the data.
    for (const name of LEGACY_STORES) {
      expect(await rawCount(DB, name)).toBeGreaterThan(0);
    }
  });

  it('explicitly recovers legacy records into an account on request', async () => {
    await seedLegacyV1(DB);
    const recovered = await storage.recoverLegacyRecords('account-A', [
      'messages:legacy-msg-1',
      'conversations:peer-X',
      'outbox:legacy-out-1',
    ]);
    expect(recovered).toBe(3);

    expect((await storage.listMessages('account-A', 'peer-X')).map((m) => m.id)).toEqual([
      'legacy-msg-1',
    ]);
    expect((await storage.listConversations('account-A')).map((c) => c.peerId)).toEqual(['peer-X']);
    expect(await storage.listOutbox('account-A')).toHaveLength(1);
    // Still isolated from other accounts.
    expect(await storage.listConversations('account-B')).toEqual([]);
  });

  it('is idempotent when the migration is re-run after an interruption', async () => {
    await seedLegacyV1(DB);
    await storage.getLegacySummary(); // runs migration + archive

    // Simulate an interrupted run: the completion flag is missing.
    await deleteMetaFlag(DB);
    await closeIdb(DB);

    const reopened = new IndexedDbChatStorage(DB);
    const summary = await reopened.getLegacySummary();
    const byStore = Object.fromEntries(summary.map((s) => [s.sourceStore, s.count]));
    expect(byStore).toEqual({ messages: 1, conversations: 1, outbox: 1 });

    // Originals remain intact after the re-run.
    for (const name of LEGACY_STORES) {
      expect(await rawCount(DB, name)).toBeGreaterThan(0);
    }
  });
});
