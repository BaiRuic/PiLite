import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbSessionStore } from "../src/store/indexeddb.js";
import { registerSessionStoreContract } from "../src/testing.js";
import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot } from "../src/types.js";

registerSessionStoreContract(
  { describe, it, expect },
  "IndexedDbSessionStore (fake-indexeddb)",
  async (use) => {
    const factory = new IDBFactory();
    const store = await IndexedDbSessionStore.open("pilite-contract", {
      indexedDB: factory,
      IDBKeyRange,
    });
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

describe("IndexedDbSessionStore (reopen, v1->v2 migration, summary isolation, and lifecycle)", () => {
  it("persists snapshots across close and reopen within the same IDBFactory", async () => {
    const factory = new IDBFactory();
    const snapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: "browser-session-1",
      model: { provider: "faux", modelId: "faux-1" },
      messages: [{ role: "user", content: [{ type: "text", text: "saved in browser" }], timestamp: 500 }],
      status: "running",
      updatedAt: 500,
    };

    const store1 = await IndexedDbSessionStore.open("app-db", {
      indexedDB: factory,
      IDBKeyRange,
      storeName: "custom_sessions",
    });
    await store1.save(snapshot.sessionId, snapshot);
    await store1.close();

    const store2 = await IndexedDbSessionStore.open("app-db", {
      indexedDB: factory,
      IDBKeyRange,
      storeName: "custom_sessions",
    });
    try {
      expect(await store2.load("browser-session-1")).toEqual(snapshot);
      const listed = await store2.list();
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.sessionId).toBe("browser-session-1");
    } finally {
      await store2.close();
    }
  });

  it("migrates a v1 single-store database to v2 split snapshot/summary stores without losing data", async () => {
    const factory = new IDBFactory();
    const legacySnapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: "legacy-1",
      model: { provider: "faux", modelId: "faux-1" },
      title: "Legacy chat",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello from v1" }], timestamp: 100 }],
      status: "idle",
      updatedAt: 200,
    };

    // Seed a schema v1 database containing only the snapshot object store.
    await new Promise<void>((resolve, reject) => {
      const openReq = factory.open("legacy-db", 1);
      openReq.addEventListener("upgradeneeded", () => {
        const db = openReq.result;
        db.createObjectStore("harness_sessions", { keyPath: "sessionId" });
      });
      openReq.addEventListener("error", () => reject(openReq.error));
      openReq.addEventListener("success", () => {
        const db = openReq.result;
        const tx = db.transaction("harness_sessions", "readwrite");
        tx.objectStore("harness_sessions").put({
          sessionId: legacySnapshot.sessionId,
          version: legacySnapshot.version,
          status: legacySnapshot.status,
          updatedAt: legacySnapshot.updatedAt,
          snapshot: legacySnapshot,
        });
        tx.addEventListener("complete", () => {
          db.close();
          resolve();
        });
        tx.addEventListener("error", () => reject(tx.error));
      });
    });

    const migrated = await IndexedDbSessionStore.open("legacy-db", {
      indexedDB: factory,
      IDBKeyRange,
    });
    try {
      const page = await migrated.list();
      expect(page.items).toEqual([
        {
          sessionId: "legacy-1",
          model: { provider: "faux", modelId: "faux-1" },
          title: "Legacy chat",
          status: "idle",
          messageCount: 1,
          createdAt: 200,
          updatedAt: 200,
        },
      ]);
      expect(await migrated.load("legacy-1")).toEqual(legacySnapshot);
    } finally {
      await migrated.close();
    }
  });

  it("scans only the summaries store during list() without touching the snapshots store", async () => {
    const factory = new IDBFactory();
    const store = await IndexedDbSessionStore.open("isolation-db", {
      indexedDB: factory,
      IDBKeyRange,
    });
    try {
      await store.save("s-1", {
        version: SESSION_SNAPSHOT_VERSION,
        sessionId: "s-1",
        model: { provider: "faux", modelId: "faux-1" },
        messages: [{ role: "user", content: [{ type: "text", text: "payload" }], timestamp: 100 }],
        status: "idle",
        updatedAt: 100,
      });
      await store.close();

      // Open the raw database and delete the snapshot record directly while keeping the summary record;
      // if list() only reads the summaries store, it will still return the summary entry.
      await new Promise<void>((resolve, reject) => {
        const req = factory.open("isolation-db", 2);
        req.addEventListener("error", () => reject(req.error));
        req.addEventListener("success", () => {
          const db = req.result;
          const tx = db.transaction("harness_sessions", "readwrite");
          tx.objectStore("harness_sessions").delete("s-1");
          tx.addEventListener("complete", () => {
            db.close();
            resolve();
          });
          tx.addEventListener("error", () => reject(tx.error));
        });
      });

      const reopened = await IndexedDbSessionStore.open("isolation-db", {
        indexedDB: factory,
        IDBKeyRange,
      });
      try {
        expect(await reopened.load("s-1")).toBeNull();
        const listed = await reopened.list();
        expect(listed.items).toHaveLength(1);
        expect(listed.items[0]?.sessionId).toBe("s-1");
        expect(listed.items[0]?.messageCount).toBe(1);
      } finally {
        await reopened.close();
      }
    } finally {
      await store.close();
    }
  });

  it("rejects operations after close and validates options", async () => {
    const factory = new IDBFactory();
    await expect(IndexedDbSessionStore.open("  ", { indexedDB: factory, IDBKeyRange })).rejects.toThrow(
      /non-empty/i,
    );
    await expect(
      IndexedDbSessionStore.open("valid", { indexedDB: factory, IDBKeyRange, storeName: "" }),
    ).rejects.toThrow(/non-empty/i);
    await expect(
      IndexedDbSessionStore.open("valid", { indexedDB: factory, IDBKeyRange, summaryStoreName: " " }),
    ).rejects.toThrow(/non-empty/i);

    const store = await IndexedDbSessionStore.open("close-test", { indexedDB: factory, IDBKeyRange });
    await store.close();
    await store.close(); // idempotent
    await expect(store.load("any")).rejects.toThrow(/closed/i);
  });
});
