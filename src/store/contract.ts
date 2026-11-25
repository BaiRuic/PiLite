import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot, type SessionStore } from "../types.js";

export interface SessionStoreContractRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toBeNull(): void;
    toEqual(expected: unknown): void;
  };
}

export type SessionStoreFactory = (use: (store: SessionStore) => Promise<void>) => Promise<void>;

function createSampleSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    sessionId: "session-1",
    model: { provider: "faux", modelId: "faux-1" },
    status: "idle",
    updatedAt: 1_700_000_000_000,
    messages: [
      {
        role: "system",
        content: "",
        sections: { system: "You are helpful." },
        timestamp: 1_700_000_000_000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Check status" }],
        timestamp: 1_700_000_000_001,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need to call status tool." },
          { type: "toolCall", id: "call-1", name: "get_status", arguments: { verbose: true } },
        ],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1_700_000_000_002,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "get_status",
        content: [{ type: "text", text: "ok" }],
        details: { code: 200 },
        isError: false,
        timestamp: 1_700_000_000_003,
      },
    ],
    ...overrides,
  };
}

/**
 * Shared contract test suite for any `SessionStore` backend.
 */
export function registerSessionStoreContract(
  runner: SessionStoreContractRunner,
  name: string,
  withStore: SessionStoreFactory,
): void {
  const { describe, it, expect } = runner;

  describe(`SessionStore contract: ${name}`, () => {
    it("returns null when loading a missing session", async () => {
      await withStore(async (store) => {
        expect(await store.load("missing-session")).toBeNull();
      });
    });

    it("round-trips a full session snapshot", async () => {
      await withStore(async (store) => {
        const snapshot = createSampleSnapshot();
        await store.save(snapshot.sessionId, snapshot);

        const loaded = await store.load(snapshot.sessionId);
        expect(loaded).toEqual(snapshot);
      });
    });

    it("replaces an existing snapshot atomically, including clearing optional fields", async () => {
      await withStore(async (store) => {
        const failed = createSampleSnapshot({
          status: "error",
          lastError: "rate limited",
          updatedAt: 1_700_000_001_000,
        });
        await store.save(failed.sessionId, failed);
        expect(await store.load(failed.sessionId)).toEqual(failed);

        const recovered = createSampleSnapshot({
          status: "idle",
          updatedAt: 1_700_000_002_000,
        });
        await store.save(recovered.sessionId, recovered);

        const loaded = await store.load(recovered.sessionId);
        expect(loaded).toEqual(recovered);
        expect(loaded?.lastError).toBe(undefined);
      });
    });

    it("isolates snapshots across different session IDs", async () => {
      await withStore(async (store) => {
        const first = createSampleSnapshot({ sessionId: "session-a", status: "idle" });
        const second = createSampleSnapshot({
          sessionId: "session-b",
          status: "interrupted",
          model: { provider: "faux", modelId: "faux-2" },
        });

        await store.save(first.sessionId, first);
        await store.save(second.sessionId, second);

        expect(await store.load("session-a")).toEqual(first);
        expect(await store.load("session-b")).toEqual(second);
      });
    });

    it("does not leak mutations through saved or loaded snapshot references", async () => {
      await withStore(async (store) => {
        const input = createSampleSnapshot();
        await store.save(input.sessionId, input);

        // Mutate input after saving.
        input.messages.push({
          role: "user",
          content: [{ type: "text", text: "mutated" }],
          timestamp: 9_999,
        });

        const firstLoad = await store.load(input.sessionId);
        expect(firstLoad?.messages.length).toBe(4);

        // Mutate loaded output.
        firstLoad?.messages.pop();

        const secondLoad = await store.load(input.sessionId);
        expect(secondLoad?.messages.length).toBe(4);
      });
    });

    it("lists session summaries sorted by updatedAt descending and deletes sessions", async () => {
      await withStore(async (store) => {
        expect(await store.list()).toEqual({ items: [] });
        expect(await store.delete("missing")).toBe(false);

        const older = createSampleSnapshot({
          sessionId: "s-old",
          title: "Older chat",
          createdAt: 1_000,
          updatedAt: 1_500,
        });
        const newer = createSampleSnapshot({
          sessionId: "s-new",
          title: "Forked chat",
          parentSessionId: "s-old",
          status: "interrupted",
          createdAt: 2_000,
          updatedAt: 3_000,
          messages: [],
        });

        await store.save(older.sessionId, older);
        await store.save(newer.sessionId, newer);

        const listed = await store.list();
        expect(listed).toEqual({
          items: [
            {
              sessionId: "s-new",
              model: { provider: "faux", modelId: "faux-1" },
              status: "interrupted",
              title: "Forked chat",
              parentSessionId: "s-old",
              createdAt: 2_000,
              updatedAt: 3_000,
              messageCount: 0,
            },
            {
              sessionId: "s-old",
              model: { provider: "faux", modelId: "faux-1" },
              status: "idle",
              title: "Older chat",
              createdAt: 1_000,
              updatedAt: 1_500,
              messageCount: 4,
            },
          ],
        });

        expect(await store.delete("s-old")).toBe(true);
        expect(await store.delete("s-old")).toBe(false);
        expect(await store.load("s-old")).toBeNull();
        expect((await store.list()).items.map((s) => s.sessionId)).toEqual(["s-new"]);
      });
    });

    it("supports filtering by parentSessionId/status, cursor pagination, and rejects invalid queries", async () => {
      await withStore(async (store) => {
        const fixtures = [
          createSampleSnapshot({ sessionId: "s-1", status: "idle", updatedAt: 5_000 }),
          createSampleSnapshot({
            sessionId: "s-2",
            parentSessionId: "s-1",
            status: "idle",
            updatedAt: 4_000,
          }),
          createSampleSnapshot({
            sessionId: "s-3",
            parentSessionId: "s-1",
            status: "error",
            updatedAt: 4_000,
          }),
          createSampleSnapshot({
            sessionId: "s-4",
            parentSessionId: "s-1",
            status: "idle",
            updatedAt: 3_000,
          }),
          createSampleSnapshot({ sessionId: "s-5", status: "error", updatedAt: 2_000 }),
        ];

        for (const snap of fixtures) {
          await store.save(snap.sessionId, snap);
        }

        // Filter by parentSessionId.
        const children = await store.list({ parentSessionId: "s-1" });
        expect(children.items.map((s) => s.sessionId)).toEqual(["s-2", "s-3", "s-4"]);
        expect(children.nextCursor).toBe(undefined);

        // Filter by status.
        const errored = await store.list({ status: "error" });
        expect(errored.items.map((s) => s.sessionId)).toEqual(["s-3", "s-5"]);

        // Combined filter.
        const idleChildren = await store.list({ parentSessionId: "s-1", status: "idle" });
        expect(idleChildren.items.map((s) => s.sessionId)).toEqual(["s-2", "s-4"]);

        // Paginate all 5 items in pages of 2 (verifies tie-breaking when s-2 & s-3 share updatedAt=4_000).
        const collected: string[] = [];
        let cursor: string | undefined;
        let pageCount = 0;
        do {
          const page = await store.list({ limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
          collected.push(...page.items.map((s) => s.sessionId));
          cursor = page.nextCursor;
          pageCount += 1;
        } while (cursor !== undefined);

        expect(pageCount).toBe(3);
        expect(collected).toEqual(["s-1", "s-2", "s-3", "s-4", "s-5"]);

        // Invalid limit and cursor must reject with INVALID_OPTIONS.
        const assertInvalid = async (promise: Promise<unknown>) => {
          let code: unknown;
          try {
            await promise;
          } catch (error) {
            code = (error as { code?: unknown })?.code;
          }
          expect(code).toBe("INVALID_OPTIONS");
        };

        await assertInvalid(store.list({ limit: 0 }));
        await assertInvalid(store.list({ limit: -3 }));
        await assertInvalid(store.list({ limit: 1.5 }));
        await assertInvalid(store.list({ cursor: "" }));
        await assertInvalid(store.list({ cursor: "not-a-valid-cursor!!!" }));
      });
    });
  });
}
