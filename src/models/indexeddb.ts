/// <reference lib="dom" />

import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import { SerialOperationQueue } from "../store/sqlite/database.js";

const DATABASE_VERSION = 1;
const DEFAULT_CREDENTIALS_STORE_NAME = "harness_credentials";
const DEFAULT_MODELS_STORE_NAME = "harness_models_cache";

/**
 * Optional encryption/encoding codec applied to serialized credential JSON before writing
 * to IndexedDB (for example Web Crypto AES-GCM or a host keychain wrapper).
 *
 * `encrypt` and `decrypt` always run outside active `IDBTransaction` scopes so async
 * primitives like `crypto.subtle` never trigger `TransactionInactiveError`.
 */
export interface CredentialCodec {
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
}

export interface IndexedDbModelsDatabaseOptions {
  /** Custom `IDBFactory` (defaults to global `indexedDB`; injectable for testing). */
  readonly indexedDB?: IDBFactory;
  /** Credentials object store name. Defaults to `"harness_credentials"`. */
  readonly credentialsStoreName?: string;
  /** Model catalog cache object store name. Defaults to `"harness_models_cache"`. */
  readonly modelsStoreName?: string;
}

export interface IndexedDbCredentialStoreOptions extends IndexedDbModelsDatabaseOptions {
  /** Optional codec used to encrypt/decrypt stored credential payloads. */
  readonly codec?: CredentialCodec;
}

export interface IndexedDbModelsStoreOptions extends IndexedDbModelsDatabaseOptions {}

export interface IndexedDbModelStores {
  readonly credentials: IndexedDbCredentialStore;
  readonly modelsStore: IndexedDbModelsStore;
  close(): Promise<void>;
}

interface StoredCredentialRecord {
  readonly providerId: string;
  readonly type: Credential["type"];
  readonly payload: string;
  readonly updatedAt: number;
}

interface StoredModelsCacheRecord {
  readonly providerId: string;
  readonly entry: ModelsStoreEntry;
  readonly updatedAt: number;
}

class IndexedDbModelsFailure extends Error {}

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

function validateStoreNames(
  dbName: string,
  options: IndexedDbModelsDatabaseOptions,
): { credentialsStoreName: string; modelsStoreName: string } {
  if (!dbName.trim()) {
    throw new Error("IndexedDB database name must be non-empty");
  }
  const credentialsStoreName = options.credentialsStoreName ?? DEFAULT_CREDENTIALS_STORE_NAME;
  if (!credentialsStoreName.trim()) {
    throw new Error("IndexedDB credentials object store name must be non-empty");
  }
  const modelsStoreName = options.modelsStoreName ?? DEFAULT_MODELS_STORE_NAME;
  if (!modelsStoreName.trim()) {
    throw new Error("IndexedDB models object store name must be non-empty");
  }
  if (credentialsStoreName === modelsStoreName) {
    throw new Error("IndexedDB credentialsStoreName and modelsStoreName must be distinct");
  }
  return { credentialsStoreName, modelsStoreName };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new IndexedDbModelsFailure("IndexedDB request failed")),
      { once: true },
    );
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new IndexedDbModelsFailure("IndexedDB transaction was aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new IndexedDbModelsFailure("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

function cursorAll<T>(source: IDBObjectStore): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const values: T[] = [];
    const request = source.openCursor(null, "next");
    request.addEventListener(
      "error",
      () => reject(request.error ?? new IndexedDbModelsFailure("IndexedDB cursor failed")),
      { once: true },
    );
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve(values);
        return;
      }
      values.push(cursor.value as T);
      cursor.continue();
    });
  });
}

function openModelsDatabase(
  factory: IDBFactory,
  name: string,
  credentialsStoreName: string,
  modelsStoreName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(credentialsStoreName)) {
        db.createObjectStore(credentialsStoreName, { keyPath: "providerId" });
      }
      if (!db.objectStoreNames.contains(modelsStoreName)) {
        db.createObjectStore(modelsStoreName, { keyPath: "providerId" });
      }
    });
    request.addEventListener("blocked", () => {
      reject(
        new IndexedDbModelsFailure(
          `IndexedDB database "${name}" upgrade is blocked by another open connection`,
        ),
      );
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () =>
        reject(request.error ?? new IndexedDbModelsFailure(`Failed to open IndexedDB database "${name}"`)),
      { once: true },
    );
  });
}

/**
 * Browser / Web-platform IndexedDB implementation of `CredentialStore`.
 *
 * Supports an optional `codec` (`{ encrypt, decrypt }`) executed outside IndexedDB
 * transactions, and serializes per-provider `modify()` / `delete()` calls so concurrent
 * OAuth token refreshes never overwrite rotated refresh tokens.
 */
export class IndexedDbCredentialStore implements CredentialStore {
  private readonly db: IDBDatabase;
  private readonly storeName: string;
  private readonly codec: CredentialCodec | undefined;
  private readonly ownsDatabase: boolean;
  private readonly providerQueues = new Map<string, SerialOperationQueue>();
  private closed = false;

  /** @internal */
  constructor(db: IDBDatabase, storeName: string, codec: CredentialCodec | undefined, ownsDatabase: boolean) {
    this.db = db;
    this.storeName = storeName;
    this.codec = codec;
    this.ownsDatabase = ownsDatabase;
  }

