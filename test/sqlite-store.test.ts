import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SqliteSessionStore,
  validateSqliteSchemaPrefix,
} from "../src/store/sqlite/index.js";
import {
  openNodeSqliteDatabase,
  openNodeSqliteSessionStore,
} from "../src/store/sqlite/node.js";
import { registerSessionStoreContract } from "../src/testing.js";
import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot } from "../src/types.js";

registerSessionStoreContract(
  { describe, it, expect },
  "SqliteSessionStore (node:sqlite :memory:)",
  async (use) => {
    const store = await openNodeSqliteSessionStore(":memory:");
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

registerSessionStoreContract(
  { describe, it, expect },
  "SqliteSessionStore (node:sqlite file-backed)",
  async (use) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-sqlite-"));
    const dbPath = join(dir, "sessions.sqlite");
    const store = await openNodeSqliteSessionStore(dbPath);
    try {
      await use(store);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

describe("SqliteSessionStore (node:sqlite specifics)", () => {
  it("persists snapshots across close and reopen on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-reopen-"));
    const dbPath = join(dir, "nested", "state.sqlite");
    const snapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: "persisted-1",
      model: { provider: "faux", modelId: "faux-1" },
      messages: [
        { role: "user", content: [{ type: "text", text: "remember me" }], timestamp: 100 },
      ],
      status: "running",
      updatedAt: 100,
    };

    try {
      const writer = await openNodeSqliteSessionStore(dbPath);
      await writer.save(snapshot.sessionId, snapshot);
      await writer.close();

      const reader = await openNodeSqliteSessionStore(dbPath);
      try {
        expect(await reader.load("persisted-1")).toEqual(snapshot);
      } finally {
        await reader.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("namespaces tables cleanly by prefix and rejects invalid prefixes", async () => {
    expect(() => validateSqliteSchemaPrefix("sqlite_internal")).toThrow(/reserved/i);
    expect(() => validateSqliteSchemaPrefix("1bad")).toThrow(/invalid/i);
    expect(() => validateSqliteSchemaPrefix("bad-name")).toThrow(/invalid/i);

    const dir = await mkdtemp(join(tmpdir(), "pi-harness-prefix-"));
    const dbPath = join(dir, "shared.sqlite");
    try {
      const storeA = await openNodeSqliteSessionStore(dbPath, { prefix: "app_a_" });
      const storeB = await openNodeSqliteSessionStore(dbPath, { prefix: "app_b_" });
      try {
        const snapA: SessionSnapshot = {
          version: SESSION_SNAPSHOT_VERSION,
          sessionId: "shared-id",
          model: { provider: "faux", modelId: "faux-1" },
          messages: [],
          status: "idle",
          updatedAt: 1,
        };
        const snapB: SessionSnapshot = {
          ...snapA,
          status: "interrupted",
          updatedAt: 2,
        };
        await storeA.save("shared-id", snapA);
        await storeB.save("shared-id", snapB);

        expect(await storeA.load("shared-id")).toEqual(snapA);
        expect(await storeB.load("shared-id")).toEqual(snapB);
      } finally {
        await storeA.close();
        await storeB.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back failed transactions and rejects expired transaction handles", async () => {
    const db = await openNodeSqliteDatabase(":memory:");
    try {
      await db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");

      let leakedTx: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
      await expect(
        db.transaction(async (tx) => {
          leakedTx = tx;
          await tx.run("INSERT INTO kv (k, v) VALUES (?, ?)", "a", "1");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await db.get<{ v: string }>("SELECT v FROM kv WHERE k = ?", "a")).toBeUndefined();
      await expect(leakedTx!.run("INSERT INTO kv (k, v) VALUES (?, ?)", "b", "2")).rejects.toThrow(
        /no longer active/i,
      );
    } finally {
      await db.close();
    }
  });

  it("rejects operations after close and closes db when open() fails", async () => {
    const store = await openNodeSqliteSessionStore(":memory:");
    await store.close();
    await store.close(); // idempotent

    await expect(store.load("any")).rejects.toThrow(/closed/i);

    let closed = false;
    const failingDb = await openNodeSqliteDatabase(":memory:");
    const wrapped = {
      exec: failingDb.exec.bind(failingDb),
      run: failingDb.run.bind(failingDb),
      runCounted: failingDb.runCounted.bind(failingDb),
      get: failingDb.get.bind(failingDb),
      all: failingDb.all.bind(failingDb),
      transaction: failingDb.transaction.bind(failingDb),
      close: async () => {
        closed = true;
        await failingDb.close();
      },
    };
    await expect(SqliteSessionStore.open(wrapped, { prefix: "sqlite_bad" })).rejects.toThrow(/reserved/i);
    expect(closed).toBe(true);
  });
});
