import { createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  createSession,
  defineTool,
  type ExtensionDiagnostic,
  type ExtensionFactory,
  InMemorySessionStore,
  openSession,
  type SessionStore,
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
            const execResult = await pi.exec("echo", ["hello"]);
            return {
              content: [{ type: "text", text: `approved:${approved};out:${execResult.stdout}` }],
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
      exec: async (cmd, args) => ({ stdout: `${cmd}:${args.join(" ")}`, stderr: "", exitCode: 0 }),
      onExtensionDiagnostic: (d) => diagnostics.push(d),
    });

    const result = await session.prompt("Check host");
    expect(result.status).toBe("idle");
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
});
