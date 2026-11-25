/// <reference lib="dom" />

import {
  type SessionListPage,
  type SessionListQuery,
  type SessionSnapshot,
  type SessionStore,
  type SessionSummary,
  summarizeSnapshot,
} from "../types.js";
import { decodeSessionCursor, encodeSessionCursor, validateSessionListQuery } from "./query.js";

const DATABASE_VERSION = 2;
const DEFAULT_SNAPSHOT_STORE_NAME = "harness_sessions";
const SORT_ORDER_INDEX = "by_sort_order";

interface IndexedDbSessionRecord {
  readonly sessionId: string;
  readonly version: SessionSnapshot["version"];
  readonly status: SessionSnapshot["status"];
  readonly updatedAt: number;
  readonly snapshot: SessionSnapshot;
}

interface IndexedDbSummaryRecord {
  readonly sessionId: string;
  /** Negated `updatedAt` so ascending index scans match `updatedAt DESC, sessionId ASC`. */
  readonly sortUpdatedAt: number;
  readonly summary: SessionSummary;
}

export interface IndexedDbSessionStoreOptions {
  /** Custom `IDBFactory` (defaults to global `indexedDB`; injectable for testing). */
  readonly indexedDB?: IDBFactory;
  /** Custom `IDBKeyRange` constructor (defaults to global `IDBKeyRange`; injectable for testing). */
  readonly IDBKeyRange?: typeof IDBKeyRange;
  /** Snapshot object store name inside the database. Defaults to `"harness_sessions"`. */
  readonly storeName?: string;
  /** Summary object store name inside the database. Defaults to `${storeName}_summaries`. */
  readonly summaryStoreName?: string;
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

function keyRanges(override?: typeof IDBKeyRange): typeof IDBKeyRange {
  if (override !== undefined) return override;
  if (typeof IDBKeyRange === "undefined") {
    throw new Error(
      "IndexedDB key ranges are not available in this runtime. Pass options.IDBKeyRange explicitly.",
    );
  }
  return IDBKeyRange;
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

/**
 * Modeled after `@earendil-works/pi-durable`'s `cursorValues`: iterates an IndexedDB index
 * cursor, collecting at most `limit` matching values and stopping immediately once satisfied.
 */
function cursorValues<T>(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | IDBValidKey | null,
  direction: IDBCursorDirection,
  limit: number | undefined,
  accept: (value: T) => boolean = () => true,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const values: T[] = [];
    const request = source.openCursor(range, direction);
    request.addEventListener(
      "error",
      () => reject(request.error ?? new IndexedDbFailure("IndexedDB cursor failed")),
      { once: true },
    );
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve(values);
        return;
      }
      const value = cursor.value as T;
      if (accept(value)) {
        values.push(value);
      }
      if (limit !== undefined && values.length >= limit) {
        resolve(values);
        return;
      }
      cursor.continue();
    });
  });
}

function toSummaryRecord(snapshot: SessionSnapshot): IndexedDbSummaryRecord {
  const summary = summarizeSnapshot(snapshot);
  return {
    sessionId: summary.sessionId,
    sortUpdatedAt: -summary.updatedAt,
    summary,
  };
}

function openDatabase(
  factory: IDBFactory,
  name: string,
  snapshotStoreName: string,
  summaryStoreName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", (event) => {
      const db = request.result;
      const tx = request.transaction;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      if (!db.objectStoreNames.contains(snapshotStoreName)) {
        db.createObjectStore(snapshotStoreName, { keyPath: "sessionId" });
      }

      let summaryStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(summaryStoreName)) {
        summaryStore = db.createObjectStore(summaryStoreName, { keyPath: "sessionId" });
      } else if (tx) {
        summaryStore = tx.objectStore(summaryStoreName);
      } else {
        return;
      }

      if (!summaryStore.indexNames.contains(SORT_ORDER_INDEX)) {
        summaryStore.createIndex(SORT_ORDER_INDEX, ["sortUpdatedAt", "sessionId"], { unique: true });
      }

      // Migrate v1 snapshot records into the dedicated summaries store in place.
      if (oldVersion > 0 && oldVersion < 2 && tx && db.objectStoreNames.contains(snapshotStoreName)) {
        const snapshotStore = tx.objectStore(snapshotStoreName);
        const cursorReq = snapshotStore.openCursor();
        cursorReq.addEventListener("success", () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const record = cursor.value as IndexedDbSessionRecord;
          if (record?.snapshot) {
            summaryStore.put(toSummaryRecord(record.snapshot));
          }
          cursor.continue();
        });
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
 *
 * Modeled after `@earendil-works/pi-durable`'s `IndexedDbStorage`: splits lightweight
 * `session_summaries` (indexed by `[-updatedAt, sessionId]`) from full `session_snapshots`
 * so `list()` scans only summary index entries via cursor pagination without loading transcripts.
 */
