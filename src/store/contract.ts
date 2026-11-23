import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot, type SessionStore } from "../types.js";

export interface SessionStoreContractRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: {
    (actual: unknown): {
      toBe(expected: unknown): void;
      toBeNull(): void;
      toEqual(expected: unknown): void;
    };
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
  });
}
