import type {
  SessionListPage,
  SessionListQuery,
  SessionSnapshot,
  SessionStore,
  SessionSummary,
} from "../../types.js";
import { decodeSessionCursor, encodeSessionCursor, validateSessionListQuery } from "../query.js";
import type { SqliteDatabase, SqliteValue } from "./database.js";
import { applySqliteMigrations, createSqliteSessionSchema, type SqliteSessionSchema } from "./schema.js";

export interface SqliteSessionStoreOptions {
  /**
   * Optional identifier prefix for every table owned by this store (for example `"pi_"`).
   * Must be a valid SQLite identifier and cannot start with `"sqlite_"`.
   */
  readonly prefix?: string;
}

type SnapshotRow = { readonly snapshot_json: string };
type SummaryRow = {
  readonly session_id: string;
  readonly provider: string;
  readonly model_id: string;
  readonly status: SessionSnapshot["status"];
  readonly title: string | null;
  readonly parent_session_id: string | null;
  readonly created_at: number | null;
  readonly updated_at: number;
  readonly message_count: number;
};

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
          title,
          parent_session_id,
          created_at,
          updated_at,
          message_count,
          snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          version = excluded.version,
          provider = excluded.provider,
          model_id = excluded.model_id,
          status = excluded.status,
          last_error = excluded.last_error,
          title = excluded.title,
          parent_session_id = excluded.parent_session_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          message_count = excluded.message_count,
          snapshot_json = excluded.snapshot_json`,
        sessionId,
        snapshot.version,
        snapshot.model.provider,
        snapshot.model.modelId,
        snapshot.status,
        snapshot.lastError ?? null,
        snapshot.title ?? null,
        snapshot.parentSessionId ?? null,
        snapshot.createdAt ?? snapshot.updatedAt,
        snapshot.updatedAt,
        snapshot.messages.length,
        serialized,
      );
    });
  }

  async delete(sessionId: string): Promise<boolean> {
    this.assertOpen();
    const changes = await this.db.runCounted(
      `DELETE FROM ${this.schema.tables.sessions} WHERE session_id = ?`,
      sessionId,
    );
    return changes > 0;
  }

  async list(query: SessionListQuery = {}): Promise<SessionListPage> {
    this.assertOpen();
    validateSessionListQuery(query);
    const decodedCursor = query.cursor !== undefined ? decodeSessionCursor(query.cursor) : undefined;

    const clauses: string[] = [];
    const params: SqliteValue[] = [];
    if (query.parentSessionId !== undefined) {
      clauses.push("parent_session_id = ?");
      params.push(query.parentSessionId);
    }
    if (query.status !== undefined) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (decodedCursor !== undefined) {
      clauses.push("(updated_at < ? OR (updated_at = ? AND session_id > ?))");
      params.push(decodedCursor.updatedAt, decodedCursor.updatedAt, decodedCursor.sessionId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = query.limit !== undefined ? "LIMIT ?" : "";
    if (query.limit !== undefined) {
      params.push(query.limit + 1);
    }

    const rows = await this.db.all<SummaryRow>(
      `SELECT session_id, provider, model_id, status, title, parent_session_id, created_at, updated_at, message_count
       FROM ${this.schema.tables.sessions}
       ${where}
       ORDER BY updated_at DESC, session_id ASC
       ${limitClause}`,
      ...params,
    );

    const summaries: SessionSummary[] = rows.map((row) => ({
      sessionId: row.session_id,
      model: { provider: row.provider, modelId: row.model_id },
      status: row.status,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.parent_session_id !== null ? { parentSessionId: row.parent_session_id } : {}),
      createdAt: row.created_at ?? row.updated_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    }));

    if (query.limit === undefined || summaries.length <= query.limit) {
      return { items: summaries };
    }
    const items = summaries.slice(0, query.limit);
    return {
      items,
      nextCursor: encodeSessionCursor(items[items.length - 1]!),
    };
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
