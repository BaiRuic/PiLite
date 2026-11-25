import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbSessionStore } from "../src/store/indexeddb.js";
import { registerSessionStoreContract } from "../src/testing.js";
import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot } from "../src/types.js";

registerSessionStoreContract(
  { describe, it, expect },
  "IndexedDbSessionStore (fake-indexeddb)",
  async (use) => {
    const factory = new IDBFactory();
    const store = await IndexedDbSessionStore.open("pi-harness-contract", {
      indexedDB: factory,
    });
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

describe("IndexedDbSessionStore (reopen, custom storeName, and lifecycle)", () => {
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
      storeName: "custom_sessions",
    });
    await store1.save(snapshot.sessionId, snapshot);
    await store1.close();

    const store2 = await IndexedDbSessionStore.open("app-db", {
      indexedDB: factory,
      storeName: "custom_sessions",
    });
    try {
      expect(await store2.load("browser-session-1")).toEqual(snapshot);
    } finally {
      await store2.close();
    }
  });

  it("rejects operations after close and validates options", async () => {
    const factory = new IDBFactory();
    await expect(IndexedDbSessionStore.open("  ", { indexedDB: factory })).rejects.toThrow(/non-empty/i);
    await expect(IndexedDbSessionStore.open("valid", { indexedDB: factory, storeName: "" })).rejects.toThrow(
      /non-empty/i,
    );

    const store = await IndexedDbSessionStore.open("close-test", { indexedDB: factory });
    await store.close();
    await store.close(); // idempotent
    await expect(store.load("any")).rejects.toThrow(/closed/i);
  });
});
