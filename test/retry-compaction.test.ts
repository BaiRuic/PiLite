import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  createSession,
  type ExtensionFactory,
  HarnessError,
  InMemorySessionStore,
  openSession,
  type RetryEvent,
  type SessionCompactEvent,
  type SessionCompactFailedEvent,
  type SessionUsageEvent,
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
      fauxAssistantMessage(`Turn 1 answer: ${"x".repeat(400)}`),
      fauxAssistantMessage(`Turn 2 answer: ${"y".repeat(400)}`),
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

    await session.prompt(`Turn 1 question ${"a".repeat(200)}`);
    await session.prompt(`Turn 2 question ${"b".repeat(200)}`);
    await session.prompt("Lookup recent");

    const beforeMessageCount = session.getSnapshot().messages.length;
    const compacted = await session.compact({ keepRecentTokens: 60 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.summary).toBe("Summary: discussed x and y.");
    expect(compacted.checkpoint?.trigger).toBe("manual");
    expect(compacted.checkpoint?.compactedAtIndex).toBe(beforeMessageCount);
    expect(compacted.compactedMessages).toBeGreaterThan(0);
    expect(compacted.tokensAfter).toBeLessThan(compacted.tokensBefore);

    // Non-destructive: full transcript stays intact in snapshot.messages while projected
    // model context starts with [system, <conversation_summary>, ...kept].
    const persisted = await openSession({ sessionId: "sess-compact-manual", models, store });
    expect(persisted.getSnapshot().messages).toHaveLength(beforeMessageCount);
    expect(persisted.getSnapshot().compactions).toHaveLength(1);
    expect(persisted.getSnapshot().compactions?.[0]?.summary).toBe("Summary: discussed x and y.");

    const contextMessages = persisted.getContextMessages();
    expect(contextMessages.length).toBeLessThan(beforeMessageCount);
    const contextRoles = contextMessages.map((m) => m.role);
    expect(contextRoles[0]).toBe("system");
    expect(contextRoles[1]).toBe("user"); // <conversation_summary>
    expect(persisted.getStats().userMessages).toBe(3);
  });

  it("supports repeated non-destructive compactions, fork across checkpoints, and reset", async () => {
    const { faux, models, store } = createTestEnv();
    const summarizerInputs: number[] = [];

    faux.setResponses([
      fauxAssistantMessage(`Turn 1 reply ${"a".repeat(240)}`),
      fauxAssistantMessage(`Turn 2 reply ${"b".repeat(240)}`),
      fauxAssistantMessage(`Turn 3 reply ${"c".repeat(240)}`),
      fauxAssistantMessage(`Turn 4 reply ${"d".repeat(240)}`),
      fauxAssistantMessage("Turn 5 reply after two compactions"),
    ]);

    const session = await createSession({
      sessionId: "sess-multi-compact",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "Base system.",
      compaction: {
        summarizer: async ({ messages }) => {
          summarizerInputs.push(messages.length);
          const first = messages[0];
          const includesPreviousSummary =
            first?.role === "user" &&
            typeof first.content !== "string" &&
            first.content.some((b) => b.type === "text" && b.text.includes("<conversation_summary>"));
          return { summary: includesPreviousSummary ? "Folded summary #2" : "Initial summary #1" };
        },
      },
    });

    await session.prompt(`Q1 ${"1".repeat(120)}`);
    await session.prompt(`Q2 ${"2".repeat(120)}`);
    const c1 = await session.compact({ keepRecentTokens: 40 });
    expect(c1.compacted).toBe(true);
    expect(c1.summary).toBe("Initial summary #1");
    expect(session.getSnapshot().messages).toHaveLength(5); // system + 2*(user+assistant)

    await session.prompt(`Q3 ${"3".repeat(120)}`);
    await session.prompt(`Q4 ${"4".repeat(120)}`);
    const c2 = await session.compact({ keepRecentTokens: 40 });
    expect(c2.compacted).toBe(true);
    expect(c2.summary).toBe("Folded summary #2");
    expect(summarizerInputs).toHaveLength(2);

    // Turn 5 runs against projected context while appending to full history.
    const r5 = await session.prompt("Q5");
    expect(r5.status).toBe("idle");
    expect(r5.snapshot.messages).toHaveLength(11); // system + 5*(user+assistant)
    expect(r5.snapshot.compactions).toHaveLength(2);
    expect(r5.snapshot.compactions?.[0]?.firstKeptIndex).toBeLessThan(
      r5.snapshot.compactions?.[1]?.firstKeptIndex ?? 0,
    );

    const ctx = session.getContextMessages();
    expect(ctx.length).toBeLessThan(11);
    expect(ctx[0]?.role).toBe("system");
    expect(ctx[1]?.role).toBe("user");
    expect(JSON.stringify(ctx[1])).toContain("Folded summary #2");

    // Fork BEFORE first compaction drops both checkpoints and exposes raw pre-compaction history.
    const earlyFork = await session.fork({ sessionId: "fork-before-c1", atMessageIndex: 3 });
    expect(earlyFork.getSnapshot().messages).toHaveLength(3);
    expect(earlyFork.getSnapshot().compactions).toBeUndefined();
    expect(earlyFork.getContextMessages()).toHaveLength(3);

    // Fork BETWEEN compaction #1 and #2 keeps only checkpoint #1.
    const midFork = await session.fork({
      sessionId: "fork-between-c1-c2",
      atMessageIndex: c1.checkpoint!.compactedAtIndex,
    });
    expect(midFork.getSnapshot().compactions).toHaveLength(1);
    expect(JSON.stringify(midFork.getContextMessages()[1])).toContain("Initial summary #1");

    // Reset clears both messages and checkpoints.
    const resetSnap = await session.reset("Fresh handoff");
    expect(resetSnap.compactions).toBeUndefined();
    expect(session.getContextMessages()).toHaveLength(2); // system + handoff user
  });

  it("supports automatic threshold compaction and overflow recovery", async () => {
    const { faux, models, store } = createTestEnv(300);
    const summariesMade: number[] = [];

    // 1. Threshold compaction: tiny contextWindow (300) with reserveTokens (100) triggers auto-compact before turn 3.
    faux.setResponses([
      fauxAssistantMessage(`Answer 1 ${"a".repeat(300)}`),
      fauxAssistantMessage(`Answer 2 ${"b".repeat(300)}`),
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
          return { summary: `Compacted ${messages.length} earlier messages.` };
        },
      },
    });

    await s1.prompt(`First ${"q".repeat(120)}`);
    await s1.prompt(`Second ${"q".repeat(120)}`);
    const r3 = await s1.prompt("Third");

    expect(r3.status).toBe("idle");
    expect(summariesMade.length).toBeGreaterThan(0);
    expect(r3.snapshot.messages).toHaveLength(6); // full 3*(user+assistant) preserved
    expect(r3.snapshot.compactions?.some((c) => c.trigger === "threshold")).toBe(true);
    expect(s1.getContextMessages().length).toBeLessThan(r3.snapshot.messages.length);

    // 2. Context overflow recovery: provider returns prompt-too-long error -> compacts once and retries.
    const overflowSummaries: number[] = [];
    faux.setResponses([
      fauxAssistantMessage(`Earlier detailed answer ${"y".repeat(80)}`),
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
          return { summary: "Overflow summary" };
        },
      },
    });

    await s2.prompt(`Earlier detailed question ${"x".repeat(80)}`);
    const recovered = await s2.prompt("Trigger overflow");

    expect(recovered.status).toBe("idle");
    expect(overflowSummaries).toEqual([2]);
    expect(recovered.snapshot.messages).toHaveLength(4); // all 4 messages preserved intact
    expect(recovered.snapshot.compactions?.some((c) => c.trigger === "overflow")).toBe(true);
    expect(s2.getContextMessages()).toHaveLength(3); // summary + user("Trigger overflow") + recovered assistant
  });

  it("routes built-in and custom compaction through session_before_compact / session_compact / session_compact_failed hooks", async () => {
    const { faux, models, store } = createTestEnv();
    const compactEvents: SessionCompactEvent[] = [];
    const failedEvents: SessionCompactFailedEvent[] = [];
    let observedInstructions: string | undefined;
    let mode: "cancel" | "instructions" | "custom" | "bad-cut" | "throw" = "cancel";

    const lookupTool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Read-only lookup",
      parameters: obj({ k: str() }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: `val:${(params as { k: string }).k}` }],
        details: {},
      }),
    };

    const compactionExt: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", (event) => {
        if (mode === "cancel") {
          return { cancel: true };
        }
        if (mode === "instructions") {
          return { customInstructions: "Preserve all citations and DOIs" };
        }
        if (mode === "custom") {
          return {
            compaction: {
              summary: `Custom summary covering ${event.preparation.messagesToSummarize.length} msgs`,
              firstKeptIndex: event.preparation.firstKeptIndex,
              details: { citations: ["doi:10.1000/xyz"] },
            },
          };
        }
        if (mode === "bad-cut") {
          // Index right on a toolResult message splits the preceding toolCall from its toolResult.
          const toolResultIdx = event.messages.findIndex((m) => m.role === "toolResult");
          return { compaction: { summary: "Invalid cut", firstKeptIndex: toolResultIdx } };
        }
        throw new Error("custom summarizer exploded");
      });
      pi.on("session_compact", (event) => {
        compactEvents.push(event);
      });
      pi.on("session_compact_failed", (event) => {
        failedEvents.push(event);
      });
    };

    faux.setResponses([
      fauxAssistantMessage(`Turn 1 reply ${"a".repeat(200)}`),
      fauxAssistantMessage(fauxToolCall("lookup", { k: "paper" }, { id: "tc-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Turn 2 final reply"),
      fauxAssistantMessage(`Turn 3 reply ${"b".repeat(200)}`),
    ]);

    const session = await createSession({
      sessionId: "sess-compact-hooks",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [lookupTool],
      extensions: [compactionExt],
      compaction: {
        summarizer: async ({ instructions }) => {
          observedInstructions = instructions;
          return { summary: "Built-in summary with custom instructions" };
        },
      },
    });

    await session.prompt(`Q1 ${"1".repeat(120)}`);
    await session.prompt("Lookup paper");
    await session.prompt(`Q3 ${"3".repeat(120)}`);

    // 1. Extension cancels compaction cleanly.
    mode = "cancel";
    const cancelled = await session.compact({ keepRecentTokens: 40 });
    expect(cancelled.compacted).toBe(false);
    expect(compactEvents).toHaveLength(0);

    // 2. Extension overrides customInstructions; built-in compaction extension produces the summary (fromExtension=false).
    mode = "instructions";
    const withInstr = await session.compact({ keepRecentTokens: 40 });
    expect(withInstr.compacted).toBe(true);
    expect(observedInstructions).toBe("Preserve all citations and DOIs");
    expect(compactEvents).toHaveLength(1);
    expect(compactEvents[0]?.fromExtension).toBe(false);
    expect(compactEvents[0]?.reason).toBe("manual");

    // 3. Extension supplies custom summary + structured details (fromExtension=true).
    await session.prompt(`Q4 ${"4".repeat(120)}`);
    faux.setResponses([fauxAssistantMessage(`Turn 4 reply ${"c".repeat(200)}`)]);
    // Also add one more turn so a second compaction has fresh messages to summarize.
    await session.prompt(`Q5 ${"5".repeat(120)}`);
    mode = "custom";
    const custom = await session.compact({ keepRecentTokens: 40 });
    expect(custom.compacted).toBe(true);
    expect(custom.checkpoint?.details).toEqual({ citations: ["doi:10.1000/xyz"] });
    expect(compactEvents).toHaveLength(2);
    expect(compactEvents[1]?.fromExtension).toBe(true);
    expect(session.getSnapshot().compactions?.at(-1)?.details).toEqual({ citations: ["doi:10.1000/xyz"] });

    // 4. Extension returns an unsafe firstKeptIndex splitting toolCall/toolResult -> rejected & emits session_compact_failed.
    faux.setResponses([fauxAssistantMessage(`Turn 6 reply ${"d".repeat(200)}`)]);
    await session.prompt(`Q6 ${"6".repeat(120)}`);
    mode = "bad-cut";
    await expect(session.compact({ keepRecentTokens: 40 })).rejects.toBeInstanceOf(HarnessError);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.fromExtension).toBe(true);
    expect(failedEvents[0]?.aborted).toBe(false);
    expect(failedEvents[0]?.errorMessage).toMatch(/firstKeptIndex/i);

    // 5. Extension throws -> emits session_compact_failed and propagates error.
    mode = "throw";
    await expect(session.compact({ keepRecentTokens: 40 })).rejects.toThrow("custom summarizer exploded");
    expect(failedEvents).toHaveLength(2);
    expect(failedEvents[1]?.fromExtension).toBe(true);
    expect(failedEvents[1]?.errorMessage).toBe("custom summarizer exploded");
  });

  it("records compaction usage on checkpoints, includes it in getStats(), and emits unified onUsage events", async () => {
    const { faux, models, store } = createTestEnv();
    const usageEvents: SessionUsageEvent[] = [];

    const helperTool: AgentTool = {
      name: "helper",
      label: "Helper",
      description: "Returns a tool result with nested usage",
      parameters: obj({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      }),
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("helper", {}, { id: "tc-u1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(`Turn 1 reply ${"a".repeat(200)}`),
      fauxAssistantMessage(`Turn 2 reply ${"b".repeat(200)}`),
      // Built-in compaction summary LLM call
      fauxAssistantMessage("Compacted summary with tracked usage"),
    ]);

    const session = await createSession({
      sessionId: "sess-usage-accounting",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [helperTool],
      onUsage: (event) => usageEvents.push(event),
    });

    await session.prompt(`Q1 ${"1".repeat(120)}`);
    await session.prompt(`Q2 ${"2".repeat(120)}`);

    const statsBeforeCompact = session.getStats();
    const compacted = await session.compact({ keepRecentTokens: 40 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.usage).toBeDefined();
    expect(compacted.usage!.totalTokens).toBeGreaterThan(0);
    expect(compacted.checkpoint?.usage).toEqual(compacted.usage);

    // getStats() includes compaction usage on top of turn + tool usage.
    const statsAfterCompact = session.getStats();
    expect(statsAfterCompact.tokens.total).toBe(
      statsBeforeCompact.tokens.total + compacted.usage!.totalTokens,
    );

    // Reopening from store preserves compaction usage in getStats().
    const reopened = await openSession({ sessionId: "sess-usage-accounting", models, store });
    expect(reopened.getStats().tokens.total).toBe(statsAfterCompact.tokens.total);

    // Verify unified onUsage emitted turn, tool, and compaction events.
    expect(usageEvents.filter((e) => e.source === "turn").length).toBeGreaterThanOrEqual(3);
    expect(usageEvents.filter((e) => e.source === "tool")).toHaveLength(1);
    expect(usageEvents.find((e) => e.source === "tool")?.toolName).toBe("helper");
    expect(usageEvents.filter((e) => e.source === "compaction")).toHaveLength(1);

    // Trigger another compaction where the summarization response errors after incurring tokens.
    faux.setResponses([
      fauxAssistantMessage(`Turn 3 reply ${"c".repeat(200)}`),
      fauxAssistantMessage(`Turn 4 reply ${"d".repeat(200)}`),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "upstream timeout after billing",
      }),
    ]);
    await session.prompt(`Q3 ${"3".repeat(120)}`);
    await session.prompt(`Q4 ${"4".repeat(120)}`);
    await expect(session.compact({ keepRecentTokens: 40 })).rejects.toThrow("upstream timeout after billing");
    const compactionUsages = usageEvents.filter((e) => e.source === "compaction");
    expect(compactionUsages).toHaveLength(2);
    expect(compactionUsages[1]?.usage.input).toBeGreaterThan(0);
  });
});
