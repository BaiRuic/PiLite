/** Values supported by the portable SQLite adapters. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * Asynchronous SQL operations shared by a database and its transaction handles.
 * Modeled after `@earendil-works/pi-durable`'s portable `SqliteExecutor` facade.
 */
export interface SqliteExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}

/**
 * Minimal portable SQLite database facade.
 *
 * All operations are asynchronous and serialized so runtime-specific adapters
 * (Node `node:sqlite`, Bun `bun:sqlite`, Cloudflare Durable Objects, etc.) share
 * one storage implementation without leaking driver dependencies into core code.
 */
export interface SqliteDatabase extends SqliteExecutor {
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const ignore = (): void => {};

/**
 * Serializes operations in call order so transactions hold exclusive access
 * to a connection until they commit or roll back.
 */
export class SerialOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending += 1;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    this.tail = barrier;

    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }

    return started.finally(() => {
      this.pending -= 1;
      releaseBarrier();
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending += 1;
    return this.release(this.tail.then(operation));
  }

  private release<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.finally(() => {
      this.pending -= 1;
    });
    this.tail = settled.then(ignore, ignore);
    return settled;
  }
}

/** Validate a schema prefix before interpolating it into SQLite table names. */
export function validateSqliteSchemaPrefix(prefix: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid SQLite schema prefix ${JSON.stringify(prefix)}`);
  }
  if (prefix.toLowerCase().startsWith("sqlite_")) {
    throw new Error(`SQLite schema prefix ${JSON.stringify(prefix)} is reserved`);
  }
}
