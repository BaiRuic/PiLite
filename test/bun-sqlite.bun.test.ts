import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- `bun:test` is provided by the Bun runtime.
import { describe, expect, it } from "bun:test";
import {
  openBunSqliteDatabase,
  openBunSqliteSessionStore,
} from "../src/store/sqlite/bun.js";
import { registerSessionStoreContract } from "../src/testing.js";
import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot } from "../src/types.js";

registerSessionStoreContract(
  { describe, it, expect },
  "SqliteSessionStore (bun:sqlite :memory:)",
  async (use) => {
    const store = await openBunSqliteSessionStore(":memory:");
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

registerSessionStoreContract(
  { describe, it, expect },
  "SqliteSessionStore (bun:sqlite file-backed)",
  async (use) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-bun-sqlite-"));
    const dbPath = join(dir, "sessions.sqlite");
    const store = await openBunSqliteSessionStore(dbPath);
    try {
      await use(store);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

describe("SqliteSessionStore (bun:sqlite specifics)", () => {
  it("persists across close/reopen and supports prefix isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-bun-reopen-"));
    const dbPath = join(dir, "shared.sqlite");
    const snap: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: "bun-s1",
      model: { provider: "faux", modelId: "faux-1" },
      messages: [{ role: "user", content: [{ type: "text", text: "from bun" }], timestamp: 42 }],
      status: "idle",
      updatedAt: 42,
    };

    try {
      const store1 = await openBunSqliteSessionStore(dbPath, { prefix: "bun_" });
      await store1.save(snap.sessionId, snap);
      await store1.close();

      const store2 = await openBunSqliteSessionStore(dbPath, { prefix: "bun_" });
      const otherPrefix = await openBunSqliteSessionStore(dbPath, { prefix: "other_" });
      try {
        expect(await store2.load("bun-s1")).toEqual(snap);
        expect(await otherPrefix.load("bun-s1")).toBeNull();
      } finally {
        await store2.close();
        await otherPrefix.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back failed transactions and rejects expired transaction handles", async () => {
    const db = await openBunSqliteDatabase(":memory:");
    try {
      await db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");

      let leakedTx: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          leakedTx = tx;
          await tx.run("INSERT INTO kv (k, v) VALUES (?, ?)", "a", "1");
          throw new Error("bun boom");
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error)?.message).toBe("bun boom");
      expect(await db.get<{ v: string }>("SELECT v FROM kv WHERE k = ?", "a")).toBe(undefined);

      let expiredErr: unknown;
      try {
        await leakedTx!.run("INSERT INTO kv (k, v) VALUES (?, ?)", "b", "2");
      } catch (error) {
        expiredErr = error;
      }
      expect((expiredErr as Error)?.message).toContain("no longer active");
    } finally {
      await db.close();
    }
  });
});
