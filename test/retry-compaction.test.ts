import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  InMemorySessionStore,
  createSession,
  openSession,
  type RetryEvent,
} from "../src/index.js";

function createTestEnv(contextWindow = 100_000) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new InMemorySessionStore();
  return { faux, models, store };
}

describe("Auto-retry and context compaction", () => {
  it("retries transient retryable provider errors and succeeds without leaking failed error bubbles", async () => {
    const { faux, models, store } = createTestEnv();
    const retryEvents: RetryEvent[] = [];

    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("Succeeded on attempt 3."),
    ]);

    const session = await createSession({
      sessionId: "sess-retry-ok",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      retry: {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
        onRetry: (event) => retryEvents.push(event),
        sleep: async () => undefined,
      },
    });

    const result = await session.prompt("hello");
    expect(result.status).toBe("idle");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]?.attempt).toBe(1);
    expect(retryEvents[1]?.attempt).toBe(2);
    expect(faux.state.callCount).toBe(3);
    expect(result.snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("does not retry non-retryable errors and cancels promptly when aborted during backoff", async () => {
    const { faux, models, store } = createTestEnv();

    // Non-retryable error (e.g. invalid API key / 400 bad request) fails immediately.
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error" }),
      fauxAssistantMessage("should not be called"),
    ]);

    const s1 = await createSession({
      sessionId: "sess-non-retryable",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      retry: { maxRetries: 3, sleep: async () => undefined },
    });

    const failed = await s1.prompt("bad request");
    expect(failed.status).toBe("error");
    expect(faux.state.callCount).toBe(1);

    // Abort during retry backoff sleep wakes up immediately and commits `aborted`.
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit" }),
      fauxAssistantMessage("should never run after abort"),
    ]);

    let enteredSleep!: () => void;
    const sleepEntered = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });

    const s2 = await createSession({
      sessionId: "sess-abort-backoff",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      retry: {
        maxRetries: 3,
        sleep: (_ms, signal) =>
          new Promise<void>((resolve) => {
            enteredSleep();
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
    });

    const runPromise = s2.prompt("trigger retry");
    await sleepEntered;
    await s2.abort();

    const aborted = await runPromise;
    expect(aborted.status).toBe("aborted");
    expect(faux.state.callCount).toBe(2); // 1 from s1 + 1 from s2 (no second attempt after abort)
  });

  it("compacts older messages manually without splitting toolCall/toolResult pairs and persists summary", async () => {
    const { faux, models, store } = createTestEnv();
    const lookupTool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Read-only lookup",
      parameters: obj({ k: str() }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: `value=${(params as { k: string }).k}` }],
        details: {},
      }),
    };

    faux.setResponses([
      fauxAssistantMessage("Turn 1 answer: " + "x".repeat(400)),
      fauxAssistantMessage("Turn 2 answer: " + "y".repeat(400)),
      fauxAssistantMessage(fauxToolCall("lookup", { k: "recent" }, { id: "tc-keep" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Recent final answer."),
      // Summarization call via models.completeSimple
      fauxAssistantMessage("Summary: discussed x and y."),
    ]);

    const session = await createSession({
      sessionId: "sess-compact-manual",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "Keep system.",
      tools: [lookupTool],
    });

    await session.prompt("Turn 1 question " + "a".repeat(200));
    await session.prompt("Turn 2 question " + "b".repeat(200));
    await session.prompt("Lookup recent");

    const compacted = await session.compact({ keepRecentTokens: 60 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.summary).toBe("Summary: discussed x and y.");
    expect(compacted.compactedMessages).toBeGreaterThan(0);
    expect(compacted.tokensAfter).toBeLessThan(compacted.tokensBefore);

    // Ensure toolCall and its toolResult stayed together or were compacted together (no orphan toolResult).
    const persisted = await openSession({ sessionId: "sess-compact-manual", models, store });
    const roles = persisted.getSnapshot().messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles[1]).toBe("user"); // <conversation_summary>
    expect(persisted.getSnapshot().customEntries?.some((e) => e.customType === "harness.compaction")).toBe(true);
  });

  it("supports automatic threshold compaction and overflow recovery", async () => {
    const { faux, models, store } = createTestEnv(300);
    const summariesMade: number[] = [];

    // 1. Threshold compaction: tiny contextWindow (300) with reserveTokens (100) triggers auto-compact before turn 3.
    faux.setResponses([
      fauxAssistantMessage("Answer 1 " + "a".repeat(300)),
      fauxAssistantMessage("Answer 2 " + "b".repeat(300)),
      fauxAssistantMessage("Answer 3 after threshold compaction"),
    ]);

    const s1 = await createSession({
      sessionId: "sess-auto-threshold",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      compaction: {
        enabled: true,
        contextWindow: 300,
        reserveTokens: 100,
        keepRecentTokens: 40,
        summarizer: async ({ messages }) => {
          summariesMade.push(messages.length);
          return `Compacted ${messages.length} earlier messages.`;
        },
      },
    });

    await s1.prompt("First " + "q".repeat(120));
    await s1.prompt("Second " + "q".repeat(120));
    const r3 = await s1.prompt("Third");

    expect(r3.status).toBe("idle");
    expect(summariesMade.length).toBeGreaterThan(0);
    expect(r3.snapshot.customEntries?.some((e) => e.customType === "harness.compaction")).toBe(true);

    // 2. Context overflow recovery: provider returns prompt-too-long error -> compacts once and retries.
    const overflowSummaries: number[] = [];
    faux.setResponses([
      fauxAssistantMessage("Earlier detailed answer " + "y".repeat(80)),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 210000 tokens > 200000 maximum",
      }),
      fauxAssistantMessage("Recovered after overflow compaction!"),
    ]);

    const s2 = await createSession({
      sessionId: "sess-auto-overflow",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      compaction: {
        enabled: true,
        contextWindow: 200_000,
        reserveTokens: 16_384,
        keepRecentTokens: 10,
        summarizer: async ({ messages }) => {
          overflowSummaries.push(messages.length);
          return "Overflow summary";
        },
      },
    });

    await s2.prompt("Earlier detailed question " + "x".repeat(80));
    const recovered = await s2.prompt("Trigger overflow");

    expect(recovered.status).toBe("idle");
    expect(overflowSummaries).toEqual([2]);
    expect(
      recovered.snapshot.customEntries?.some(
        (e) => e.customType === "harness.compaction" && (e.data as { trigger?: string })?.trigger === "overflow",
      ),
    ).toBe(true);
  });
});
