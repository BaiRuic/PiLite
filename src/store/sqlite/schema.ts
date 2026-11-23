import { validateSqliteSchemaPrefix, type SqliteDatabase, type SqliteExecutor } from "./database.js";

export const CURRENT_SQLITE_SCHEMA_VERSION = 2;

export interface SqliteSessionSchema {
  readonly prefix: string;
  readonly tables: {
    readonly schemaMigrations: string;
    readonly sessions: string;
  };
}

export interface SqliteMigration {
  readonly version: number;
  readonly description: string;
  apply(executor: SqliteExecutor, schema: SqliteSessionSchema): Promise<void>;
}

export function createSqliteSessionSchema(prefix = ""): SqliteSessionSchema {
  if (prefix.length > 0) {
    validateSqliteSchemaPrefix(prefix);
  }
  return {
    prefix,
    tables: {
      schemaMigrations: `${prefix}harness_schema_migrations`,
      sessions: `${prefix}harness_sessions`,
    },
  };
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "Create harness sessions snapshot table",
    async apply(executor, schema) {
      await executor.exec(`
        CREATE TABLE IF NOT EXISTS ${schema.tables.sessions} (
          session_id TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          last_error TEXT,
          updated_at INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    description: "Add session summary metadata columns and updated_at index",
    async apply(executor, schema) {
      await executor.exec(`
        ALTER TABLE ${schema.tables.sessions} ADD COLUMN title TEXT;
        ALTER TABLE ${schema.tables.sessions} ADD COLUMN parent_session_id TEXT;
        ALTER TABLE ${schema.tables.sessions} ADD COLUMN created_at INTEGER;
        ALTER TABLE ${schema.tables.sessions} ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_${schema.tables.sessions}_updated_at
          ON ${schema.tables.sessions} (updated_at DESC, session_id ASC);
      `);
    },
  },
];

type MigrationRow = { readonly version: number };

export async function applySqliteMigrations(
  db: SqliteDatabase,
  schema: SqliteSessionSchema,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS ${schema.tables.schemaMigrations} (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const appliedRows = await tx.all<MigrationRow>(
      `SELECT version FROM ${schema.tables.schemaMigrations} ORDER BY version ASC`,
    );
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const migration of SQLITE_MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      await migration.apply(tx, schema);
      await tx.run(
        `INSERT INTO ${schema.tables.schemaMigrations} (version, applied_at) VALUES (?, ?)`,
        migration.version,
        Date.now(),
      );
    }
  });
}