export class IndexedDbSessionStore implements SessionStore {
  private readonly db: IDBDatabase;
  private readonly snapshotStoreName: string;
  private readonly summaryStoreName: string;
  private readonly keyRangeCtor: typeof IDBKeyRange | undefined;
  private closed = false;

  private constructor(
    db: IDBDatabase,
    snapshotStoreName: string,
    summaryStoreName: string,
    keyRangeCtor: typeof IDBKeyRange | undefined,
  ) {
    this.db = db;
    this.snapshotStoreName = snapshotStoreName;
    this.summaryStoreName = summaryStoreName;
    this.keyRangeCtor = keyRangeCtor;
  }

  static async open(
    name: string,
    options: IndexedDbSessionStoreOptions = {},
  ): Promise<IndexedDbSessionStore> {
    if (!name.trim()) {
      throw new Error("IndexedDB database name must be non-empty");
    }
    const snapshotStoreName = options.storeName ?? DEFAULT_SNAPSHOT_STORE_NAME;
    if (!snapshotStoreName.trim()) {
      throw new Error("IndexedDB object store name must be non-empty");
    }
    const summaryStoreName = options.summaryStoreName ?? `${snapshotStoreName}_summaries`;
    if (!summaryStoreName.trim()) {
      throw new Error("IndexedDB summary object store name must be non-empty");
    }
    const factory = resolveIndexedDbFactory(options.indexedDB);
    const db = await openDatabase(factory, name, snapshotStoreName, summaryStoreName);
    return new IndexedDbSessionStore(db, snapshotStoreName, summaryStoreName, options.IDBKeyRange);
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    this.assertOpen();
    const tx = this.db.transaction(this.snapshotStoreName, "readonly");
    const store = tx.objectStore(this.snapshotStoreName);
    const done = transactionResult(tx);
    const record = (await requestResult(store.get(sessionId))) as IndexedDbSessionRecord | undefined;
    await done;
    return record ? structuredClone(record.snapshot) : null;
  }

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    this.assertOpen();
    const copy = structuredClone(snapshot);
    const snapshotRecord: IndexedDbSessionRecord = {
      sessionId,
      version: copy.version,
      status: copy.status,
      updatedAt: copy.updatedAt,
      snapshot: copy,
    };
    const summaryRecord = toSummaryRecord(copy);

    const tx = this.db.transaction([this.snapshotStoreName, this.summaryStoreName], "readwrite");
    const snapshotStore = tx.objectStore(this.snapshotStoreName);
    const summaryStore = tx.objectStore(this.summaryStoreName);
    const done = transactionResult(tx);
    await Promise.all([
      requestResult(snapshotStore.put(snapshotRecord)),
      requestResult(summaryStore.put(summaryRecord)),
    ]);
    await done;
  }

  async delete(sessionId: string): Promise<boolean> {
    this.assertOpen();
    const tx = this.db.transaction([this.snapshotStoreName, this.summaryStoreName], "readwrite");
    const snapshotStore = tx.objectStore(this.snapshotStoreName);
    const summaryStore = tx.objectStore(this.summaryStoreName);
    const done = transactionResult(tx);
    const existing = await requestResult(snapshotStore.getKey(sessionId));
    if (existing !== undefined) {
      await Promise.all([
        requestResult(snapshotStore.delete(sessionId)),
        requestResult(summaryStore.delete(sessionId)),
      ]);
    }
    await done;
    return existing !== undefined;
  }

  async list(query: SessionListQuery = {}): Promise<SessionListPage> {
    this.assertOpen();
    validateSessionListQuery(query);
    const decodedCursor = query.cursor !== undefined ? decodeSessionCursor(query.cursor) : undefined;
    const range =
      decodedCursor !== undefined
        ? keyRanges(this.keyRangeCtor).lowerBound([-decodedCursor.updatedAt, decodedCursor.sessionId], true)
        : null;

    const tx = this.db.transaction(this.summaryStoreName, "readonly");
    const index = tx.objectStore(this.summaryStoreName).index(SORT_ORDER_INDEX);
    const done = transactionResult(tx);
    const scanLimit = query.limit !== undefined ? query.limit + 1 : undefined;
    const records = await cursorValues<IndexedDbSummaryRecord>(index, range, "next", scanLimit, (record) => {
      if (query.parentSessionId !== undefined && record.summary.parentSessionId !== query.parentSessionId) {
        return false;
      }
      if (query.status !== undefined && record.summary.status !== query.status) {
        return false;
      }
      return true;
    });
    await done;

    const summaries = records.map((record) => structuredClone(record.summary));
    if (query.limit === undefined || summaries.length <= query.limit) {
      return { items: summaries };
    }
    const items = summaries.slice(0, query.limit);
    return {
      items,
      nextCursor: encodeSessionCursor(items[items.length - 1]!),
    };
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
