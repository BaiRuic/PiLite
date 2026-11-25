import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "../../store/sqlite/database.js";
import { applySqliteModelsMigrations, createSqliteModelsSchema, type SqliteModelsSchema } from "./schema.js";

export interface SqliteModelsStoreOptions {
  /** Optional table prefix so multiple apps/namespaces can share one SQLite DB. */
  readonly tablePrefix?: string;
}

type CredentialJsonRow = { readonly credential_json: string };
type CredentialMetaRow = { readonly provider_id: string; readonly type: Credential["type"] };
type ModelsCacheRow = { readonly entry_json: string };

/**
 * Portable SQLite `CredentialStore` built on `SqliteDatabase` (works on both Node and Bun).
 * Serializes `modify()` inside SQLite transactions so concurrent OAuth token refreshes
 * cannot clobber rotated refresh tokens.
 */
export class SqliteCredentialStore implements CredentialStore {
  private readonly db: SqliteDatabase;
  private readonly schema: SqliteModelsSchema;
  private initPromise: Promise<void> | undefined;

  constructor(db: SqliteDatabase, options: SqliteModelsStoreOptions = {}) {
    this.db = db;
    this.schema = createSqliteModelsSchema(options.tablePrefix ?? "");
  }

  private ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = applySqliteModelsMigrations(this.db, this.schema).catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();
    const row = await this.db.get<CredentialJsonRow>(
      `SELECT credential_json FROM ${this.schema.tables.credentials} WHERE provider_id = ?`,
      providerId,
    );
    if (!row) return undefined;
    return JSON.parse(row.credential_json) as Credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();
    const rows = await this.db.all<CredentialMetaRow>(
      `SELECT provider_id, type FROM ${this.schema.tables.credentials} ORDER BY provider_id ASC`,
    );
    return rows.map((row) => ({ providerId: row.provider_id, type: row.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();

    return this.db.transaction(async (tx) => {
      options?.signal?.throwIfAborted();
      const row = await tx.get<CredentialJsonRow>(
        `SELECT credential_json FROM ${this.schema.tables.credentials} WHERE provider_id = ?`,
        providerId,
      );
      const current = row ? (JSON.parse(row.credential_json) as Credential) : undefined;
      const next = await fn(current ? structuredClone(current) : undefined);
      if (next === undefined) {
        return current ? structuredClone(current) : undefined;
      }
      const cloned = structuredClone(next);
      await tx.run(
        `INSERT INTO ${this.schema.tables.credentials} (provider_id, type, credential_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           type = excluded.type,
           credential_json = excluded.credential_json,
           updated_at = excluded.updated_at`,
        providerId,
        cloned.type,
        JSON.stringify(cloned),
        Date.now(),
      );
      return structuredClone(cloned);
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();
    await this.db.transaction(async (tx) => {
      await tx.run(`DELETE FROM ${this.schema.tables.credentials} WHERE provider_id = ?`, providerId);
    });
  }
}

/**
 * Portable SQLite `ModelsStore` built on `SqliteDatabase` (works on both Node and Bun).
 * Persists dynamically fetched provider catalogs for instant offline startup.
 */
export class SqliteModelsStore implements ModelsStore {
  private readonly db: SqliteDatabase;
  private readonly schema: SqliteModelsSchema;
  private initPromise: Promise<void> | undefined;

  constructor(db: SqliteDatabase, options: SqliteModelsStoreOptions = {}) {
    this.db = db;
    this.schema = createSqliteModelsSchema(options.tablePrefix ?? "");
  }

  private ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = applySqliteModelsMigrations(this.db, this.schema).catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();
    const row = await this.db.get<ModelsCacheRow>(
      `SELECT entry_json FROM ${this.schema.tables.modelsCache} WHERE provider_id = ?`,
      providerId,
    );
    if (!row) return undefined;
    return JSON.parse(row.entry_json) as ModelsStoreEntry;
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();
    const cloned = structuredClone(entry);
    await this.db.run(
      `INSERT INTO ${this.schema.tables.modelsCache} (provider_id, entry_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         entry_json = excluded.entry_json,
         updated_at = excluded.updated_at`,
      providerId,
      JSON.stringify(cloned),
      Date.now(),
    );
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.ensureReady();
    options?.signal?.throwIfAborted();
    await this.db.run(`DELETE FROM ${this.schema.tables.modelsCache} WHERE provider_id = ?`, providerId);
  }
}

export function createSqliteCredentialStore(
  db: SqliteDatabase,
  options?: SqliteModelsStoreOptions,
): SqliteCredentialStore {
  return new SqliteCredentialStore(db, options);
}

export function createSqliteModelsStore(
  db: SqliteDatabase,
  options?: SqliteModelsStoreOptions,
): SqliteModelsStore {
  return new SqliteModelsStore(db, options);
}
