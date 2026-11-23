import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  HarnessError,
  InMemorySessionStore,
  SESSION_SNAPSHOT_VERSION,
  createSession,
  openSession,
  type SessionSnapshot,
  type SessionStore,
} from "../src/index.js";

function createTestEnv(options: { tokensPerSecond?: number } = {}) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1" }, { id: "faux-2" }],
    ...(options.tokensPerSecond !== undefined ? { tokensPerSecond: options.tokensPerSecond } : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new InMemorySessionStore();
  return { faux, models, store };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function expectHarnessError(
  promise: Promise<unknown>,
  code: HarnessError["code"],
): Promise<HarnessError> {
  try {
    await promise;
    throw new Error(`Expected HarnessError(${code}) but promise resolved.`);
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).code).toBe(code);
    return error as HarnessError;
  }
}

describe("HarnessSession", () => {
  describe("creation, opening, and model resolution", () => {
    it("throws MODEL_NOT_FOUND without fallback when model is unavailable on create or open", async () => {
      const { models, store } = createTestEnv();

      await expectHarnessError(
        createSession({
          models,
          store,
          model: { provider: "faux", modelId: "does-not-exist" },
        }),
        "MODEL_NOT_FOUND",
      );

      await store.save("s-missing-model", {
        version: SESSION_SNAPSHOT_VERSION,
        sessionId: "s-missing-model",
        model: { provider: "unknown-provider", modelId: "m-1" },
        messages: [],
        status: "idle",
        updatedAt: 1000,
      });

      await expectHarnessError(
        openSession({ sessionId: "s-missing-model", models, store }),
        "MODEL_NOT_FOUND",
      );
    });

    it("rejects duplicate create, missing open, unsupported version, and invalid maxTurns", async () => {
      const { models, store } = createTestEnv();

      await expectHarnessError(
        createSession({ models, store, model: { provider: "faux", modelId: "faux-1" }, maxTurns: 0 }),
        "INVALID_OPTIONS",
      );

      await createSession({
        sessionId: "s-1",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
      });

      await expectHarnessError(
        createSession({
          sessionId: "s-1",
          models,
          store,
          model: { provider: "faux", modelId: "faux-1" },
        }),
        "SESSION_EXISTS",
      );

      await expectHarnessError(
        openSession({ sessionId: "missing", models, store }),
        "SESSION_NOT_FOUND",
      );

      await store.save("bad-version", {
        version: 999 as 1,
        sessionId: "bad-version",
        model: { provider: "faux", modelId: "faux-1" },
        messages: [],
        status: "idle",
        updatedAt: 1000,
      });

      await expectHarnessError(
        openSession({ sessionId: "bad-version", models, store }),
        "UNSUPPORTED_SNAPSHOT_VERSION",
      );
    });
  });

  describe("streaming, tool calls, sessionId, and identity", () => {
    it("streams text, executes host-injected tool, forwards sessionId & null attribution, and persists history", async () => {
      const { faux, models, store } = createTestEnv();
      const observedRequests: Array<{ sessionId?: string; attribution: unknown }> = [];
      const toolCalls: string[] = [];

      const lookupParams = obj({ key: str({ description: "Key to look up" }) });
      const lookupTool: AgentTool<typeof lookupParams> = {
        name: "lookup",
        label: "Lookup",
        description: "Read-only key lookup",
        parameters: lookupParams,
        execute: async (_id, params) => {
          toolCalls.push(params.key);
          return {
            content: [{ type: "text", text: `value:${params.key}` }],
            details: { found: true },
          };
        },
      };

      faux.setResponses([
        (_context, options) => {
          observedRequests.push({
            sessionId: options?.sessionId,
            attribution: options?.identity?.attribution,
          });
          return fauxAssistantMessage(fauxToolCall("lookup", { key: "alpha" }, { id: "tc-1" }), {
            stopReason: "toolUse",
          });
        },
        (_context, options) => {
          observedRequests.push({
            sessionId: options?.sessionId,
            attribution: options?.identity?.attribution,
          });
          return fauxAssistantMessage("The value for alpha is value:alpha.");
        },
      ]);

      const session = await createSession({
        sessionId: "sess-stream",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
        systemPrompt: "You are concise.",
        tools: [lookupTool],
      });

      let streamedText = "";
      const eventTypes: AgentEvent["type"][] = [];
      session.subscribe((event) => {
        eventTypes.push(event.type);
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          streamedText += event.assistantMessageEvent.delta;
        }
      });

      const result = await session.prompt("Look up alpha");

      expect(result.status).toBe("idle");
      expect(result.lastError).toBeUndefined();
      expect(streamedText).toBe("The value for alpha is value:alpha.");
      expect(toolCalls).toEqual(["alpha"]);
      expect(eventTypes).toContain("tool_execution_start");
      expect(eventTypes).toContain("tool_execution_end");
      expect(observedRequests).toEqual([
        { sessionId: "sess-stream", attribution: null },
        { sessionId: "sess-stream", attribution: null },
      ]);

      const persisted = await store.load("sess-stream");
      expect(persisted?.status).toBe("idle");
      expect(persisted?.messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
    });

    it("forwards custom host identity when explicitly configured", async () => {
      const { faux, models, store } = createTestEnv();
      let seenAttribution: unknown;

      faux.setResponses([
        (_context, options) => {
          seenAttribution = options?.identity?.attribution;
          return fauxAssistantMessage("ok");
        },
      ]);

      const session = await createSession({
        sessionId: "sess-id",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
        identity: { attribution: { name: "my-host", url: "https://my-host.example" } },
      });

      await session.prompt("hello");
      expect(seenAttribution).toEqual({ name: "my-host", url: "https://my-host.example" });
    });
  });

  describe("reentrancy, cancellation, errors, and maxTurns", () => {
    it("rejects concurrent prompt() while a run is active", async () => {
      const { faux, models, store } = createTestEnv();
      const gate = createDeferred();

      faux.setResponses([
        async () => {
          await gate.promise;
          return fauxAssistantMessage("done");
        },
      ]);

      const session = await createSession({
        sessionId: "sess-busy",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
      });

      const firstRun = session.prompt("first");
      expect(session.isRunning).toBe(true);

      await expectHarnessError(session.prompt("second"), "SESSION_BUSY");

      gate.resolve();
      const res = await firstRun;
      expect(res.status).toBe("idle");
      expect(session.isRunning).toBe(false);
    });

    it("aborts an in-flight stream, drops empty aborted bubbles, and commits aborted status", async () => {
      const { faux, models, store } = createTestEnv({ tokensPerSecond: 10 });
      const requestStarted = createDeferred();

      faux.setResponses([
        async (_context, options) => {
          requestStarted.resolve();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) {
              resolve();
              return;
            }
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "Request was aborted" });
        },
      ]);

      const session = await createSession({
        sessionId: "sess-abort-empty",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
      });

      const runPromise = session.prompt("wait forever");
      await requestStarted.promise;
      await session.abort();

      const result = await runPromise;
      expect(result.status).toBe("aborted");
      expect(result.snapshot.status).toBe("aborted");
      // Empty aborted assistant bubble is stripped; only the user message remains.
      expect(result.snapshot.messages.map((m) => m.role)).toEqual(["user"]);
      expect(await store.load("sess-abort-empty")).toEqual(result.snapshot);
    });

    it("preserves non-empty partial assistant text on abort while still allowing continue()", async () => {
      const { faux, models, store } = createTestEnv({ tokensPerSecond: 50 });

      faux.setResponses([
        fauxAssistantMessage([fauxText("Partial answer before stop with enough words to stream slowly.")]),
        fauxAssistantMessage("Full recovered answer"),
      ]);

      const session = await createSession({
        sessionId: "sess-abort-partial",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
      });

      let abortTriggered = false;
      session.subscribe((event) => {
        if (
          !abortTriggered &&
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta" &&
          event.assistantMessageEvent.delta.trim().length > 0
        ) {
          abortTriggered = true;
          void session.abort();
        }
      });

      const aborted = await session.prompt("explain");

      expect(abortTriggered).toBe(true);
      expect(aborted.status).toBe("aborted");
      expect(aborted.snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      const retried = await session.continue();
      expect(retried.status).toBe("idle");
      expect(retried.snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      const finalMsg = retried.snapshot.messages[1];
      expect(finalMsg?.role === "assistant" && finalMsg.content[0]?.type === "text" && finalMsg.content[0].text).toBe(
        "Full recovered answer",
      );
    });

    it("aborts cleanly during tool execution", async () => {
      const { faux, models, store } = createTestEnv();
      const toolStarted = createDeferred();

      const slowTool: AgentTool = {
        name: "slow_lookup",
        label: "Slow Lookup",
        description: "Waits until aborted",
        parameters: obj({}),
        execute: async (_id, _params, signal) => {
          toolStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return { content: [{ type: "text", text: "unreachable" }], details: {} };
        },
      };

      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("slow_lookup", {}, { id: "tc-slow" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("should not complete"),
      ]);

      const session = await createSession({
        sessionId: "sess-abort-tool",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
        tools: [slowTool],
      });

      const runPromise = session.prompt("run slow tool");
      await toolStarted.promise;
      await session.abort();

      const result = await runPromise;
      expect(result.status).toBe("aborted");
      expect((await store.load("sess-abort-tool"))?.status).toBe("aborted");
    });

    it("handles abort requested during pre-run save without calling the model", async () => {
      const { faux, models } = createTestEnv();
      const innerStore = new InMemorySessionStore();
      const saveGate = createDeferred();
      const saveEntered = createDeferred();
      let saveCalls = 0;

      const gatedStore: SessionStore = {
        load: (id) => innerStore.load(id),
        save: async (id, snapshot) => {
          saveCalls += 1;
          if (saveCalls === 2) {
            saveEntered.resolve();
            await saveGate.promise;
          }
          await innerStore.save(id, snapshot);
        },
      };

      faux.setResponses([fauxAssistantMessage("should never run")]);

      const session = await createSession({
        sessionId: "sess-abort-early",
        models,
        store: gatedStore,
        model: { provider: "faux", modelId: "faux-1" },
      });

      const runPromise = session.prompt("hello");
      await saveEntered.promise;
      const abortPromise = session.abort();
      saveGate.resolve();

      const [result] = await Promise.all([runPromise, abortPromise]);
      expect(result.status).toBe("aborted");
      expect(faux.state.callCount).toBe(0);
      expect((await innerStore.load("sess-abort-early"))?.status).toBe("aborted");
    });

    it("detects model stopReason='error' even though pi-agent-core resolves prompt()", async () => {
      const { faux, models, store } = createTestEnv();
      faux.setResponses([
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "upstream 503" }),
        fauxAssistantMessage("recovered"),
      ]);

      const session = await createSession({
        sessionId: "sess-error",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
      });

      const failed = await session.prompt("ping");
      expect(failed.status).toBe("error");
      expect(failed.lastError).toBe("upstream 503");
      expect((await store.load("sess-error"))?.status).toBe("error");
      expect((await store.load("sess-error"))?.lastError).toBe("upstream 503");

      // A subsequent prompt still succeeds because pi-ai skips historical error assistant messages.
      const next = await session.prompt("try again");
      expect(next.status).toBe("idle");
      expect(next.lastError).toBeUndefined();
    });

    it("enforces maxTurns for tool loops without cutting off a final text answer", async () => {
      const { faux, models, store } = createTestEnv();
      const pingTool: AgentTool = {
        name: "ping",
        label: "Ping",
        description: "Returns pong",
        parameters: obj({}),
        execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
      };

      // Case 1: loops past maxTurns=2 -> stops after 2 tool rounds with status="error".
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ping", {}, { id: "t1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("ping", {}, { id: "t2" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("should not be reached"),
      ]);

      const loopSession = await createSession({
        sessionId: "sess-max-turns",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
        tools: [pingTool],
        maxTurns: 2,
      });

      const limited = await loopSession.prompt("loop");
      expect(limited.status).toBe("error");
      expect(limited.lastError).toContain("maxTurns");
      expect(faux.state.callCount).toBe(2);

      // Case 2: turn 1 calls a tool, turn 2 returns a final answer -> succeeds under maxTurns=2.
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ping", {}, { id: "t3" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("all done"),
      ]);

      const normalSession = await createSession({
        sessionId: "sess-within-turns",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
        tools: [pingTool],
        maxTurns: 2,
      });

      const ok = await normalSession.prompt("one tool then answer");
      expect(ok.status).toBe("idle");
      expect(ok.lastError).toBeUndefined();
    });
  });

  describe("persistence failures, crash recovery, and systemPrompt updates", () => {
    it("does not invoke the model if pre-run save fails", async () => {
      const { faux, models } = createTestEnv();
      const innerStore = new InMemorySessionStore();
      let failNextSave = false;

      const flakyStore: SessionStore = {
        load: (id) => innerStore.load(id),
        save: async (id, snapshot) => {
          if (failNextSave) {
            failNextSave = false;
            throw new Error("disk full on pre-run save");
          }
          await innerStore.save(id, snapshot);
        },
      };

      faux.setResponses([fauxAssistantMessage("never called")]);

      const session = await createSession({
        sessionId: "sess-prerun-fail",
        models,
        store: flakyStore,
        model: { provider: "faux", modelId: "faux-1" },
      });

      failNextSave = true;
      await expect(session.prompt("hello")).rejects.toThrow("disk full on pre-run save");

      expect(faux.state.callCount).toBe(0);
      expect(session.getSnapshot().status).toBe("idle");
      expect(session.getSnapshot().messages).toEqual([]);
    });

    it("rolls back memory, invalidates the handle on final save failure, and recovers on reopen", async () => {
      const { faux, models } = createTestEnv();
      const innerStore = new InMemorySessionStore();
      let failSaveCount = 0;

      const flakyStore: SessionStore = {
        load: (id) => innerStore.load(id),
        save: async (id, snapshot) => {
          failSaveCount += 1;
          // 1 = create, 2 = pre-run running, 3 = final commit (fail!)
          if (failSaveCount === 3) {
            throw new Error("disk full on final save");
          }
          await innerStore.save(id, snapshot);
        },
      };

      faux.setResponses([
        fauxAssistantMessage("ephemeral answer that failed to persist"),
        fauxAssistantMessage("persisted after reopen"),
      ]);

      const session = await createSession({
        sessionId: "sess-final-fail",
        models,
        store: flakyStore,
        model: { provider: "faux", modelId: "faux-1" },
      });

      await expect(session.prompt("hello")).rejects.toThrow("disk full on final save");

      // Memory rolled back to match what was actually persisted (running + user message only).
      const inMemory = session.getSnapshot();
      const persisted = await innerStore.load("sess-final-fail");
      expect(inMemory).toEqual(persisted);
      expect(inMemory.status).toBe("running");
      expect(inMemory.messages.map((m) => m.role)).toEqual(["user"]);

      // Further calls on the invalidated handle are rejected until reopened.
      await expectHarnessError(session.prompt("again"), "SESSION_INVALIDATED");

      // Reopening transitions running -> interrupted without auto-replaying.
      const reopened = await openSession({
        sessionId: "sess-final-fail",
        models,
        store: flakyStore,
      });
      expect(reopened.getSnapshot().status).toBe("interrupted");
      expect(faux.state.callCount).toBe(1);

      // Explicit continue retries the unanswered user input.
      const continued = await reopened.continue();
      expect(continued.status).toBe("idle");
      expect(faux.state.callCount).toBe(2);
    });

    it("marks a crashed running snapshot as interrupted on reopen without auto-running, and supports continue()", async () => {
      const { faux, models, store } = createTestEnv();
      const crashedSnapshot: SessionSnapshot = {
        version: SESSION_SNAPSHOT_VERSION,
        sessionId: "sess-crashed",
        model: { provider: "faux", modelId: "faux-1" },
        status: "running",
        updatedAt: 1000,
        messages: [
          {
            role: "system",
            content: "",
            sections: { system: "Be helpful." },
            timestamp: 999,
          },
          {
            role: "user",
            content: [{ type: "text", text: "Unanswered before crash" }],
            timestamp: 1000,
          },
        ],
      };
      await store.save(crashedSnapshot.sessionId, crashedSnapshot);

      faux.setResponses([fauxAssistantMessage("Answer after manual continue")]);

      const reopened = await openSession({
        sessionId: "sess-crashed",
        models,
        store,
      });

      expect(faux.state.callCount).toBe(0);
      expect(reopened.getSnapshot().status).toBe("interrupted");
      expect((await store.load("sess-crashed"))?.status).toBe("interrupted");

      const res = await reopened.continue();
      expect(res.status).toBe("idle");
      expect(faux.state.callCount).toBe(1);

      // Once answered, continue() rejects with NOTHING_TO_CONTINUE.
      await expectHarnessError(reopened.continue(), "NOTHING_TO_CONTINUE");
    });

    it("preserves prompt cache when systemPrompt is unchanged on reopen, and patches it when changed", async () => {
      const { faux, models, store } = createTestEnv();
      const seenSystemPrompts: string[] = [];

      faux.setResponses([
        (context) => {
          seenSystemPrompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("turn 1");
        },
        (context) => {
          seenSystemPrompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("turn 2");
        },
        (context) => {
          seenSystemPrompts.push(getCurrentSystemPrompt(context.messages));
          return fauxAssistantMessage("turn 3");
        },
      ]);

      const s1 = await createSession({
        sessionId: "sess-sys",
        models,
        store,
        model: { provider: "faux", modelId: "faux-1" },
        systemPrompt: "Prompt v1",
      });
      await s1.prompt("one");

      // Reopen with the exact same prompt -> no extra system message appended.
      const s2 = await openSession({
        sessionId: "sess-sys",
        models,
        store,
        systemPrompt: "Prompt v1",
      });
      const r2 = await s2.prompt("two");
      expect(r2.snapshot.messages.filter((m) => m.role === "system")).toHaveLength(1);

      // Reopen with a changed prompt -> appends a system patch and replaces effective prompt.
      const s3 = await openSession({
        sessionId: "sess-sys",
        models,
        store,
        systemPrompt: "Prompt v2",
      });
      expect(s3.systemPrompt).toBe("Prompt v2");
      const r3 = await s3.prompt("three");
      expect(r3.snapshot.messages.filter((m) => m.role === "system")).toHaveLength(2);

      expect(seenSystemPrompts).toEqual(["Prompt v1", "Prompt v1", "Prompt v2"]);
    });
  });
});
