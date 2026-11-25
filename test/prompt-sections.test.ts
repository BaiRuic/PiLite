import { createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  createSession,
  definePromptSection,
  defineTool,
  type ExtensionDiagnostic,
  type ExtensionFactory,
  InMemorySessionStore,
  openSession,
  planSections,
  renderSections,
  replaySections,
} from "../src/index.js";

function createTestEnv() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new InMemorySessionStore();
  return { faux, models, store };
}

describe("PromptSection & planSections (pi-durable aligned)", () => {
  it("computes minimal section patches and falls back to remove-all + re-add when order changes", () => {
    const shown = new Map<string, string>([
      ["system", "BASE"],
      ["workspace", "<workspace>\nrepo-a\n</workspace>"],
      ["memory", "<memory>\nv1\n</memory>"],
    ]);

    // 1. Identical map => no patch.
    expect(planSections(shown, new Map(shown))).toEqual([]);

    // 2. Order preserved, with 1 unchanged + 1 updated + 1 deleted + 1 added => 1 minimal delta.
    const nextPreservedOrder = new Map<string, string>([
      ["system", "BASE"],
      ["memory", "<memory>\nv2\n</memory>"],
      ["skills", "<skills>\nsql\n</skills>"],
    ]);
    expect(planSections(shown, nextPreservedOrder)).toEqual([
      {
        workspace: null,
        memory: "<memory>\nv2\n</memory>",
        skills: "<skills>\nsql\n</skills>",
      },
    ]);

    // 3. Reordering existing keys => 2-step remove-all then re-add in desired order.
    const reordered = new Map<string, string>([
      ["memory", "<memory>\nv1\n</memory>"],
      ["system", "BASE"],
      ["workspace", "<workspace>\nrepo-a\n</workspace>"],
    ]);
    expect(planSections(shown, reordered)).toEqual([
      { system: null, workspace: null, memory: null },
      {
        memory: "<memory>\nv1\n</memory>",
        system: "BASE",
        workspace: "<workspace>\nrepo-a\n</workspace>",
      },
    ]);

    // 4. replaySections replays patches in order accurately.
    const replayed = replaySections([
      { role: "system", content: "", sections: { a: "1", b: "2" }, timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 },
      { role: "system", content: "", sections: { b: null, c: "3" }, timestamp: 3 },
    ]);
    expect([...replayed.entries()]).toEqual([
      ["a", "1"],
      ["c", "3"],
    ]);
  });

  it("isolates throwing section renders by keeping previously shown text, and rethrows when aborted", async () => {
    const errors: string[] = [];
    const shown = new Map<string, string>([["flaky", "<flaky>\nprevious\n</flaky>"]]);
    const controller = new AbortController();

    const fakeCtx = { signal: controller.signal } as never;
    const sections = [
      definePromptSection("flaky", () => {
        throw new Error("temporary render error");
      }),
      definePromptSection("raw", () => "plain text", { tag: false }),
      definePromptSection("omitted", () => undefined),
    ];

    const rendered = await renderSections(sections, fakeCtx, shown, (err, sec) => {
      errors.push(`${sec.key}:${err instanceof Error ? err.message : String(err)}`);
    });
    expect(errors).toEqual(["flaky:temporary render error"]);
    expect([...rendered.entries()]).toEqual([
      ["flaky", "<flaky>\nprevious\n</flaky>"],
      ["raw", "plain text"],
    ]);

    // When aborted, errors propagate instead of being swallowed.
    controller.abort();
    await expect(renderSections(sections, fakeCtx, shown)).rejects.toThrow("temporary render error");
  });

  it("emits minimal delta patches across turns and zero patches when unchanged", async () => {
    const { faux, models, store } = createTestEnv();
    let memoryValue: string | undefined = "remember alpha";
    const seenPrompts: string[] = [];
    const seenShownKeys: string[][] = [];

    const session = await createSession({
      sessionId: "sess-sections-delta",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "BASE",
      promptSections: [
        definePromptSection("workspace", () => "cwd=/project"),
        definePromptSection("memory", (_ctx, shown) => {
          seenShownKeys.push(Object.keys(shown));
          return memoryValue;
        }),
      ],
    });

    const record = (reply: string) => (ctx: { messages: readonly any[] }) => {
      seenPrompts.push(getCurrentSystemPrompt(ctx.messages));
      return fauxAssistantMessage(reply);
    };

    faux.setResponses([record("r1"), record("r2"), record("r3"), record("r4")]);

    // Turn 1: initial sections patch emitted.
    await session.prompt("t1");
    const sysAfterT1 = session.getSnapshot().messages.filter((m) => m.role === "system");
    expect(sysAfterT1).toHaveLength(2); // initial { system: "BASE" } + delta { workspace, memory }

    // Turn 2: nothing changed => zero new system messages appended.
    await session.prompt("t2");
    const sysAfterT2 = session.getSnapshot().messages.filter((m) => m.role === "system");
    expect(sysAfterT2).toHaveLength(2);

    // Turn 3: only memory changed => minimal delta contains ONLY memory key.
    memoryValue = "remember beta";
    await session.prompt("t3");
    const sysAfterT3 = session.getSnapshot().messages.filter((m) => m.role === "system");
    expect(sysAfterT3).toHaveLength(3);
    expect(sysAfterT3[2]?.sections).toEqual({ memory: "<memory>\nremember beta\n</memory>" });

    // Turn 4: memory omitted => minimal delta deletes ONLY memory via null.
    memoryValue = undefined;
    await session.prompt("t4");
    const sysAfterT4 = session.getSnapshot().messages.filter((m) => m.role === "system");
    expect(sysAfterT4).toHaveLength(4);
    expect(sysAfterT4[3]?.sections).toEqual({ memory: null });

    expect(seenPrompts[0]).toContain("BASE");
    expect(seenPrompts[0]).toContain("<workspace>\ncwd=/project\n</workspace>");
    expect(seenPrompts[0]).toContain("<memory>\nremember alpha\n</memory>");
    expect(seenPrompts[2]).toContain("<memory>\nremember beta\n</memory>");
    expect(seenPrompts[3]).not.toContain("<memory>");
    expect(seenPrompts[3]).toContain("<workspace>\ncwd=/project\n</workspace>");
    expect(seenShownKeys[1]).toEqual(["system", "workspace", "memory"]);
  });

  it("refreshes sections mid-run via prepareNextTurnWithContext when a tool activates a skill", async () => {
    const { faux, models, store } = createTestEnv();
    const seenPromptsInRun: string[] = [];

    const skillsExt: ExtensionFactory = (pi) => {
      pi.registerPromptSection(
        definePromptSection("skills", (ctx) => {
          const active = ctx
            .getCustomEntries<{ name: string }>("active_skill")
            .map((e) => e.data?.name)
            .filter((name): name is string => Boolean(name));
          if (active.length === 0) {
            return "Available skills: sql";
          }
          return `Available skills: sql\nLoaded skill [sql]: Always use parameterized queries.`;
        }),
      );

      pi.registerTool(
        defineTool({
          name: "activate_skill",
          description: "Loads a skill into the current session",
          parameters: obj({ name: str() }),
          execute: async (_id, params) => {
            pi.appendEntry("active_skill", { name: params.name });
            return { content: [{ type: "text", text: `Activated ${params.name}` }], details: {} };
          },
        }),
      );
    };

    faux.setResponses([
      (ctx) => {
        seenPromptsInRun.push(getCurrentSystemPrompt(ctx.messages));
        return fauxAssistantMessage(fauxToolCall("activate_skill", { name: "sql" }, { id: "tc-skill" }), {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        seenPromptsInRun.push(getCurrentSystemPrompt(ctx.messages));
        return fauxAssistantMessage("Used parameterized SQL.");
      },
    ]);

    const session = await createSession({
      sessionId: "sess-skill-midrun",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "BASE",
      extensions: [skillsExt],
    });

    await session.prompt("Write a SQL query");
    expect(seenPromptsInRun).toHaveLength(2);
    expect(seenPromptsInRun[0]).toContain("Available skills: sql");
    expect(seenPromptsInRun[0]).not.toContain("parameterized queries");
    // Very next LLM call inside the SAME prompt() sees the updated <skills> section!
    expect(seenPromptsInRun[1]).toContain("Always use parameterized queries.");

    // Verify the mid-run section patch was persisted cleanly into the snapshot.
    const replayed = replaySections(session.getSnapshot().messages);
    expect(replayed.get("skills")).toContain("Always use parameterized queries.");
  });

  it("supports pi.wrapPromptSection(), isolates bad wrappers, and replays sections across reopen and compaction", async () => {
    const { faux, models, store } = createTestEnv();
    const diagnostics: ExtensionDiagnostic[] = [];
    const seenPrompts: string[] = [];

    const baseExt: ExtensionFactory = (pi) => {
      pi.registerPromptSection(definePromptSection("guide", () => "Rule 1"));
      pi.registerPromptSection(definePromptSection("bad_target", () => "Will be dropped by bad wrapper"));
    };

    const wrapExt: ExtensionFactory = (pi) => {
      // Valid wrapper appends to "guide".
      pi.wrapPromptSection("guide", (base) => ({
        ...base,
        render: async (ctx, shown) => `${(await base.render(ctx, shown)) ?? ""}\nRule 2`,
      }));
      // Wrapper that renames key reports diagnostic and drops target (aligned with pi-durable).
      pi.wrapPromptSection("bad_target", (base) => ({
        ...base,
        key: "renamed_illegal",
      }));
      // Wrapper on missing key is a clean no-op.
      pi.wrapPromptSection("nonexistent", (base) => base);
    };

    const record = (reply: string) => (ctx: { messages: readonly any[] }) => {
      seenPrompts.push(getCurrentSystemPrompt(ctx.messages));
      return fauxAssistantMessage(reply);
    };

    faux.setResponses([record("r1"), record("r2"), record("r3")]);

    const session = await createSession({
      sessionId: "sess-wrap-compact",
      models,
      store,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "ORIGINAL SYSTEM",
      compaction: {
        keepRecentTokens: 1,
        summarizer: async () => ({ summary: "Compacted summary" }),
      },
      extensions: [
        { name: "base-ext", factory: baseExt },
        { name: "wrap-ext", factory: wrapExt },
      ],
      onExtensionDiagnostic: (d) => diagnostics.push(d),
    });

    await session.prompt("Turn 1");
    await session.prompt("Turn 2");

    expect(seenPrompts[0]).toContain("ORIGINAL SYSTEM");
    expect(seenPrompts[0]).toContain("<guide>\nRule 1\nRule 2\n</guide>");
    expect(seenPrompts[0]).not.toContain("bad_target");
    expect(
      diagnostics.some(
        (d) => d.kind === "handler_error" && d.extensionName === "wrap-ext" && d.event === "prompt_section",
      ),
    ).toBe(true);

    // Compaction preserves active sections in projected context.
    const compacted = await session.compact({ keepRecentTokens: 1 });
    expect(compacted.compacted).toBe(true);
    const contextPrompt = getCurrentSystemPrompt(session.getContextMessages());
    expect(contextPrompt).toContain("ORIGINAL SYSTEM");
    expect(contextPrompt).toContain("<guide>\nRule 1\nRule 2\n</guide>");

    // Reopen without systemPrompt and without extensions preserves ORIGINAL SYSTEM and cleans stale "guide".
    const reopened = await openSession({
      sessionId: "sess-wrap-compact",
      models,
      store,
    });
    await reopened.prompt("Turn 3");
    expect(seenPrompts[2]).toContain("ORIGINAL SYSTEM");
    expect(seenPrompts[2]).not.toContain("<guide>");
  });
});
