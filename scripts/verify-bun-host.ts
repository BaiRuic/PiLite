/**
 * Minimal host verification entrypoint for Bun single-file packaging (Phase 1 acceptance).
 *
 * This is NOT a user-facing CLI. It exercises the compiled Bun binary with:
 * - `bun:sqlite` via `openBunSqliteSessionStore`
 * - streaming events, a host-injected read-only tool, and cancellation
 * - reopen after normal exit and after a simulated `running` crash
 * - optional real provider smoke test when `PI_HARNESS_REAL_PROVIDER=openai|anthropic`
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { obj, str } from "@earendil-works/pi-schema";
import { createSession, type ModelRef, openSession, SESSION_SNAPSHOT_VERSION } from "../src/index.js";
import { openBunSqliteSessionStore } from "../src/store/sqlite/bun.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Verification assertion failed: ${message}`);
  }
}

const lookupParams = obj({ key: str({ description: "Key to look up" }) });
const readOnlyLookupTool: AgentTool<typeof lookupParams> = {
  name: "lookup_status",
  label: "Lookup Status",
  description: "Read-only key lookup tool",
  parameters: lookupParams,
  execute: async (_id, params) => ({
    content: [{ type: "text", text: `status:${params.key}=healthy` }],
    details: { key: params.key },
  }),
};

async function runOfflineVerification(dbPath: string): Promise<void> {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1" }],
    tokensPerSecond: 60,
  });
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup_status", { key: "api" }, { id: "tc-bun-1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("API status is healthy."),
    fauxAssistantMessage([fauxText("Long response that will be cancelled during streaming.")]),
    fauxAssistantMessage("Recovered cleanly after crash."),
  ]);

  // 1. Streaming + read-only tool + normal persistence + reopen
  const store1 = await openBunSqliteSessionStore(dbPath, { prefix: "verify_" });
  try {
    const s1 = await createSession({
      sessionId: "bun-verify-1",
      models,
      store: store1,
      model: { provider: "faux", modelId: "faux-1" },
      systemPrompt: "Verify prompt v1",
      tools: [readOnlyLookupTool],
      maxTurns: 4,
    });

    let streamed = "";
    s1.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
      }
    });

    const r1 = await s1.prompt("Check api status");
    assert(r1.status === "idle", `expected idle, got ${r1.status}`);
    assert(streamed === "API status is healthy.", `unexpected streamed text: ${streamed}`);

    // 2. Abort mid-stream
    let aborted = false;
    s1.subscribe((event) => {
      if (!aborted && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        aborted = true;
        void s1.abort();
      }
    });
    const r2 = await s1.prompt("Stream and abort");
    assert(r2.status === "aborted", `expected aborted, got ${r2.status}`);

    // 3. Seed a crashed `running` snapshot
    await store1.save("bun-crash-1", {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: "bun-crash-1",
      model: { provider: "faux", modelId: "faux-1" },
      status: "running",
      updatedAt: Date.now(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "interrupted before reply" }],
          timestamp: Date.now(),
        },
      ],
    });
  } finally {
    await store1.close();
  }

  // 4. Reopen both sessions from SQLite file
  const store2 = await openBunSqliteSessionStore(dbPath, { prefix: "verify_" });
  try {
    const reopenedNormal = await openSession({
      sessionId: "bun-verify-1",
      models,
      store: store2,
      tools: [readOnlyLookupTool],
    });
    assert(reopenedNormal.getSnapshot().status === "aborted", "expected persisted aborted status");

    const callsBefore = faux.state.callCount;
    const reopenedCrash = await openSession({
      sessionId: "bun-crash-1",
      models,
      store: store2,
    });
    assert(reopenedCrash.getSnapshot().status === "interrupted", "expected interrupted on reopen");
    assert(faux.state.callCount === callsBefore, "reopen must not auto-replay");

    const continued = await reopenedCrash.continue();
    assert(continued.status === "idle", `expected idle after continue, got ${continued.status}`);
  } finally {
    await store2.close();
  }
}

async function runRealProviderSmoke(dbPath: string, providerName: string): Promise<void> {
  const models = createModels();
  let modelRef: ModelRef;
  if (providerName === "openai") {
    models.setProvider(openaiProvider());
    modelRef = {
      provider: "openai",
      modelId: process.env.PI_HARNESS_MODEL ?? "gpt-4.1-mini",
    };
  } else if (providerName === "anthropic") {
    models.setProvider(anthropicProvider());
    modelRef = {
      provider: "anthropic",
      modelId: process.env.PI_HARNESS_MODEL ?? "claude-sonnet-4-6",
    };
  } else {
    throw new Error(`Unsupported PI_HARNESS_REAL_PROVIDER: ${providerName}`);
  }

  const store = await openBunSqliteSessionStore(dbPath);
  try {
    const session = await createSession({
      sessionId: "real-smoke-1",
      models,
      store,
      model: modelRef,
      systemPrompt: "Call lookup_status with key 'service' and summarize the result in one sentence.",
      tools: [readOnlyLookupTool],
      maxTurns: 4,
    });

    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    const result = await session.prompt("Check service status.");
    process.stdout.write("\n");
    assert(result.status === "idle", `real provider smoke ended with ${result.status}: ${result.lastError}`);
  } finally {
    await store.close();
  }
}

const tempDir = await mkdtemp(join(tmpdir(), "pi-harness-bun-verify-"));
const dbPath = join(tempDir, "verify.sqlite");
try {
  await runOfflineVerification(dbPath);
  const realProvider = process.env.PI_HARNESS_REAL_PROVIDER;
  if (realProvider) {
    await runRealProviderSmoke(join(tempDir, "real.sqlite"), realProvider);
  }
  console.log(
    JSON.stringify({
      ok: true,
      runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`,
      realProvider: realProvider ?? null,
    }),
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
