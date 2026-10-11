import {
  DB_NAME,
  LEGACY_STORES,
  STORES,
  idbDelete,
  idbGet,
  idbGetAll,
  idbGetAllByIndex,
  idbPut,
} from './idb';
import type {
  Conversation,
  DeviceAuthRecord,
  IdentityRecord,
  LegacyRecord,
  LocalMessage,
  MessageStatus,
  OutboxRecord,
} from '../types';

/**
 * Persistence boundary. The web client implements this with IndexedDB.
 * A future Flutter client can implement the same interface with SQLite.
 *
 * Every account-scoped operation takes an explicit `ownerId`. Records are
 * stored under a composite `ownerId:id` key and read back through owner
 * indexes, so data from different accounts can never bleed into each other.
 */
export interface ChatStorage {
  getIdentity(userId: string): Promise<IdentityRecord | undefined>;
  saveIdentity(record: IdentityRecord): Promise<void>;

  /** The browser's device credential (one per installation, not per account). */
  getDeviceAuth(): Promise<DeviceAuthRecord | undefined>;
  saveDeviceAuth(record: DeviceAuthRecord): Promise<void>;

  saveMessage(ownerId: string, message: LocalMessage): Promise<void>;
  getMessage(ownerId: string, id: string): Promise<LocalMessage | undefined>;
  listMessages(ownerId: string, conversationId: string): Promise<LocalMessage[]>;
  updateMessageStatus(
    ownerId: string,
    id: string,
    status: MessageStatus,
    error?: string,
  ): Promise<void>;

  upsertOutbox(ownerId: string, record: OutboxRecord): Promise<void>;
  listOutbox(ownerId: string): Promise<OutboxRecord[]>;
  deleteOutbox(ownerId: string, id: string): Promise<void>;

  upsertConversation(ownerId: string, conversation: Conversation): Promise<void>;
  listConversations(ownerId: string): Promise<Conversation[]>;
  getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;

  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;

  /** Counts of preserved, unattributed pre-v2 records, grouped by store. */
  getLegacySummary(): Promise<Array<{ sourceStore: string; count: number }>>;
  /** List preserved legacy records; optionally filter to one source store. */
  listLegacyRecords(sourceStore?: string): Promise<LegacyRecord[]>;
  /** Explicitly assign ownership of preserved legacy records to an account. */
  recoverLegacyRecords(ownerId: string, legacyIds: string[]): Promise<number>;
}

type Stored<T> = T & { key: string; ownerId: string };

export class IndexedDbChatStorage implements ChatStorage {
  constructor(private readonly dbName: string = DB_NAME) {}

  private scopedKey(ownerId: string, id: string): string {
    return `${ownerId}:${id}`;
  }

  getIdentity(userId: string) {
    return idbGet<IdentityRecord>(this.dbName, STORES.identity, userId);
  }

  async saveIdentity(record: IdentityRecord) {
    await idbPut(this.dbName, STORES.identity, record);
  }

  getDeviceAuth() {
    return idbGet<DeviceAuthRecord>(this.dbName, STORES.device, 'current');
  }

  async saveDeviceAuth(record: DeviceAuthRecord) {
    await idbPut(this.dbName, STORES.device, record);
  }

  async saveMessage(ownerId: string, message: LocalMessage) {
    const stored: Stored<LocalMessage> = {
      ...message,
      ownerId,
      key: this.scopedKey(ownerId, message.id),
    };
    await idbPut(this.dbName, STORES.messages, stored);
  }

  async getMessage(ownerId: string, id: string) {
    const row = await idbGet<Stored<LocalMessage>>(
      this.dbName,
      STORES.messages,
      this.scopedKey(ownerId, id),
    );
    if (!row || row.ownerId !== ownerId) return undefined;
    return stripKey(row);
  }

