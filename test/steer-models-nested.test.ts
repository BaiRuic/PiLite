import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText, createModels, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  createSession,
  defineTool,
  type ExtensionFactory,
  HarnessError,
  InMemorySessionStore,
} from "../src/index.js";

function createFauxModels(modelId = "faux-1", tokensPerSecond?: number) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: modelId }],
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

describe("Hot-swappable Models provider (() => Models)", () => {
  it("picks up swapped Models registries between runs and surfaces MODEL_NOT_FOUND if removed", async () => {
    const first = createFauxModels("faux-1");
    const second = createFauxModels("faux-1");
    const empty = createModels();

    first.faux.setResponses([fauxAssistantMessage("from provider A")]);
    second.faux.setResponses([fauxAssistantMessage("from provider B")]);

    let activeModels: Models = first.models;
    const store = new InMemorySessionStore();

    const session = await createSession({
      sessionId: "sess-hot-swap",
      models: () => activeModels,
      store,
      model: { provider: "faux", modelId: "faux-1" },
    });

    const r1 = await session.prompt("turn 1");
    expect(r1.status).toBe("idle");
    const last1 = r1.snapshot.messages.at(-1);
    expect(last1?.role === "assistant" && contentText(last1.content)).toBe("from provider A");

    // Hot-swap the Models registry (e.g. rotated credentials or custom provider instance).
    activeModels = second.models;
    const r2 = await session.prompt("turn 2");
    expect(r2.status).toBe("idle");
    const last2 = r2.snapshot.messages.at(-1);
    expect(last2?.role === "assistant" && contentText(last2.content)).toBe("from provider B");

    // Removing the session's model from the active registry rejects cleanly before running.
    activeModels = empty;
    await expect(session.prompt("turn 3")).rejects.toMatchObject({
      name: "HarnessError",
      code: "MODEL_NOT_FOUND",
    });
    expect(session.isRunning).toBe(false);
    expect(session.getSnapshot().status).toBe("idle");
  });
});

describe("Running-turn steer() and followUp()", () => {
  it("rejects steer() and followUp() when session is idle", async () => {
    const { models } = createFauxModels();
    const session = await createSession({
      sessionId: "sess-idle-queue",
      models,
      store: new InMemorySessionStore(),
      model: { provider: "faux", modelId: "faux-1" },
    });

    expect(() => session.steer("mid-turn")).toThrow(HarnessError);
    try {
      session.steer("mid-turn");
    } catch (error) {
      expect((error as HarnessError).code).toBe("SESSION_IDLE");
    }

    try {
      session.followUp("after-turn");
    } catch (error) {
      expect((error as HarnessError).code).toBe("SESSION_IDLE");
    }
  });

  it("injects steering message after a tool round and persists the full steered transcript", async () => {
    const { faux, models } = createFauxModels();
    const store = new InMemorySessionStore();
    const seenUserTexts: string[][] = [];

    let releaseTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let allowToolFinish!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      allowToolFinish = resolve;
    });

    const slowTool: AgentTool = {
      name: "slow_step",
      label: "Slow Step",
      description: "Waits for gate",
      parameters: obj({}),
      execute: async () => {
        releaseTool();
        await toolGate;
        return { content: [{ type: "text", text: "step-done" }], details: {} };
      },
    };

    faux.setResponses([
      (ctx) => {
        seenUserTexts.push(ctx.messages.filter((m) => m.role === "user").map((m) => contentText(m.content)));
        return fauxAssistantMessage(fauxToolCall("slow_step", {}, { id: "tc-steer-1" }), {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        seenUserTexts.push(ctx.messages.filter((m) => m.role === "user").map((m) => contentText(m.content)));
        return fauxAssistantMessage("Steered final answer.");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-steer",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      tools: [slowTool],
    });

    const runPromise = session.prompt("Start task");
    await toolStarted;

    session.steer("Actually switch to plan B");
    expect(session.hasQueuedMessages()).toBe(true);
    allowToolFinish();

    const result = await runPromise;
    expect(result.status).toBe("idle");
    expect(session.hasQueuedMessages()).toBe(false);
    expect(seenUserTexts).toEqual([["Start task"], ["Start task", "Actually switch to plan B"]]);

    const persisted = await store.load("sess-steer");
    expect(persisted?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
    ]);
  });

  it("runs queued followUp() after the initial answer completes and clears queues on abort()", async () => {
    const { faux, models } = createFauxModels("faux-1", 50);
    const store = new InMemorySessionStore();

    faux.setResponses([
      fauxAssistantMessage("First answer with several words so streaming emits deltas."),
      fauxAssistantMessage("Follow-up answer."),
    ]);

    const session = await createSession({
      sessionId: "sess-followup",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
    });

    let queued = false;
    session.subscribe((event) => {
      if (!queued && event.type === "message_update") {
        queued = true;
        session.followUp("Now summarize in one word.");
      }
    });

    const result = await session.prompt("Explain briefly.");
    expect(result.status).toBe("idle");
    const assistants = result.snapshot.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => contentText(m.content))).toEqual([
      "First answer with several words so streaming emits deltas.",
      "Follow-up answer.",
    ]);

    // Verify abort clears queued follow-ups so the second turn does NOT execute.
    let secondTurnInvoked = false;
    faux.setResponses([
      fauxAssistantMessage("Long response that gets aborted mid-stream with enough words to stream slowly."),
      () => {
        secondTurnInvoked = true;
        return fauxAssistantMessage("Should never run.");
      },
    ]);

    let aborted = false;
    const unsub = session.subscribe((event) => {
      if (!aborted && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        aborted = true;
        session.followUp("Should be discarded on abort");
        expect(session.hasQueuedMessages()).toBe(true);
        void session.abort();
      }
    });

    const abortedResult = await session.prompt("Start streaming");
    unsub();
    expect(abortedResult.status).toBe("aborted");
    expect(session.hasQueuedMessages()).toBe(false);
    expect(secondTurnInvoked).toBe(false);
  });
});

