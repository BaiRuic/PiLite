import { createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  type CompactionResult,
  type ContextUsage,
  createSession,
  defineTool,
  type ExtensionContext,
  type ExtensionDiagnostic,
  type ExtensionExecOptions,
  type ExtensionFactory,
  ExtensionRunner,
  type ExtensionToolInfo,
  estimateContextUsageTokens,
  InMemorySessionStore,
  openSession,
  type SessionStore,
  type SessionUsageEvent,
} from "../src/index.js";

function createTestEnv() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new InMemorySessionStore();
  return { faux, models, store };
}

describe("Headless Extension System", () => {
  it("registers extension tools with ExtensionContext and supports dynamic active tool toggling", async () => {
    const { faux, models, store } = createTestEnv();
    const seenSessionIds: string[] = [];

    const noteTool = defineTool({
      name: "read_note",
      description: "Read a note",
      parameters: obj({ id: str() }),
      execute: async (_callId, params, _signal, _onUpdate, ctx) => {
        seenSessionIds.push(ctx.sessionId);
        return {
          content: [{ type: "text", text: `note:${params.id}` }],
          details: { id: params.id },
        };
      },
    });

    const extraTool = defineTool({
      name: "extra_tool",
      description: "Extra tool",
      parameters: obj({}),
      execute: async () => ({ content: [{ type: "text", text: "extra" }], details: {} }),
    });

    let toggleActive!: (names: string[]) => void;
    const ext: ExtensionFactory = (pi) => {
      pi.registerTool(noteTool);
      pi.registerTool(extraTool);
      toggleActive = (names) => pi.setActiveTools(names);
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_note", { id: "42" }, { id: "tc-ext-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Got note 42."),
    ]);

    const session = await createSession({
      sessionId: "sess-ext-tools",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [ext],
    });

    expect(session.getActiveTools()).toEqual(["read_note", "extra_tool"]);
    const res = await session.prompt("Read note 42");
    expect(res.status).toBe("idle");
    expect(seenSessionIds).toEqual(["sess-ext-tools"]);

    toggleActive(["read_note"]);
    expect(session.getActiveTools()).toEqual(["read_note"]);
  });

  it("supports tool_call blocking (including terminate) and tool_result redaction", async () => {
    const { faux, models, store } = createTestEnv();
    let executedBlockedTool = false;

    const secretTool = defineTool({
      name: "read_secret",
      description: "Returns sensitive text",
      parameters: obj({}),
      execute: async () => ({
        content: [{ type: "text", text: "SECRET=token-123" }],
        details: { raw: true },
      }),
    });

    const dangerousTool = defineTool({
      name: "drop_db",
      description: "Dangerous operation",
      parameters: obj({}),
      execute: async () => {
        executedBlockedTool = true;
        return { content: [{ type: "text", text: "dropped" }], details: {} };
      },
    });

    const guardExt: ExtensionFactory = (pi) => {
      pi.registerTool(secretTool);
      pi.registerTool(dangerousTool);

      pi.on("tool_call", (event) => {
        if (event.toolName === "drop_db") {
          return { block: true, reason: "drop_db is forbidden", terminate: true };
        }
        return undefined;
      });

      pi.on("tool_result", (event) => {
        if (event.toolName === "read_secret") {
          return {
            content: [{ type: "text", text: "[REDACTED]" }],
            details: { redacted: true },
          };
        }
        return undefined;
      });
    };

    let toolResultSeenByModel = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_secret", {}, { id: "tc-sec" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        const last = context.messages[context.messages.length - 1];
        if (last?.role === "toolResult" && last.content[0]?.type === "text") {
          toolResultSeenByModel = last.content[0].text;
        }
        return fauxAssistantMessage("Redacted output handled.");
      },
      // Second run: blocked with terminate=true so model is NOT called again after block.
      fauxAssistantMessage(fauxToolCall("drop_db", {}, { id: "tc-drop" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("should not be reached because terminate=true"),
    ]);

    const session = await createSession({
      sessionId: "sess-guard",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [guardExt],
    });

    const r1 = await session.prompt("Read secret");
    expect(r1.status).toBe("idle");
    expect(toolResultSeenByModel).toBe("[REDACTED]");

    const r2 = await session.prompt("Drop the database");
    expect(r2.status).toBe("idle");
    expect(executedBlockedTool).toBe(false);
    expect(faux.state.callCount).toBe(3);
  });

  it("supports before_agent_start per-run systemPrompt override and context filtering", async () => {
    const { faux, models, store } = createTestEnv();
    const seenPrompts: string[] = [];
    const seenMessageCounts: number[] = [];

    let overrideNextRun = true;
    const promptExt: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => {
        if (overrideNextRun) {
          return { systemPrompt: `${event.systemPrompt}\nEXTRA RULE` };
        }
        return undefined;
      });

      pi.on("context", (event) => ({
        // Keep system messages plus only the latest 2 conversation messages.
        messages: [
          ...event.messages.filter((m) => m.role === "system"),
          ...event.messages.filter((m) => m.role !== "system").slice(-2),
        ],
      }));
    };

    faux.setResponses([
      (context) => {
        seenPrompts.push(getCurrentSystemPrompt(context.messages));
        seenMessageCounts.push(context.messages.filter((m) => m.role !== "system").length);
        return fauxAssistantMessage("reply 1");
      },
      (context) => {
        seenPrompts.push(getCurrentSystemPrompt(context.messages));
        seenMessageCounts.push(context.messages.filter((m) => m.role !== "system").length);
        return fauxAssistantMessage("reply 2");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-ctx",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "BASE PROMPT",
      extensions: [promptExt],
    });

    await session.prompt("first");
    overrideNextRun = false;
    await session.prompt("second");

    expect(seenPrompts).toEqual(["BASE PROMPT\nEXTRA RULE", "BASE PROMPT"]);
    expect(seenMessageCounts).toEqual([1, 2]);
  });

  it("persists appendEntry customEntries across reopen and rolls back on final save failure", async () => {
    const { faux, models } = createTestEnv();
    const innerStore = new InMemorySessionStore();
    let failNextSave = false;

    const flakyStore: SessionStore = {
      load: (id) => innerStore.load(id),
      save: async (id, snapshot) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("save failed");
        }
        await innerStore.save(id, snapshot);
      },
      delete: (id) => innerStore.delete(id),
      list: () => innerStore.list(),
    };

    const lifecycle: string[] = [];
    const stateExt: ExtensionFactory = (pi) => {
      pi.on("session_start", (event) => {
        lifecycle.push(`start:${event.reason}`);
        if (event.reason === "create") {
          pi.appendEntry("audit.init", { initialized: true });
        }
      });
      pi.on("turn_end", () => {
        pi.appendEntry("audit.turn", { ok: true });
      });
      pi.on("session_shutdown", () => {
        lifecycle.push("shutdown");
      });
    };

    faux.setResponses([fauxAssistantMessage("ok 1"), fauxAssistantMessage("ok 2 (will fail final save)")]);

    const s1 = await createSession({
      sessionId: "sess-entries",
      models,
      store: flakyStore,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [stateExt],
    });

    expect(s1.getSnapshot().customEntries?.map((e) => e.customType)).toEqual(["audit.init"]);
    await s1.prompt("turn 1");
    expect(s1.getSnapshot().customEntries?.map((e) => e.customType)).toEqual(["audit.init", "audit.turn"]);
    await s1.close();
    await s1.close(); // idempotent

    // Reopen and verify persisted customEntries + rollback on final save failure.
    const s2 = await openSession({
      sessionId: "sess-entries",
      models,
      store: flakyStore,
      extensions: [stateExt],
    });
    expect(s2.getSnapshot().customEntries?.map((e) => e.customType)).toEqual(["audit.init", "audit.turn"]);

    // Fail the final commit (pre-run save succeeds, final save fails).
    let saves = 0;
    const origSave = flakyStore.save;
    const patchedStore: SessionStore = {
      load: (id) => flakyStore.load(id),
      save: async (id, snapshot) => {
        saves += 1;
        if (saves === 2) throw new Error("final save boom");
        await origSave(id, snapshot);
      },
      delete: (id) => flakyStore.delete(id),
      list: () => flakyStore.list(),
    };
    const s3 = await openSession({
      sessionId: "sess-entries",
      models,
      store: patchedStore,
      extensions: [stateExt],
    });

    await expect(s3.prompt("turn 2")).rejects.toThrow("final save boom");
    // The `audit.turn` appended during the failed run was rolled back to match disk.
    expect(s3.getSnapshot().customEntries?.map((e) => e.customType)).toEqual(["audit.init", "audit.turn"]);
    expect(lifecycle).toEqual(["start:create", "shutdown", "start:open", "start:open"]);
  });

  it("wires optional ui and exec host adapters, event bus, and isolates deferred/throwing handlers", async () => {
    const { faux, models, store } = createTestEnv();
    const diagnostics: ExtensionDiagnostic[] = [];
    const busMessages: unknown[] = [];
    const notifications: string[] = [];

    const bridgeExt: ExtensionFactory = (pi) => {
      pi.events.on("ping", (data) => busMessages.push(data));

      // Deferred/unsupported event does not crash registration.
      pi.on("session_tree", () => undefined);

      // Throwing notification handler is isolated and reported.
      pi.on("agent_start", () => {
        throw new Error("non-fatal observer error");
      });

      pi.registerTool(
        defineTool({
          name: "check_host",
          description: "Exercises ui, exec, and event bus",
          parameters: obj({}),
          execute: async (_id, _params, _signal, _onUpdate, ctx) => {
            const approved = await ctx.ui.confirm("Approve", "Run check?");
            ctx.ui.notify(`approved=${approved}`, "info");
            pi.events.emit("ping", { approved });
            const execResult = await pi.exec("echo", ["hello"], { timeout: 5_000 });
            return {
              content: [
                {
                  type: "text",
                  text: `approved:${approved};out:${execResult.stdout};code:${execResult.code};killed:${String(execResult.killed)}`,
                },
              ],
              details: {},
            };
          },
        }),
      );
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("check_host", {}, { id: "tc-host" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Host check passed."),
    ]);

    let seenExecOptions: ExtensionExecOptions | undefined;
    const session = await createSession({
      sessionId: "sess-bridges",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [{ name: "bridge-ext", factory: bridgeExt }],
      ui: {
        confirm: async () => true,
        notify: (msg) => notifications.push(msg),
      },
      exec: async (cmd, args, opts) => {
        seenExecOptions = opts;
        return {
          stdout: `${cmd}:${args.join(" ")}`,
          stderr: "",
          code: 0,
          killed: false,
          truncated: false,
        };
      },
      onExtensionDiagnostic: (d) => diagnostics.push(d),
    });

    const result = await session.prompt("Check host");
    expect(result.status).toBe("idle");
    expect(seenExecOptions?.timeout).toBe(5_000);
    expect(busMessages).toEqual([{ approved: true }]);
    expect(notifications).toEqual(["approved=true"]);
    expect(diagnostics.some((d) => d.kind === "deferred_event" && d.event === "session_tree")).toBe(true);
    expect(diagnostics.some((d) => d.kind === "handler_error" && d.event === "agent_start")).toBe(true);
  });

  it("returns safe headless defaults when ui/exec adapters are omitted", async () => {
    const { models, store } = createTestEnv();
    let sawHasUI = true;
    let confirmResult = true;
    let execRejected = false;

    const headlessExt: ExtensionFactory = (pi) => {
      pi.on("session_start", async (_event, ctx) => {
        sawHasUI = ctx.hasUI;
        confirmResult = await ctx.ui.confirm("Confirm?", "No UI here");
        try {
          await pi.exec("ls", []);
        } catch {
          execRejected = true;
        }
      });
    };

    await createSession({
      sessionId: "sess-no-ui",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [headlessExt],
    });

    expect(sawHasUI).toBe(false);
    expect(confirmResult).toBe(false);
    expect(execRejected).toBe(true);
  });

  it("exposes ctx.signal, thinkingLevel, hasPendingMessages, getContextUsage, and fire-and-forget compact", async () => {
    const { faux, models, store } = createTestEnv();
    let idleSignal: AbortSignal | undefined;
    let runSignal: AbortSignal | undefined;
    let idleThinkingLevel: string | undefined;
    let idlePending = true;
    let runPendingBefore = true;
    let runPendingAfter = false;
    let idleUsage: ContextUsage | undefined;
    let savedCtx!: ExtensionContext;

    let sessionRef: Awaited<ReturnType<typeof createSession>> | undefined;

    const inspectExt: ExtensionFactory = (pi) => {
      pi.on("session_start", (_event, ctx) => {
        savedCtx = ctx;
        idleSignal = ctx.signal;
        idleThinkingLevel = ctx.thinkingLevel;
        idlePending = ctx.hasPendingMessages();
        idleUsage = ctx.getContextUsage();
      });

      pi.registerTool(
        defineTool({
          name: "probe_ctx",
          description: "Inspects live ExtensionContext during a run",
          parameters: obj({}),
          execute: async (_id, _params, _signal, _onUpdate, ctx) => {
            runSignal = ctx.signal;
            runPendingBefore = ctx.hasPendingMessages();
            sessionRef?.steer("queued steering");
            runPendingAfter = ctx.hasPendingMessages();
            return { content: [{ type: "text", text: "probed" }], details: {} };
          },
        }),
      );
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_ctx", {}, { id: "tc-probe" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("First turn done with extra text to grow context."),
      fauxAssistantMessage("Second turn response to enable compaction."),
    ]);

    const session = await createSession({
      sessionId: "sess-ctx-helpers",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "low",
      compaction: {
        contextWindow: 1000,
        keepRecentTokens: 1,
        summarizer: async ({ customInstructions }) => ({
          summary: `Compact summary (${customInstructions ?? "none"})`,
        }),
      },
      extensions: [inspectExt],
    });
    sessionRef = session;

    expect(idleSignal).toBeUndefined();
    expect(idleThinkingLevel).toBe("low");
    expect(idlePending).toBe(false);
    expect(idleUsage).toBeDefined();
    expect(idleUsage?.contextWindow).toBe(1000);
    expect(idleUsage?.tokens).toBeGreaterThanOrEqual(0);
    expect(idleUsage?.percent).toBe(((idleUsage?.tokens ?? 0) / 1000) * 100);

    await session.prompt("Run probe tool");
    expect(runSignal).toBeInstanceOf(AbortSignal);
    expect(runPendingBefore).toBe(false);
    expect(runPendingAfter).toBe(true);

    // After run completes, ctx.signal returns to undefined and ctx.compact() succeeds.
    expect(savedCtx.signal).toBeUndefined();
    await session.prompt("More conversation context for compaction.");

    const compactResult = await new Promise<CompactionResult>((resolve, reject) => {
      savedCtx.compact({
        customInstructions: "keep decisions",
        onComplete: resolve,
        onError: reject,
      });
    });
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.summary).toBe("Compact summary (keep decisions)");
    // Immediately after compaction (before any new assistant usage), getContextUsage returns null tokens/percent.
    expect(savedCtx.getContextUsage()).toEqual({ tokens: null, contextWindow: 1000, percent: null });
  });

  it("supports tool_result structuredContent and usage overrides across main and nested tool calls", async () => {
    const { faux, models, store } = createTestEnv();
    const seenToolResults: Array<{ structuredContent?: unknown; usageTokens?: number }> = [];
    const usageEvents: SessionUsageEvent[] = [];
    let nestedStructuredContent: unknown;
    let nestedUsageTokens: number | undefined;

    const toolUsage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };

    const overrideExt: ExtensionFactory = (pi) => {
      pi.registerTool(
        defineTool({
          name: "inner_tool",
          description: "Returns structured content and usage",
          parameters: obj({}),
          execute: async () => ({
            content: [{ type: "text", text: "inner" }],
            details: { raw: true },
            structuredContent: { stage: "raw" },
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
        }),
      );

      pi.registerTool(
        defineTool({
          name: "outer_tool",
          description: "Calls inner_tool via ctx.executeTool",
          parameters: obj({}),
          execute: async (_id, _params, _signal, _onUpdate, ctx) => {
            const nested = await ctx.executeTool("inner_tool", {});
            nestedStructuredContent = nested.result.structuredContent;
            nestedUsageTokens = nested.result.usage?.totalTokens;
            return {
              content: [{ type: "text", text: "outer" }],
              details: {},
              structuredContent: { from: "outer" },
            };
          },
        }),
      );

      pi.on("tool_result", (event) => {
        seenToolResults.push({
          structuredContent: event.structuredContent,
          usageTokens: event.usage?.totalTokens,
        });
        if (event.toolName === "inner_tool") {
          return {
            structuredContent: { stage: "overridden" },
            usage: toolUsage,
          };
        }
        if (event.toolName === "outer_tool") {
          return {
            usage: toolUsage,
          };
        }
        return undefined;
      });
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("outer_tool", {}, { id: "tc-outer" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);

    const session = await createSession({
      sessionId: "sess-tool-result-fields",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [overrideExt],
      onUsage: (event) => usageEvents.push(event),
    });

    let outerExecutionStructuredContent: unknown;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "outer_tool") {
        outerExecutionStructuredContent = event.result.structuredContent;
      }
    });

    await session.prompt("Run outer tool");

    expect(seenToolResults).toEqual([
      { structuredContent: { stage: "raw" }, usageTokens: 2 },
      { structuredContent: { from: "outer" }, usageTokens: undefined },
    ]);
    expect(nestedStructuredContent).toEqual({ stage: "overridden" });
    expect(nestedUsageTokens).toBe(15);
    // Updating usage without touching content must preserve original structuredContent.
    expect(outerExecutionStructuredContent).toEqual({ from: "outer" });

    const toolResultMessage = session.getSnapshot().messages.find((message) => message.role === "toolResult");
    expect(toolResultMessage?.role).toBe("toolResult");
    if (toolResultMessage?.role === "toolResult") {
      expect(toolResultMessage.usage?.totalTokens).toBe(15);
    }
    expect(
      usageEvents.some(
        (e) => e.source === "tool" && e.toolName === "outer_tool" && e.usage.totalTokens === 15,
      ),
    ).toBe(true);
    expect(session.getStats().tokens.total).toBeGreaterThanOrEqual(15);
  });

  it("replaces provider request payload directly when before_provider_request returns a non-undefined value", async () => {
    const { models } = createTestEnv();
    const model = models.getModel("faux", "faux-1")!;
    const runner = await ExtensionRunner.load({
      baseTools: [],
      extensions: [
        (pi) => {
          pi.on("before_provider_request", (event) => {
            const payload = event.payload as Record<string, unknown>;
            return { ...payload, temperature: 0.2 };
          });
          // Returning undefined preserves the previous handler's replacement payload.
          pi.on("before_provider_request", () => undefined);
          pi.on("before_provider_request", (event) => {
            const payload = event.payload as Record<string, unknown>;
            return { ...payload, extraHeader: "ok" };
          });
        },
      ],
    });
    runner.bind({
      sessionId: "sess-payload",
      getModel: () => model,
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel: async () => undefined,
      getSessionName: () => undefined,
      setSessionName: async () => undefined,
      sendUserMessage: () => undefined,
      getSystemPrompt: () => "",
      getSnapshot: () => {
        throw new Error("unused");
      },
      getCustomEntries: () => [],
      appendCustomEntry: () => {
        throw new Error("unused");
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSignal: () => undefined,
      abort: () => undefined,
      executeTool: async () => {
        throw new Error("unused");
      },
      onActiveToolsChanged: () => undefined,
    });

    const result = await runner.emitBeforeProviderRequest({ model: "faux-1" }, model);
    expect(result).toEqual({ model: "faux-1", temperature: 0.2, extraHeader: "ok" });
  });

  it("supports pi.getAllTools() ToolInfo[], session name, and thinking level APIs when idle and mid-run", async () => {
    const { faux, models, store } = createTestEnv();
    let toolsFromApi: ExtensionToolInfo[] = [];
    let apiHandle!: {
      getAllTools: () => ExtensionToolInfo[];
      getSessionName: () => string | undefined;
      setSessionName: (name: string | undefined) => Promise<void>;
      getThinkingLevel: () => string;
      setThinkingLevel: (
        level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
      ) => Promise<void>;
    };
    let thinkingSeenInTool: string | undefined;

    const metaExt: ExtensionFactory = (pi) => {
      apiHandle = pi;
      pi.registerTool(
        defineTool({
          name: "meta_tool",
          description: "Updates session name and thinking level mid-run",
          parameters: obj({ topic: str() }),
          execute: async (_id, params, _signal, _onUpdate, ctx) => {
            await pi.setSessionName(`Topic: ${params.topic}`);
            await pi.setThinkingLevel("high");
            thinkingSeenInTool = ctx.thinkingLevel;
            return { content: [{ type: "text", text: "updated" }], details: {} };
          },
        }),
      );
      pi.on("session_start", async (event) => {
        if (event.reason === "create") {
          await pi.setSessionName("Initial Title");
          await pi.setThinkingLevel("low");
        }
        toolsFromApi = pi.getAllTools();
      });
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("meta_tool", { topic: "Extensions" }, { id: "tc-meta" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Metadata updated."),
    ]);

    const session = await createSession({
      sessionId: "sess-ext-meta",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [metaExt],
    });

    expect(toolsFromApi).toHaveLength(1);
    expect(toolsFromApi[0]).toMatchObject({
      name: "meta_tool",
      description: "Updates session name and thinking level mid-run",
    });
    expect(toolsFromApi[0]?.parameters).toBeDefined();
    expect(apiHandle.getSessionName()).toBe("Initial Title");
    expect(session.title).toBe("Initial Title");
    expect(apiHandle.getThinkingLevel()).toBe("low");
    expect(session.thinkingLevel).toBe("low");

    await session.prompt("Set topic to Extensions");
    expect(thinkingSeenInTool).toBe("high");
    expect(apiHandle.getSessionName()).toBe("Topic: Extensions");
    expect(session.title).toBe("Topic: Extensions");
    expect(apiHandle.getThinkingLevel()).toBe("high");
    expect(session.thinkingLevel).toBe("high");

    // Verify mid-run updates were persisted cleanly across reopen.
    const reopened = await openSession({
      sessionId: "sess-ext-meta",
      models,
      store,
      extensions: [metaExt],
    });
    expect(reopened.title).toBe("Topic: Extensions");
    expect(reopened.thinkingLevel).toBe("high");
    expect(apiHandle.getAllTools().map((t) => t.name)).toEqual(["meta_tool"]);
  });

  it("supports before_provider_headers in-place mutation and header deletion", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    faux.models[0].headers = { "x-default": "keep", "x-drop-me": "remove" };
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new InMemorySessionStore();

    let receivedHeaders: Record<string, string | null> | undefined;
    const headerExt: ExtensionFactory = (pi) => {
      pi.on("before_provider_headers", (event) => {
        event.headers["x-trace-id"] = `trace-${event.model.id}`;
      });
      pi.on("before_provider_headers", (event) => {
        if (event.headers["x-trace-id"] === "trace-faux-1") {
          event.headers["x-tenant"] = "acme";
          event.headers["x-drop-me"] = null;
        }
      });
    };

    faux.setResponses([
      (_context, options) => {
        receivedHeaders = options?.headers ? { ...options.headers } : undefined;
        return fauxAssistantMessage("Headers applied.");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-headers",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [headerExt],
    });

    await session.prompt("Ping");
    expect(receivedHeaders).toEqual({
      "x-default": "keep",
      "x-trace-id": "trace-faux-1",
      "x-tenant": "acme",
      "x-drop-me": null,
    });
  });

  it("emits model_select and thinking_level_select only when values actually change", async () => {
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-1" }, { id: "faux-2" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new InMemorySessionStore();

    const modelEvents: Array<{ modelId: string; previousModelId?: string; source: string }> = [];
    const thinkingEvents: Array<{ level: string; previousLevel: string }> = [];

    const observerExt: ExtensionFactory = (pi) => {
      pi.on("model_select", (event) => {
        modelEvents.push({
          modelId: event.model.id,
          previousModelId: event.previousModel?.id,
          source: event.source,
        });
      });
      pi.on("thinking_level_select", (event) => {
        thinkingEvents.push({
          level: event.level,
          previousLevel: event.previousLevel,
        });
      });
      pi.registerTool(
        defineTool({
          name: "bump_thinking",
          description: "Changes thinking level mid-run",
          parameters: obj({}),
          execute: async () => {
            await pi.setThinkingLevel("high");
            // Repeating the same level should not emit a duplicate event.
            await pi.setThinkingLevel("high");
            return { content: [{ type: "text", text: "bumped" }], details: {} };
          },
        }),
      );
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bump_thinking", {}, { id: "tc-bump" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("All set."),
    ]);

    const session = await createSession({
      sessionId: "sess-select-events",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [observerExt],
    });

    // No-op model/thinking changes do not fire events.
    await session.setModel({ provider: "faux", modelId: "faux-1" });
    await session.setThinkingLevel("off");
    expect(modelEvents).toEqual([]);
    expect(thinkingEvents).toEqual([]);

    // Actual changes fire events.
    await session.setModel({ provider: "faux", modelId: "faux-2" });
    await session.setThinkingLevel("medium");
    expect(modelEvents).toEqual([{ modelId: "faux-2", previousModelId: "faux-1", source: "set" }]);
    expect(thinkingEvents).toEqual([{ level: "medium", previousLevel: "off" }]);

    // Mid-run change via pi.setThinkingLevel() also emits thinking_level_select.
    await session.prompt("Bump thinking");
    expect(thinkingEvents).toEqual([
      { level: "medium", previousLevel: "off" },
      { level: "high", previousLevel: "medium" },
    ]);
  });

  it("supports input hook chaining (transform with image preservation and handled short-circuit)", async () => {
    const { faux, models, store } = createTestEnv();
    const handledCommands: string[] = [];
    let modelSeenUserContent: unknown;

    const inputExt: ExtensionFactory = (pi) => {
      pi.on("input", (event) => {
        if (event.text.startsWith("/local")) {
          handledCommands.push(event.text);
          return { action: "handled" };
        }
        if (event.text.includes("@note")) {
          return { action: "transform", text: event.text.replace("@note", "[NOTE:42]") };
        }
        return { action: "continue" };
      });
      pi.on("input", (event) => {
        // Chains after the previous transform while keeping images intact when omitted.
        return { action: "transform", text: `${event.text} [verified]` };
      });
    };

    faux.setResponses([
      (context) => {
        const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
        modelSeenUserContent = lastUser?.content;
        return fauxAssistantMessage("Processed transformed input.");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-input-hook",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [inputExt],
    });

    const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };
    const r1 = await session.prompt("Check @note", [image]);
    expect(r1.status).toBe("idle");
    expect(modelSeenUserContent).toEqual([{ type: "text", text: "Check [NOTE:42] [verified]" }, image]);
    expect(faux.state.callCount).toBe(1);

    const messagesBeforeHandled = session.getSnapshot().messages.length;
    const r2 = await session.prompt("/local status");
    expect(r2.status).toBe("idle");
    expect(handledCommands).toEqual(["/local status"]);
    // Handled input short-circuits without calling the model or mutating transcript.
    expect(faux.state.callCount).toBe(1);
    expect(r2.snapshot.messages.length).toBe(messagesBeforeHandled);
  });

  it("supports pi.sendUserMessage() when idle, mid-run (steer/followUp), and reports diagnostic when deliverAs is omitted mid-run", async () => {
    const { faux, models, store } = createTestEnv();
    const diagnostics: ExtensionDiagnostic[] = [];
    const seenInputMeta: Array<{ text: string; source: string; streamingBehavior?: string }> = [];
    const modelUserPrompts: string[] = [];
    let sendFn!: (
      content:
        | string
        | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
      options?: { deliverAs?: "steer" | "followUp" },
    ) => void;

    const ext: ExtensionFactory = (pi) => {
      sendFn = (content, options) => pi.sendUserMessage(content, options);
      pi.on("input", (event) => {
        seenInputMeta.push({
          text: event.text,
          source: event.source,
          ...(event.streamingBehavior !== undefined ? { streamingBehavior: event.streamingBehavior } : {}),
        });
        return { action: "continue" };
      });
      pi.registerTool(
        defineTool({
          name: "trigger_mid_run",
          description: "Queues a followUp message and tests missing deliverAs error",
          parameters: obj({}),
          execute: async () => {
            // Omitting deliverAs while running must report a diagnostic without throwing.
            pi.sendUserMessage("missing deliverAs");
            // Providing deliverAs queues a followUp turn.
            pi.sendUserMessage("follow up from tool", { deliverAs: "followUp" });
            return { content: [{ type: "text", text: "queued" }], details: {} };
          },
        }),
      );
    };

    faux.setResponses([
      // 1. Triggered by idle pi.sendUserMessage()
      (context) => {
        const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
        modelUserPrompts.push(
          lastUser && Array.isArray(lastUser.content)
            ? lastUser.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("|")
            : "",
        );
        return fauxAssistantMessage("Awake!");
      },
      // 2. Host prompt invokes tool -> queues followUp
      fauxAssistantMessage(fauxToolCall("trigger_mid_run", {}, { id: "tc-send" }), { stopReason: "toolUse" }),
      // 3. Tool result turn finishes -> agent drains followUp
      fauxAssistantMessage("Tool done."),
      // 4. Model responds to queued followUp
      (context) => {
        const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
        modelUserPrompts.push(
          lastUser && Array.isArray(lastUser.content)
            ? lastUser.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("|")
            : "",
        );
        return fauxAssistantMessage("Handled follow-up.");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-send-user-msg",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [{ name: "sender-ext", factory: ext }],
      onExtensionDiagnostic: (d) => diagnostics.push(d),
    });

    // Idle call starts a run asynchronously; waitForIdle() settles once complete.
    sendFn([
      { type: "text", text: "background wake" },
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
    await session.waitForIdle();

    expect(modelUserPrompts[0]).toBe("background wake");
    expect(seenInputMeta[0]).toEqual({ text: "background wake", source: "extension" });

    // Now run a normal prompt whose tool calls pi.sendUserMessage() mid-run.
    const res = await session.prompt("Run tool");
    expect(res.status).toBe("idle");
    expect(modelUserPrompts).toEqual(["background wake", "follow up from tool"]);
    expect(seenInputMeta).toContainEqual({
      text: "follow up from tool",
      source: "extension",
      streamingBehavior: "followUp",
    });
    expect(
      diagnostics.some(
        (d) =>
          d.kind === "handler_error" && d.extensionName === "sender-ext" && d.event === "send_user_message",
      ),
    ).toBe(true);
  });

  it("emits agent_settled and defers pi.sendUserMessage() called inside agent_end and agent_settled", async () => {
    const { faux, models, store } = createTestEnv();
    const settledEvents: Array<{ aborted: boolean; isIdle: boolean }> = [];
    const seenPrompts: string[] = [];
    let sentFromEnd = false;
    let sentFromSettled = false;

    const ext: ExtensionFactory = (pi) => {
      pi.on("agent_end", () => {
        if (!sentFromEnd) {
          sentFromEnd = true;
          pi.sendUserMessage("from-agent-end");
        }
      });
      pi.on("agent_settled", (event, ctx) => {
        settledEvents.push({ aborted: event.aborted, isIdle: ctx.isIdle() });
        if (!sentFromSettled && settledEvents.length === 2) {
          sentFromSettled = true;
          pi.sendUserMessage("from-agent-settled");
        }
      });
    };

    const recordUser =
      (reply: string) => (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
        const last = [...ctx.messages].reverse().find((m) => m.role === "user");
        seenPrompts.push(
          last && Array.isArray(last.content) && last.content[0]?.type === "text" ? last.content[0].text : "",
        );
        return fauxAssistantMessage(reply);
      };

    faux.setResponses([recordUser("reply 1"), recordUser("reply 2"), recordUser("reply 3")]);

    const session = await createSession({
      sessionId: "sess-agent-settled",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [ext],
    });

    const firstResult = await session.prompt("initial");
    // The originating prompt() resolves immediately with Round 1's snapshot without waiting for deferred turns.
    expect(firstResult.status).toBe("idle");
    expect(
      firstResult.snapshot.messages.filter((m) => m.role === "assistant").map((m) => m.content[0]),
    ).toEqual([{ type: "text", text: "reply 1" }]);
    expect(seenPrompts).toEqual(["initial"]);

    // Deferred turns queued from agent_end / agent_settled drain asynchronously; waitForIdle() awaits them all.
    await session.waitForIdle();
    expect(seenPrompts).toEqual(["initial", "from-agent-end", "from-agent-settled"]);
    expect(settledEvents).toEqual([
      { aborted: false, isIdle: true },
      { aborted: false, isIdle: true },
      { aborted: false, isIdle: true },
    ]);
    expect(
      session
        .getSnapshot()
        .messages.filter((m) => m.role === "assistant")
        .map((m) => m.content[0]),
    ).toEqual([
      { type: "text", text: "reply 1" },
      { type: "text", text: "reply 2" },
      { type: "text", text: "reply 3" },
    ]);
  });

  it("aborts an active run when ctx.compact() is triggered mid-run and discards deferred agent_end follow-ups", async () => {
    const { faux, models, store } = createTestEnv();
    let resolveCompact!: (result: CompactionResult) => void;
    const compactPromise = new Promise<CompactionResult>((resolve) => {
      resolveCompact = resolve;
    });
    let armAgentEndFollowUp = false;
    let deferredRunExecuted = false;

    const ext: ExtensionFactory = (pi) => {
      pi.on("agent_end", () => {
        if (!armAgentEndFollowUp) return;
        // Attempting to enqueue a follow-up during an aborted run must not hijack abort()/compact().
        pi.sendUserMessage("should-not-run-after-abort");
      });
      pi.registerTool(
        defineTool({
          name: "trigger_compact",
          description: "Triggers fire-and-forget ctx.compact() mid-run",
          parameters: obj({}),
          execute: async (_id, _params, _signal, _onUpdate, ctx) => {
            ctx.compact({
              customInstructions: "mid-run abort compact",
              onComplete: resolveCompact,
            });
            return { content: [{ type: "text", text: "triggered" }], details: {} };
          },
        }),
      );
    };

    faux.setResponses([
      fauxAssistantMessage("Earlier turn answer to ensure enough history to compact."),
      fauxAssistantMessage(fauxToolCall("trigger_compact", {}, { id: "tc-cmp" }), { stopReason: "toolUse" }),
      () => {
        deferredRunExecuted = true;
        return fauxAssistantMessage("Should not run because compact aborted the run.");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-midrun-compact",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      compaction: {
        keepRecentTokens: 1,
        summarizer: async ({ customInstructions }) => ({
          summary: `Aborted & compacted (${customInstructions ?? "none"})`,
        }),
      },
      extensions: [ext],
    });

    await session.prompt("Earlier turn question.");
    armAgentEndFollowUp = true;
    const runResult = await session.prompt("Now trigger compact mid-run.");
    const compactResult = await compactPromise;
    await session.waitForIdle();

    expect(runResult.status).toBe("aborted");
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.summary).toBe("Aborted & compacted (mid-run abort compact)");
    expect(deferredRunExecuted).toBe(false);
  });

  it("computes ctx.getContextUsage() from real assistant usage + trailing estimate and returns null after compaction", async () => {
    const { faux, models, store } = createTestEnv();
    let savedCtx!: ExtensionContext;

    // Pure unit check: real assistant usage + trailing message estimate.
    const assistantWithUsage = fauxAssistantMessage("ok");
    assistantWithUsage.usage = {
      input: 320,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 400,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const trailingUser = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "12345678" }], // 8 chars => 2 tokens
      timestamp: 2,
    };
    expect(estimateContextUsageTokens([assistantWithUsage, trailingUser])).toBe(402);

    const ext: ExtensionFactory = (pi) => {
      pi.on("session_start", (_event, ctx) => {
        savedCtx = ctx;
      });
    };

    faux.setResponses([
      fauxAssistantMessage("First reply with non-zero faux usage."),
      fauxAssistantMessage("Second reply before compaction."),
      fauxAssistantMessage("Post-compaction reply."),
    ]);

    const session = await createSession({
      sessionId: "sess-real-usage",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      compaction: {
        contextWindow: 1000,
        keepRecentTokens: 1,
        summarizer: async () => ({ summary: "Compact summary" }),
      },
      extensions: [ext],
    });

    await session.prompt("Hello");
    await session.prompt("More context");
    const lastBeforeCompact = [...session.getSnapshot().messages]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastBeforeCompact?.role).toBe("assistant");
    const expectedBefore = lastBeforeCompact?.role === "assistant" ? lastBeforeCompact.usage.totalTokens : -1;
    expect(expectedBefore).toBeGreaterThan(0);
    expect(savedCtx.getContextUsage()).toEqual({
      tokens: expectedBefore,
      contextWindow: 1000,
      percent: (expectedBefore / 1000) * 100,
    });

    const compacted = await session.compact({ keepRecentTokens: 1 });
    expect(compacted.compacted).toBe(true);
    expect(savedCtx.getContextUsage()).toEqual({ tokens: null, contextWindow: 1000, percent: null });

    await session.prompt("After compaction");
    const lastAfterCompact = [...session.getSnapshot().messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const expectedAfter = lastAfterCompact?.role === "assistant" ? lastAfterCompact.usage.totalTokens : -1;
    expect(expectedAfter).toBeGreaterThan(0);
    expect(savedCtx.getContextUsage()).toEqual({
      tokens: expectedAfter,
      contextWindow: 1000,
      percent: (expectedAfter / 1000) * 100,
    });
  });

  it("persists idle pi.appendEntry() calls from model_select, thinking_level_select, session_compact, and session_shutdown", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new InMemorySessionStore();

    const ext: ExtensionFactory = (pi) => {
      pi.on("model_select", (event) => {
        pi.appendEntry("audit.model", { to: event.model.id });
      });
      pi.on("thinking_level_select", (event) => {
        pi.appendEntry("audit.thinking", { to: event.level });
      });
      pi.on("session_compact", () => {
        pi.appendEntry("audit.compact", { ok: true });
      });
      pi.on("session_shutdown", () => {
        pi.appendEntry("audit.shutdown", { closed: true });
      });
    };

    faux.setResponses([fauxAssistantMessage("Turn 1"), fauxAssistantMessage("Turn 2")]);

    const session = await createSession({
      sessionId: "sess-idle-append",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      compaction: {
        keepRecentTokens: 1,
        summarizer: async () => ({ summary: "Summary" }),
      },
      extensions: [ext],
    });

    await session.prompt("Q1");
    await session.prompt("Q2");
    await session.setModel({ provider: "faux", modelId: "faux-2" });
    await session.setThinkingLevel("medium");
    await session.compact({ keepRecentTokens: 1 });
    await session.close();

    const reopened = await openSession({
      sessionId: "sess-idle-append",
      models,
      store,
    });
    expect(reopened.getSnapshot().customEntries?.map((e) => e.customType)).toEqual([
      "audit.model",
      "audit.thinking",
      "audit.compact",
      "audit.shutdown",
    ]);
  });

  it("supports pi.setModel(), session_start fork reason, and before_agent_start images", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new InMemorySessionStore();

    const startReasons: string[] = [];
    let seenImagesCount = 0;
    let apiSetModel!: (
      target: { provider: string; modelId: string } | { provider: string; id: string },
    ) => Promise<boolean>;

    const ext: ExtensionFactory = (pi) => {
      apiSetModel = (target) => pi.setModel(target as never);
      pi.on("session_start", (event) => {
        startReasons.push(event.reason);
      });
      pi.on("before_agent_start", (event) => {
        seenImagesCount = event.images?.length ?? 0;
      });
    };

    faux.setResponses([fauxAssistantMessage("Image received.")]);

    const session = await createSession({
      sessionId: "sess-polish",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [ext],
    });

    expect(await apiSetModel({ provider: "faux", modelId: "missing" })).toBe(false);
    expect(await apiSetModel({ provider: "faux", modelId: "faux-2" })).toBe(true);
    expect(session.model).toEqual({ provider: "faux", modelId: "faux-2" });

    // Also accepts full Model<Api> objects directly.
    const model1 = models.getModel("faux", "faux-1")!;
    expect(await apiSetModel(model1)).toBe(true);
    expect(session.model).toEqual({ provider: "faux", modelId: "faux-1" });

    await session.prompt("Inspect this image", [{ type: "image", data: "AQID", mimeType: "image/png" }]);
    expect(seenImagesCount).toBe(1);

    await session.fork({ sessionId: "sess-polish-fork" });
    expect(startReasons).toEqual(["create", "fork"]);
  });
});
