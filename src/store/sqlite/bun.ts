import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  SerialOperationQueue,
  validateSqliteSchemaPrefix,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "./database.js";
import { SqliteSessionStore, type SqliteSessionStoreOptions } from "./store.js";

export type BunSqliteMode = "read-write" | "read-only";

export interface BunSqliteDatabaseOptions {
  readonly mode?: BunSqliteMode;
  readonly walAutoCheckpointPages?: number;
  readonly busyTimeoutMs?: number;
}

export type BunSqliteSessionStoreOptions = BunSqliteDatabaseOptions & SqliteSessionStoreOptions;

/** Minimal structural shape matching `bun:sqlite`'s `Statement` without requiring `@types/bun`. */
export interface BunSqliteStatementLike {
  run(...params: SqliteValue[]): { readonly changes: number | bigint };
  get(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
  finalize?(): void;
}

/** Minimal structural shape matching `bun:sqlite`'s `Database` without requiring `@types/bun`. */
export interface BunSqliteDatabaseLike {
  exec(sql: string): unknown;
  query(sql: string): BunSqliteStatementLike;
  close(): void;
}

type BunSqliteConstructor = new (
  filename: string,
  options?: { create?: boolean; readwrite?: boolean; readonly?: boolean },
) => BunSqliteDatabaseLike;

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATEMENT_CACHE_LIMIT = 256;

type TransactionScope = { active: boolean };

abstract class BunSqliteExecutor implements SqliteExecutor {
  protected readonly database: BunSqliteDatabaseLike;
  protected readonly statements: Map<string, BunSqliteStatementLike>;

  constructor(database: BunSqliteDatabaseLike, statements: Map<string, BunSqliteStatementLike>) {
    this.database = database;
    this.statements = statements;
  }

  exec(sql: string): Promise<void> {
    return this.runOperation(() => {
      this.database.exec(sql);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => {
      this.statement(sql).run(...params);
    });
  }

  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.runOperation(() => Number(this.statement(sql).run(...params).changes));
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => {
      const row = this.statement(sql).get(...params);
      return row === null || row === undefined ? undefined : (row as T);
    });
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...params) as T[]);
  }

  protected abstract runOperation<T>(operation: () => T): Promise<T>;

  private statement(sql: string): BunSqliteStatementLike {
    const statements = this.statements;
    let statement = statements.get(sql);
    if (statement !== undefined) {
      if (statements.size > STATEMENT_CACHE_LIMIT / 2) {
        statements.delete(sql);
        statements.set(sql, statement);
      }
      return statement;
    }
    statement = this.database.query(sql);
    statements.set(sql, statement);
    if (statements.size > STATEMENT_CACHE_LIMIT) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) {
        statements.get(oldest)?.finalize?.();
        statements.delete(oldest);
      }
    }
    return statement;
  }
}

class BunSqliteTransaction extends BunSqliteExecutor {
  private readonly scope: TransactionScope;

  constructor(
    database: BunSqliteDatabaseLike,
    statements: Map<string, BunSqliteStatementLike>,
    scope: TransactionScope,
  ) {
    super(database, statements);
    this.scope = scope;
  }

  protected async runOperation<T>(operation: () => T): Promise<T> {
    if (!this.scope.active) {
      throw new Error("SQLite transaction handle is no longer active");
    }
    return operation();
  }
}

/** `SqliteDatabase` adapter backed by Bun's built-in `bun:sqlite`. */
export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialOperationQueue();
  private readonly mode: BunSqliteMode;
  private closed = false;

  constructor(database: BunSqliteDatabaseLike, mode: BunSqliteMode = "read-write") {
    super(database, new Map());
    this.mode = mode;
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      this.database.exec(this.mode === "read-only" ? "BEGIN" : "BEGIN IMMEDIATE");
      const scope: TransactionScope = { active: true };
      try {
        const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
        scope.active = false;
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.access.run(() => {
      if (this.closed) return;
      this.closed = true;
      for (const stmt of this.statements.values()) {
        stmt.finalize?.();
      }
      this.statements.clear();
      try {
        if (this.mode === "read-write") {
          this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
      } finally {
        this.database.close();
      }
    });
  }

  protected runOperation<T>(operation: () => T): Promise<T> {
    return this.access.run(operation);
  }
}

async function loadBunSqliteConstructor(): Promise<BunSqliteConstructor> {
  // Literal specifier so Bun recognizes its built-in module during `bun build --compile`
  // without requiring `@types/bun` in Node-based TypeScript builds.
  // @ts-expect-error -- `bun:sqlite` is provided by the Bun runtime.
  const mod = (await import("bun:sqlite")) as { Database: BunSqliteConstructor };
  return mod.Database;
}

/** Open and configure a Bun-backed `SqliteDatabase` facade. */
export async function openBunSqliteDatabase(
  path: string,
  options: BunSqliteDatabaseOptions = {},
): Promise<BunSqliteDatabase> {
  const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
  const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const Database = await loadBunSqliteConstructor();

  if (options.mode === "read-only") {
    const database = new Database(path, { readonly: true });
    const adapter = new BunSqliteDatabase(database, "read-only");
    try {
      await adapter.exec(`PRAGMA busy_timeout = ${timeout}`);
      return adapter;
    } catch (error) {
      try {
        await adapter.close();
      } catch {
        // Preserve configuration failure.
      }
      throw error;
    }
  }

  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const database = new Database(path, { create: true, readwrite: true });
  const adapter = new BunSqliteDatabase(database, "read-write");
  try {
    await adapter.exec(`PRAGMA busy_timeout = ${timeout}`);
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
    return adapter;
  } catch (error) {
    try {
      await adapter.close();
    } catch {
      // Preserve configuration failure.
    }
    throw error;
  }
}

/** Open or create a SQLite session store using Bun's built-in `bun:sqlite`. */
export async function openBunSqliteSessionStore(
  path: string,
  options: BunSqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  const { prefix, ...databaseOptions } = options;
  if (prefix !== undefined) {
    validateSqliteSchemaPrefix(prefix);
  }
  return SqliteSessionStore.open(await openBunSqliteDatabase(path, databaseOptions), { prefix });
}