describe("Nested tool execution via ctx.executeTool()", () => {
  it("runs nested tools (including hidden tools) through validation and tool_call/tool_result hooks with parentToolCallId", async () => {
    const { faux, models } = createFauxModels();
    const store = new InMemorySessionStore();

    const hookLog: Array<{
      hook: "tool_call" | "tool_result";
      toolName: string;
      parentToolCallId?: string;
    }> = [];

    const extension: ExtensionFactory = (pi) => {
      // Internal helper tool hidden from the model via setActiveTools.
      pi.registerTool(
        defineTool({
          name: "secret_lookup",
          description: "Internal lookup tool",
          parameters: obj({ key: str() }),
          execute: async (_id, params) => ({
            content: [{ type: "text", text: `raw:${params.key}:TOP_SECRET` }],
            details: { key: params.key },
          }),
        }),
      );

      // Composite tool exposed to the model that calls secret_lookup via ctx.executeTool().
      pi.registerTool(
        defineTool({
          name: "composite_fetch",
          description: "Fetches via nested tool",
          parameters: obj({ key: str() }),
          execute: async (_id, params, _signal, _onUpdate, ctx) => {
            const nested = await ctx.executeTool("secret_lookup", { key: params.key });
            return {
              content: [
                {
                  type: "text",
                  text: `nested(isError=${nested.isError}):${contentText(nested.result.content)}`,
                },
              ],
              details: { nestedError: nested.isError },
            };
          },
        }),
      );

      // Expose ONLY composite_fetch to the LLM; secret_lookup remains hidden from model tool list.
      pi.setActiveTools(["composite_fetch"]);

      pi.on("tool_call", (event) => {
        hookLog.push({
          hook: "tool_call",
          toolName: event.toolName,
          ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
        });
        if (event.toolName === "secret_lookup" && event.input.key === "forbidden") {
          return { block: true, reason: "Key is forbidden by policy" };
        }
        return undefined;
      });

      pi.on("tool_result", (event) => {
        hookLog.push({
          hook: "tool_result",
          toolName: event.toolName,
          ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
        });
        if (event.toolName === "secret_lookup" && !event.isError) {
          return {
            content: [{ type: "text", text: contentText(event.content).replace("TOP_SECRET", "[REDACTED]") }],
          };
        }
        return undefined;
      });
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("composite_fetch", { key: "alpha" }, { id: "parent-tc-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("composite_fetch", { key: "forbidden" }, { id: "parent-tc-2" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done."),
    ]);

    const session = await createSession({
      sessionId: "sess-nested-tool",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [extension],
    });

    expect(session.getActiveTools()).toEqual(["composite_fetch"]);

    const result = await session.prompt("Fetch alpha then forbidden");
    expect(result.status).toBe("idle");

    const toolResults = result.snapshot.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(2);
    // First nested call succeeded and was redacted by tool_result hook.
    expect(contentText(toolResults[0]!.content)).toBe("nested(isError=false):raw:alpha:[REDACTED]");
    // Second nested call was blocked by tool_call hook.
    expect(contentText(toolResults[1]!.content)).toContain("nested(isError=true):Key is forbidden by policy");

    // Verify hook trace includes parentToolCallId for nested calls and omits it for top-level calls.
    expect(hookLog).toEqual([
      { hook: "tool_call", toolName: "composite_fetch" },
      { hook: "tool_call", toolName: "secret_lookup", parentToolCallId: "parent-tc-1" },
      { hook: "tool_result", toolName: "secret_lookup", parentToolCallId: "parent-tc-1" },
      { hook: "tool_result", toolName: "composite_fetch" },
      { hook: "tool_call", toolName: "composite_fetch" },
      { hook: "tool_call", toolName: "secret_lookup", parentToolCallId: "parent-tc-2" },
      { hook: "tool_result", toolName: "composite_fetch" },
    ]);
  });
});
