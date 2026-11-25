import {
  validateSqliteSchemaPrefix,
  type SqliteDatabase,
  type SqliteExecutor,
} from "../../store/sqlite/database.js";

export interface SqliteModelsSchema {
  readonly prefix: string;
  readonly tables: {
    readonly schemaMigrations: string;
    readonly credentials: string;
    readonly modelsCache: string;
  };
}

export function createSqliteModelsSchema(prefix = ""): SqliteModelsSchema {
  if (prefix.length > 0) {
    validateSqliteSchemaPrefix(prefix);
  }
  return {
    prefix,
    tables: {
      schemaMigrations: `${prefix}harness_models_schema_migrations`,
      credentials: `${prefix}harness_credentials`,
      modelsCache: `${prefix}harness_models_cache`,
    },
  };
}

interface SqliteModelsMigration {
  readonly version: number;
  readonly description: string;
  apply(executor: SqliteExecutor, schema: SqliteModelsSchema): Promise<void>;
}

const MIGRATIONS: readonly SqliteModelsMigration[] = [
  {
    version: 1,
    description: "Create credentials and models cache tables",
    async apply(executor, schema) {
      await executor.exec(`
        CREATE TABLE IF NOT EXISTS ${schema.tables.credentials} (
          provider_id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL,
          credential_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${schema.tables.modelsCache} (
          provider_id TEXT PRIMARY KEY NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
];

type MigrationRow = { readonly version: number };

export async function applySqliteModelsMigrations(
  db: SqliteDatabase,
  schema: SqliteModelsSchema,
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

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await migration.apply(tx, schema);
      await tx.run(
        `INSERT INTO ${schema.tables.schemaMigrations} (version, applied_at) VALUES (?, ?)`,
        migration.version,
        Date.now(),
      );
    }
  });
}
