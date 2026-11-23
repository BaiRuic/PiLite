import type { SessionSnapshot, SessionStore } from "../../types.js";
import type { SqliteDatabase } from "./database.js";
import { applySqliteMigrations, createSqliteSessionSchema, type SqliteSessionSchema } from "./schema.js";

export interface SqliteSessionStoreOptions {
  /**
   * Optional identifier prefix for every table owned by this store (for example `"pi_"`).
   * Must be a valid SQLite identifier and cannot start with `"sqlite_"`.
   */
  readonly prefix?: string;
}

type SnapshotRow = { readonly snapshot_json: string };

/**
 * Runtime-agnostic SQLite implementation of `SessionStore`.
 *
 * Built on the portable `SqliteDatabase` facade so the same store logic runs on
 * Node (`node:sqlite`), Bun (`bun:sqlite`), or any custom SQLite adapter.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: SqliteDatabase;
  private readonly schema: SqliteSessionSchema;
  private closed = false;
  private closing: Promise<void> | undefined;

  private constructor(db: SqliteDatabase, schema: SqliteSessionSchema) {
    this.db = db;
    this.schema = schema;
  }

  /** Initialize and migrate a session store over an owned `SqliteDatabase`. */
  static async open(
    db: SqliteDatabase,
    options: SqliteSessionStoreOptions = {},
  ): Promise<SqliteSessionStore> {
    try {
      const schema = createSqliteSessionSchema(options.prefix);
      await applySqliteMigrations(db, schema);
      return new SqliteSessionStore(db, schema);
    } catch (error) {
      try {
        await db.close();
      } catch {
        // Preserve the original initialization error.
      }
      throw error;
    }
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    this.assertOpen();
    const row = await this.db.get<SnapshotRow>(
      `SELECT snapshot_json FROM ${this.schema.tables.sessions} WHERE session_id = ?`,
      sessionId,
    );
    if (row === undefined) {
      return null;
    }
    return JSON.parse(row.snapshot_json) as SessionSnapshot;
  }

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    this.assertOpen();
    const serialized = JSON.stringify(snapshot);
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO ${this.schema.tables.sessions} (
          session_id,
          version,
          provider,
          model_id,
          status,
          last_error,
          updated_at,
          snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          version = excluded.version,
          provider = excluded.provider,
          model_id = excluded.model_id,
          status = excluded.status,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at,
          snapshot_json = excluded.snapshot_json`,
        sessionId,
        snapshot.version,
        snapshot.model.provider,
        snapshot.model.modelId,
        snapshot.status,
        snapshot.lastError ?? null,
        snapshot.updatedAt,
        serialized,
      );
    });
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      this.closing = this.db.close();
    }
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteSessionStore is closed");
    }
  }
}
