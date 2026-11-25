/// <reference lib="dom" />

import {
  type SessionListPage,
  type SessionListQuery,
  type SessionSnapshot,
  type SessionStore,
  summarizeSnapshot,
} from "../types.js";
import { filterAndPaginateSummaries, validateSessionListQuery } from "./query.js";

const DATABASE_VERSION = 1;
const DEFAULT_STORE_NAME = "harness_sessions";

interface IndexedDbSessionRecord {
  readonly sessionId: string;
  readonly version: SessionSnapshot["version"];
  readonly status: SessionSnapshot["status"];
  readonly updatedAt: number;
  readonly snapshot: SessionSnapshot;
}

export interface IndexedDbSessionStoreOptions {
  /** Custom `IDBFactory` (defaults to global `indexedDB`; injectable for testing). */
  readonly indexedDB?: IDBFactory;
  /** Object store name inside the database. Defaults to `"harness_sessions"`. */
  readonly storeName?: string;
}

class IndexedDbFailure extends Error {}

function resolveIndexedDbFactory(override?: IDBFactory): IDBFactory {
  if (override !== undefined) {
    return override;
  }
  const globalFactory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (globalFactory === undefined) {
    throw new Error("IndexedDB is not available in this runtime. Pass options.indexedDB explicitly.");
  }
  return globalFactory;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new IndexedDbFailure("IndexedDB request failed")),
      { once: true },
    );
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new IndexedDbFailure("IndexedDB transaction was aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new IndexedDbFailure("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

function openDatabase(factory: IDBFactory, name: string, storeName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: "sessionId" });
      }
    });
    request.addEventListener("blocked", () => {
      reject(
        new IndexedDbFailure(`IndexedDB database "${name}" upgrade is blocked by another open connection`),
      );
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new IndexedDbFailure(`Failed to open IndexedDB database "${name}"`)),
      { once: true },
    );
  });
}

/**
 * Browser / Web-platform IndexedDB implementation of `SessionStore`.
 * Modeled after `@earendil-works/pi-durable`'s `IndexedDbStorage`.
 */
export class IndexedDbSessionStore implements SessionStore {
  private readonly db: IDBDatabase;
  private readonly storeName: string;
  private closed = false;

  private constructor(db: IDBDatabase, storeName: string) {
    this.db = db;
    this.storeName = storeName;
  }

  static async open(
    name: string,
    options: IndexedDbSessionStoreOptions = {},
  ): Promise<IndexedDbSessionStore> {
    if (!name.trim()) {
      throw new Error("IndexedDB database name must be non-empty");
    }
    const storeName = options.storeName ?? DEFAULT_STORE_NAME;
    if (!storeName.trim()) {
      throw new Error("IndexedDB object store name must be non-empty");
    }
    const factory = resolveIndexedDbFactory(options.indexedDB);
    const db = await openDatabase(factory, name, storeName);
    return new IndexedDbSessionStore(db, storeName);
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    this.assertOpen();
    const tx = this.db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    const record = (await requestResult(store.get(sessionId))) as IndexedDbSessionRecord | undefined;
    await done;
    return record ? structuredClone(record.snapshot) : null;
  }

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    this.assertOpen();
    const copy = structuredClone(snapshot);
    const record: IndexedDbSessionRecord = {
      sessionId,
      version: copy.version,
      status: copy.status,
      updatedAt: copy.updatedAt,
      snapshot: copy,
    };
    const tx = this.db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    await requestResult(store.put(record));
    await done;
  }

  async delete(sessionId: string): Promise<boolean> {
    this.assertOpen();
    const tx = this.db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    const existing = await requestResult(store.get(sessionId));
    if (existing !== undefined) {
      await requestResult(store.delete(sessionId));
    }
    await done;
    return existing !== undefined;
  }

  async list(query?: SessionListQuery): Promise<SessionListPage> {
    this.assertOpen();
    validateSessionListQuery(query);
    const tx = this.db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    const records = (await requestResult(store.getAll())) as IndexedDbSessionRecord[];
    await done;
    return filterAndPaginateSummaries(
      records.map((record) => summarizeSnapshot(record.snapshot)),
      query,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("IndexedDbSessionStore is closed");
    }
  }
}
