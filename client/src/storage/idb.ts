/**
 * Minimal promise-based IndexedDB wrapper (no external dependency).
 *
 * Schema v2 is account-scoped: messages, conversations and outbox records are
 * keyed by `ownerId:id` and indexed by owner so multiple accounts can share one
 * browser without seeing each other's data.
 *
 * Migration from v1 is intentionally NON-DESTRUCTIVE:
 *  - the legacy stores (`messages`, `conversations`, `outbox`) are left exactly
 *    as they were;
 *  - their records are copied into a dedicated `legacy` archive (idempotent);
 *  - nothing is deleted, so an interrupted or failed migration cannot lose data.
 *
 * Legacy v1 records have no `ownerId`, so ownership cannot be guessed. They stay
 * in the archive until a user explicitly recovers/assigns them.
 */

export const DB_NAME = 'securechat';
export const DB_VERSION = 3;

/**
 * Version of the legacy-archive migration. Kept separate from DB_VERSION so
 * adding new object stores (e.g. the device credential) does not re-run the
 * archive copy on every schema bump.
 */
const LEGACY_ARCHIVE_VERSION = 2;

export const STORES = {
  identity: 'identity',
  meta: 'meta',
  device: 'device',
  messages: 'scopedMessages',
  conversations: 'scopedConversations',
  outbox: 'scopedOutbox',
  legacy: 'legacy',
} as const;

/** v1 object stores, preserved untouched as the raw legacy archive. */
export const LEGACY_STORES = ['messages', 'conversations', 'outbox'] as const;

export type LegacyStoreName = (typeof LEGACY_STORES)[number];

const META_LEGACY_ARCHIVE_KEY = 'legacyArchiveVersion';

const dbCache = new Map<string, Promise<IDBDatabase>>();

function upgradeSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORES.identity)) {
    db.createObjectStore(STORES.identity, { keyPath: 'userId' });
  }
  if (!db.objectStoreNames.contains(STORES.meta)) {
    db.createObjectStore(STORES.meta, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORES.device)) {
    db.createObjectStore(STORES.device, { keyPath: 'id' });
  }

  if (!db.objectStoreNames.contains(STORES.messages)) {
    const store = db.createObjectStore(STORES.messages, { keyPath: 'key' });
    store.createIndex('owner', 'ownerId', { unique: false });
    store.createIndex('ownerConversation', ['ownerId', 'conversationId'], { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.conversations)) {
    const store = db.createObjectStore(STORES.conversations, { keyPath: 'key' });
    store.createIndex('owner', 'ownerId', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.outbox)) {
    const store = db.createObjectStore(STORES.outbox, { keyPath: 'key' });
    store.createIndex('owner', 'ownerId', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORES.legacy)) {
    const store = db.createObjectStore(STORES.legacy, { keyPath: 'legacyId' });
    store.createIndex('sourceStore', 'sourceStore', { unique: false });
  }

  // NOTE: legacy stores are never recreated or deleted here.
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => upgradeSchema(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readMeta(db: IDBDatabase, key: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.meta, 'readonly');
    const request = transaction.objectStore(STORES.meta).get(key);
    request.onsuccess = () => resolve((request.result as { value?: string } | undefined)?.value);
    request.onerror = () => reject(request.error);
  });
}

function writeMeta(db: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.meta, 'readwrite');
    transaction.objectStore(STORES.meta).put({ key, value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Copy unattributed v1 records into the `legacy` archive. Idempotent: records
 * are keyed by `<store>:<id>`, so re-running never duplicates and an interrupted
 * run simply resumes on the next open. The meta flag is only written after the
 * archive transaction commits.
 */
async function archiveLegacyRecords(db: IDBDatabase): Promise<void> {
  const already = await readMeta(db, META_LEGACY_ARCHIVE_KEY);
  if (already === String(LEGACY_ARCHIVE_VERSION)) return;

  const legacyStores = LEGACY_STORES.filter((name) => db.objectStoreNames.contains(name));

  if (legacyStores.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([...legacyStores, STORES.legacy], 'readwrite');
      const archive = transaction.objectStore(STORES.legacy);
      for (const name of legacyStores) {
        const request = transaction.objectStore(name).getAll();
        request.onsuccess = () => {
          for (const row of (request.result || []) as Array<Record<string, unknown>>) {
            const id = row.id ?? row.key;
            archive.put({
              legacyId: `${name}:${String(id)}`,
              sourceStore: name,
              schemaVersion: 1,
              migratedAt: Date.now(),
              data: row,
            });
          }
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  await writeMeta(db, META_LEGACY_ARCHIVE_KEY, String(LEGACY_ARCHIVE_VERSION));
}

export function openIdb(dbName: string = DB_NAME): Promise<IDBDatabase> {
  const cached = dbCache.get(dbName);
  if (cached) return cached;

  const pending = openDatabase(dbName).then(async (db) => {
    try {
      await archiveLegacyRecords(db);
    } catch {
      // Archiving is best-effort and retried on the next open; never block startup.
    }
    return db;
  });

  pending.catch(() => dbCache.delete(dbName));
  dbCache.set(dbName, pending);
  return pending;
}

/** Close a cached connection and delete the database. Intended for tests. */
export async function resetIdb(dbName: string = DB_NAME): Promise<void> {
  await closeIdb(dbName);
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Close a cached connection without deleting data. Intended for tests. */
export async function closeIdb(dbName: string = DB_NAME): Promise<void> {
  const cached = dbCache.get(dbName);
  dbCache.delete(dbName);
  if (cached) {
    try {
      (await cached).close();
    } catch {
      // ignore
    }
  }
}

function tx<T>(
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openIdb(dbName).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = fn(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

export function idbGet<T>(
  dbName: string,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return tx<T | undefined>(dbName, store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(dbName: string, store: string): Promise<T[]> {
  return tx<T[]>(dbName, store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbGetAllByIndex<T>(
  dbName: string,
  store: string,
  index: string,
  query: IDBValidKey,
): Promise<T[]> {
  return tx<T[]>(dbName, store, 'readonly', (s) => s.index(index).getAll(query) as IDBRequest<T[]>);
}

export function idbPut<T>(dbName: string, store: string, value: T): Promise<IDBValidKey> {
  return tx<IDBValidKey>(dbName, store, 'readwrite', (s) => s.put(value));
}

export function idbDelete(dbName: string, store: string, key: IDBValidKey): Promise<void> {
  return tx<undefined>(dbName, store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>).then(
    () => undefined,
  );
}
