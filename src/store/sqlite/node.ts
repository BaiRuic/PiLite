import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  SerialOperationQueue,
  validateSqliteSchemaPrefix,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "./database.js";
import { SqliteSessionStore, type SqliteSessionStoreOptions } from "./store.js";

export type NodeSqliteMode = "read-write" | "read-only";

export interface NodeSqliteDatabaseOptions {
  readonly mode?: NodeSqliteMode;
  readonly walAutoCheckpointPages?: number;
  readonly busyTimeoutMs?: number;
}

export type NodeSqliteSessionStoreOptions = NodeSqliteDatabaseOptions & SqliteSessionStoreOptions;

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATEMENT_CACHE_LIMIT = 256;

type TransactionScope = { active: boolean };

abstract class NodeSqliteExecutor implements SqliteExecutor {
  protected readonly database: DatabaseSync;
  protected readonly statements: Map<string, StatementSync>;

  constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
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
    return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...params) as T[]);
  }

  protected abstract runOperation<T>(operation: () => T): Promise<T>;

  private statement(sql: string): StatementSync {
    const statements = this.statements;
    let statement = statements.get(sql);
    if (statement !== undefined) {
      if (statements.size > STATEMENT_CACHE_LIMIT / 2) {
        statements.delete(sql);
        statements.set(sql, statement);
      }
      return statement;
    }
    statement = this.database.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > STATEMENT_CACHE_LIMIT) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) statements.delete(oldest);
    }
    return statement;
  }
}

class NodeSqliteTransaction extends NodeSqliteExecutor {
  private readonly scope: TransactionScope;

  constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
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

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialOperationQueue();
  private readonly mode: NodeSqliteMode;
  private closed = false;

  constructor(database: DatabaseSync, mode: NodeSqliteMode = "read-write") {
    super(database, new Map());
    this.mode = mode;
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      this.database.exec(this.mode === "read-only" ? "BEGIN" : "BEGIN IMMEDIATE");
      const scope: TransactionScope = { active: true };
      try {
        const result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
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

/** Open and configure a Node-backed `SqliteDatabase` facade. */
export async function openNodeSqliteDatabase(
  path: string,
  options: NodeSqliteDatabaseOptions = {},
): Promise<NodeSqliteDatabase> {
  const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
  const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (options.mode === "read-only") {
    return new NodeSqliteDatabase(new DatabaseSync(path, { timeout, readOnly: true }), "read-only");
  }
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const database = new DatabaseSync(path, { timeout });
  const adapter = new NodeSqliteDatabase(database, "read-write");
  try {
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
    return adapter;
  } catch (error) {
    try {
      await adapter.close();
    } catch {
      // Preserve the configuration failure.
    }
    throw error;
  }
}

/** Open or create a SQLite session store using Node's built-in `node:sqlite`. */
export async function openNodeSqliteSessionStore(
  path: string,
  options: NodeSqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  const { prefix, ...databaseOptions } = options;
  if (prefix !== undefined) {
    validateSqliteSchemaPrefix(prefix);
  }
  return SqliteSessionStore.open(await openNodeSqliteDatabase(path, databaseOptions), { prefix });
}