  static async open(
    name: string,
    options: IndexedDbCredentialStoreOptions = {},
  ): Promise<IndexedDbCredentialStore> {
    const { credentialsStoreName, modelsStoreName } = validateStoreNames(name, options);
    const factory = resolveIndexedDbFactory(options.indexedDB);
    const db = await openModelsDatabase(factory, name, credentialsStoreName, modelsStoreName);
    return new IndexedDbCredentialStore(db, credentialsStoreName, options.codec, true);
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    const record = await this.readRawRecord(providerId);
    options?.signal?.throwIfAborted();
    if (!record) return undefined;
    return this.decodePayload(record.payload);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    const tx = this.db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    const records = await cursorAll<StoredCredentialRecord>(store);
    await done;
    options?.signal?.throwIfAborted();
    return records.map((record) => ({ providerId: record.providerId, type: record.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    return this.getProviderQueue(providerId).runAsync(async () => {
      this.assertOpen();
      options?.signal?.throwIfAborted();
      const record = await this.readRawRecord(providerId);
      options?.signal?.throwIfAborted();
      const current = record ? await this.decodePayload(record.payload) : undefined;
      options?.signal?.throwIfAborted();

      const next = await fn(current ? structuredClone(current) : undefined);
      if (next === undefined) {
        return current ? structuredClone(current) : undefined;
      }

      const cloned = structuredClone(next);
      const payload = await this.encodePayload(cloned);
      this.assertOpen();
      options?.signal?.throwIfAborted();

      const nextRecord: StoredCredentialRecord = {
        providerId,
        type: cloned.type,
        payload,
        updatedAt: Date.now(),
      };
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const done = transactionResult(tx);
      await requestResult(store.put(nextRecord));
      await done;
      return structuredClone(cloned);
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    return this.getProviderQueue(providerId).runAsync(async () => {
      this.assertOpen();
      options?.signal?.throwIfAborted();
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const done = transactionResult(tx);
      await requestResult(store.delete(providerId));
      await done;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) {
      this.db.close();
    }
  }

  private getProviderQueue(providerId: string): SerialOperationQueue {
    let queue = this.providerQueues.get(providerId);
    if (!queue) {
      queue = new SerialOperationQueue();
      this.providerQueues.set(providerId, queue);
    }
    return queue;
  }

  private async readRawRecord(providerId: string): Promise<StoredCredentialRecord | undefined> {
    const tx = this.db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    const record = (await requestResult(store.get(providerId))) as StoredCredentialRecord | undefined;
    await done;
    return record;
  }

  private async encodePayload(credential: Credential): Promise<string> {
    const plaintext = JSON.stringify(credential);
    return this.codec ? await this.codec.encrypt(plaintext) : plaintext;
  }

  private async decodePayload(payload: string): Promise<Credential> {
    const plaintext = this.codec ? await this.codec.decrypt(payload) : payload;
    return JSON.parse(plaintext) as Credential;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("IndexedDbCredentialStore is closed");
    }
  }
}

/**
 * Browser / Web-platform IndexedDB implementation of `ModelsStore`.
 * Persists dynamically fetched provider model catalogs for instant offline startup.
 */
export class IndexedDbModelsStore implements ModelsStore {
  private readonly db: IDBDatabase;
  private readonly storeName: string;
  private readonly ownsDatabase: boolean;
  private closed = false;

  /** @internal */
  constructor(db: IDBDatabase, storeName: string, ownsDatabase: boolean) {
    this.db = db;
    this.storeName = storeName;
    this.ownsDatabase = ownsDatabase;
  }

  static async open(name: string, options: IndexedDbModelsStoreOptions = {}): Promise<IndexedDbModelsStore> {
    const { credentialsStoreName, modelsStoreName } = validateStoreNames(name, options);
    const factory = resolveIndexedDbFactory(options.indexedDB);
    const db = await openModelsDatabase(factory, name, credentialsStoreName, modelsStoreName);
    return new IndexedDbModelsStore(db, modelsStoreName, true);
  }

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    const tx = this.db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    const record = (await requestResult(store.get(providerId))) as StoredModelsCacheRecord | undefined;
    await done;
    options?.signal?.throwIfAborted();
    return record ? structuredClone(record.entry) : undefined;
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    const record: StoredModelsCacheRecord = {
      providerId,
      entry: structuredClone(entry),
      updatedAt: Date.now(),
    };
    const tx = this.db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    await requestResult(store.put(record));
    await done;
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    const tx = this.db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const done = transactionResult(tx);
    await requestResult(store.delete(providerId));
    await done;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) {
      this.db.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("IndexedDbModelsStore is closed");
    }
  }
}

/**
 * Open both `IndexedDbCredentialStore` and `IndexedDbModelsStore` over a single shared
 * IndexedDB connection. Call `close()` on the returned bundle to close both stores and the DB.
 */
export async function openIndexedDbModelStores(
  name: string,
  options: IndexedDbCredentialStoreOptions = {},
): Promise<IndexedDbModelStores> {
  const { credentialsStoreName, modelsStoreName } = validateStoreNames(name, options);
  const factory = resolveIndexedDbFactory(options.indexedDB);
  const db = await openModelsDatabase(factory, name, credentialsStoreName, modelsStoreName);
  const credentials = new IndexedDbCredentialStore(db, credentialsStoreName, options.codec, false);
  const modelsStore = new IndexedDbModelsStore(db, modelsStoreName, false);
  let closed = false;
  return {
    credentials,
    modelsStore,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await credentials.close();
      await modelsStore.close();
      db.close();
    },
  };
}
