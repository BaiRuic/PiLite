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
    let compactBusyError: Error | undefined;
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
            await new Promise<void>((resolve) => {
              ctx.compact({
                onError: (err) => {
                  compactBusyError = err;
                  resolve();
                },
              });
            });
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
        summarizer: async ({ instructions }) => ({
          summary: `Compact summary (${instructions ?? "none"})`,
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
    expect(compactBusyError).toBeInstanceOf(Error);

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
      getThinkingLevel: () => "off",
      setThinkingLevel: async () => undefined,
      getSessionName: () => undefined,
      setSessionName: async () => undefined,
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
});
