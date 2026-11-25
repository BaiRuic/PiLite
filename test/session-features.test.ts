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
  HarnessError,
  InMemorySessionStore,
  createSession,
  openSession,
} from "../src/index.js";

function createTestEnv() {
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "faux-1", reasoning: true, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 } },
      { id: "faux-2", reasoning: true, cost: { input: 3, output: 6, cacheRead: 1.5, cacheWrite: 4.5 } },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new InMemorySessionStore();
  return { faux, models, store };
}

async function expectHarnessError(
  promise: Promise<unknown>,
  code: HarnessError["code"],
): Promise<HarnessError> {
  try {
    await promise;
    throw new Error(`Expected HarnessError(${code}) but resolved.`);
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).code).toBe(code);
    return error as HarnessError;
  }
}

describe("HarnessSession management features (fork, setModel, thinking, title, reset, stats)", () => {
  it("forks a session independently at full history or safe prefix and rejects splitting toolCall/toolResult", async () => {
    const { faux, models, store } = createTestEnv();
    const seenSessionIds: string[] = [];

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

    faux.setResponses([
      (_ctx, opts) => {
        seenSessionIds.push(opts?.sessionId ?? "");
        return fauxAssistantMessage(fauxToolCall("lookup", { k: "a" }, { id: "tc-1" }), {
          stopReason: "toolUse",
        });
      },
      (_ctx, opts) => {
        seenSessionIds.push(opts?.sessionId ?? "");
        return fauxAssistantMessage("Root answer 1.");
      },
      (_ctx, opts) => {
        seenSessionIds.push(opts?.sessionId ?? "");
        return fauxAssistantMessage("Fork branch answer.");
      },
      (_ctx, opts) => {
        seenSessionIds.push(opts?.sessionId ?? "");
        return fauxAssistantMessage("Root answer 2.");
      },
    ]);

    const root = await createSession({
      sessionId: "root-1",
      title: "Root session",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "Root prompt",
      tools: [lookupTool],
    });
    await root.prompt("Check a");

    // Messages: [0:system, 1:user, 2:assistant(toolCall), 3:toolResult, 4:assistant(answer)]
    // Index 3 sits right between assistant(toolCall) and its toolResult -> must reject!
    await expectHarnessError(root.fork({ atMessageIndex: 3 }), "INVALID_OPTIONS");

    // Fork at full history gets a new sessionId and diverges independently from root.
    const forked = await root.fork({ sessionId: "fork-1", title: "Forked branch" });
    expect(forked.sessionId).toBe("fork-1");
    expect(forked.title).toBe("Forked branch");
    expect(forked.getSnapshot().parentSessionId).toBe("root-1");
    expect(forked.getSnapshot().messages).toEqual(root.getSnapshot().messages);

    await forked.prompt("Go down branch B");
    await root.prompt("Continue root");

    expect(seenSessionIds).toEqual(["root-1", "root-1", "fork-1", "root-1"]);
    expect(forked.getSnapshot().messages.length).toBe(7);
    expect(root.getSnapshot().messages.length).toBe(7);

    // Forking at a safe earlier index (before tool call, index 2 = [system, user]) succeeds.
    const earlyFork = await root.fork({ sessionId: "fork-early", atMessageIndex: 2 });
    expect(earlyFork.getSnapshot().messages.map((m) => m.role)).toEqual(["system", "user"]);

    const listed = await store.list();
    expect(listed.items.map((s) => s.sessionId).sort()).toEqual(["fork-1", "fork-early", "root-1"]);
  });

  it("switches model, thinking level, and title while idle and restores them on reopen", async () => {
    const { faux, models, store } = createTestEnv();
    const seenModels: string[] = [];
    const seenReasoning: Array<string | undefined> = [];

    faux.setResponses([
      (_ctx, opts, _state, model) => {
        seenModels.push(model.id);
        seenReasoning.push(opts?.reasoning);
        return fauxAssistantMessage("from faux-1");
      },
      (_ctx, opts, _state, model) => {
        seenModels.push(model.id);
        seenReasoning.push(opts?.reasoning);
        return fauxAssistantMessage("from faux-2");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-switch",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
    });

    await session.prompt("turn 1");

    await expectHarnessError(
      session.setModel({ provider: "faux", modelId: "missing" }),
      "MODEL_NOT_FOUND",
    );

    await session.setModel({ provider: "faux", modelId: "faux-2" });
    await session.setThinkingLevel("high");
    await session.setTitle("Switched session");

    expect(session.model).toEqual({ provider: "faux", modelId: "faux-2" });
    expect(session.thinkingLevel).toBe("high");
    expect(session.title).toBe("Switched session");

    // Reopen without specifying thinkingLevel -> restores persisted thinkingLevel and model.
    const reopened = await openSession({ sessionId: "sess-switch", models, store });
    expect(reopened.model).toEqual({ provider: "faux", modelId: "faux-2" });
    expect(reopened.thinkingLevel).toBe("high");
    expect(reopened.title).toBe("Switched session");

    await reopened.prompt("turn 2");
    expect(seenModels).toEqual(["faux-1", "faux-2"]);
    expect(seenReasoning).toEqual([undefined, "high"]);
  });

  it("resets history with optional handoff text while preserving model and system baseline", async () => {
    const { faux, models, store } = createTestEnv();
    faux.setResponses([
      fauxAssistantMessage("first reply"),
      fauxAssistantMessage("reply after handoff"),
    ]);

    const session = await createSession({
      sessionId: "sess-reset",
      title: "Keep title",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "Keep system prompt",
    });

    await session.prompt("old turn");
    expect(session.getSnapshot().messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);

    const cleared = await session.reset();
    expect(cleared.status).toBe("idle");
    expect(cleared.title).toBe("Keep title");
    expect(cleared.messages.map((m) => m.role)).toEqual(["system"]);

    const withHandoff = await session.reset("Continue fixing the flaky test.");
    expect(withHandoff.messages.map((m) => m.role)).toEqual(["system", "user"]);

    const continued = await session.continue();
    expect(continued.status).toBe("idle");
    expect(continued.snapshot.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("computes accurate message, tool, token, and cost stats", async () => {
    const { faux, models, store } = createTestEnv();
    const pingTool: AgentTool = {
      name: "ping",
      label: "Ping",
      description: "Ping tool",
      parameters: obj({}),
      execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ping", {}, { id: "tc-stat" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("All good."),
    ]);

    const session = await createSession({
      sessionId: "sess-stats",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [pingTool],
    });

    await session.prompt("Run ping");
    const liveStats = session.getStats();

    expect(liveStats.sessionId).toBe("sess-stats");
    expect(liveStats.userMessages).toBe(1);
    expect(liveStats.assistantMessages).toBe(2);
    expect(liveStats.toolCalls).toBe(1);
    expect(liveStats.toolResults).toBe(1);
    expect(liveStats.totalMessages).toBe(5); // system + user + assistant(tool) + toolResult + assistant
    expect(liveStats.tokens.total).toBeGreaterThan(0);
    expect(liveStats.tokens.total).toBe(
      liveStats.tokens.input +
        liveStats.tokens.output +
        liveStats.tokens.cacheRead +
        liveStats.tokens.cacheWrite,
    );

    // Also verify exact token & cost aggregation across persisted messages with explicit costs.
    const snapshot = session.getSnapshot();
    const assistants = snapshot.messages.filter((m) => m.role === "assistant");
    assistants[0]!.usage = {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0.0002, total: 0.0037 },
    };
    assistants[1]!.usage = {
      input: 120,
      output: 30,
      cacheRead: 80,
      cacheWrite: 0,
      totalTokens: 230,
      cost: { input: 0.0012, output: 0.003, cacheRead: 0.0008, cacheWrite: 0, total: 0.005 },
    };
    await store.save("sess-stats", snapshot);

    const reopened = await openSession({ sessionId: "sess-stats", models, store });
    const costStats = reopened.getStats();
    expect(costStats.tokens).toEqual({
      input: 220,
      output: 50,
      cacheRead: 130,
      cacheWrite: 10,
      total: 410,
    });
    expect(costStats.cost.total).toBeCloseTo(0.0087, 6);
  });
});