  async listMessages(ownerId: string, conversationId: string) {
    const rows = await idbGetAllByIndex<Stored<LocalMessage>>(
      this.dbName,
      STORES.messages,
      'ownerConversation',
      [ownerId, conversationId],
    );
    return rows
      .filter((r) => r.ownerId === ownerId)
      .map(stripKey)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async updateMessageStatus(ownerId: string, id: string, status: MessageStatus, error?: string) {
    const existing = await this.getMessage(ownerId, id);
    if (!existing) return;
    const updated: LocalMessage = { ...existing, status, updatedAt: Date.now() };
    if (error !== undefined) updated.error = error;
    await this.saveMessage(ownerId, updated);
  }

  async upsertOutbox(ownerId: string, record: OutboxRecord) {
    const stored: Stored<OutboxRecord> = {
      ...record,
      ownerId,
      key: this.scopedKey(ownerId, record.id),
    };
    await idbPut(this.dbName, STORES.outbox, stored);
  }

  async listOutbox(ownerId: string) {
    const rows = await idbGetAllByIndex<Stored<OutboxRecord>>(
      this.dbName,
      STORES.outbox,
      'owner',
      ownerId,
    );
    return rows.filter((r) => r.ownerId === ownerId).map(stripKey);
  }

  async deleteOutbox(ownerId: string, id: string) {
    const key = this.scopedKey(ownerId, id);
    const row = await idbGet<Stored<OutboxRecord>>(this.dbName, STORES.outbox, key);
    if (!row || row.ownerId !== ownerId) return;
    await idbDelete(this.dbName, STORES.outbox, key);
  }

  async upsertConversation(ownerId: string, conversation: Conversation) {
    const stored: Stored<Conversation> = {
      ...conversation,
      ownerId,
      key: this.scopedKey(ownerId, conversation.id),
    };
    await idbPut(this.dbName, STORES.conversations, stored);
  }

  async listConversations(ownerId: string) {
    const rows = await idbGetAllByIndex<Stored<Conversation>>(
      this.dbName,
      STORES.conversations,
      'owner',
      ownerId,
    );
    return rows
      .filter((r) => r.ownerId === ownerId)
      .map(stripKey)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  async getConversation(ownerId: string, id: string) {
    const row = await idbGet<Stored<Conversation>>(
      this.dbName,
      STORES.conversations,
      this.scopedKey(ownerId, id),
    );
    if (!row || row.ownerId !== ownerId) return undefined;
    return stripKey(row);
  }

  async getMeta(key: string) {
    const row = await idbGet<{ key: string; value: string }>(this.dbName, STORES.meta, key);
    return row?.value;
  }

  async setMeta(key: string, value: string) {
    await idbPut(this.dbName, STORES.meta, { key, value });
  }

  async getLegacySummary() {
    const records = await idbGetAll<LegacyRecord>(this.dbName, STORES.legacy);
    const counts = new Map<string, number>();
    for (const record of records) {
      counts.set(record.sourceStore, (counts.get(record.sourceStore) ?? 0) + 1);
    }
    return [...counts.entries()].map(([sourceStore, count]) => ({ sourceStore, count }));
  }

  async listLegacyRecords(sourceStore?: string) {
    const records = await idbGetAll<LegacyRecord>(this.dbName, STORES.legacy);
    return sourceStore ? records.filter((r) => r.sourceStore === sourceStore) : records;
  }

  async recoverLegacyRecords(ownerId: string, legacyIds: string[]) {
    const wanted = new Set(legacyIds);
    const records = await idbGetAll<LegacyRecord>(this.dbName, STORES.legacy);
    let recovered = 0;
    for (const record of records) {
      if (!wanted.has(record.legacyId)) continue;
      const data = record.data as Record<string, unknown>;
      if (record.sourceStore === 'messages') {
        await this.saveMessage(ownerId, { ...(data as unknown as LocalMessage), ownerId });
      } else if (record.sourceStore === 'conversations') {
        await this.upsertConversation(ownerId, {
          ...(data as unknown as Conversation),
          ownerId,
        });
      } else if (record.sourceStore === 'outbox') {
        await this.upsertOutbox(ownerId, { ...(data as unknown as OutboxRecord), ownerId });
      } else {
        continue;
      }
      recovered += 1;
    }
    return recovered;
  }
}

/** Remove the internal composite `key` field before returning public records. */
function stripKey<T extends { key?: string }>(row: T): Omit<T, 'key'> {
  const { key, ...rest } = row;
  void key;
  return rest;
}

export const storage: ChatStorage = new IndexedDbChatStorage();

export { LEGACY_STORES };
