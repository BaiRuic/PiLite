import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/index.js";
import { openNodeSqliteSessionStore } from "../src/store/sqlite/node.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const workerPath = join(testDir, "fixtures", "crash-worker.mjs");

function runWorker(
  args: string[],
  options: { killOnMarker?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.killOnMarker && !killed && stdout.includes(options.killOnMarker)) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("SQLite persistence and hard-kill crash recovery", () => {
  it("reopens a normally exited session and applies updated systemPrompt on follow-up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilite-normal-"));
    const dbPath = join(dir, "session.sqlite");
    try {
      const outcome = await runWorker(["normal", dbPath, "sess-normal"]);
      expect(outcome.stderr).toBe("");
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toContain("WORKER_DONE");

      const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
      const models = createModels();
      models.setProvider(faux.provider);

      let observedPrompt = "";
      faux.setResponses([
        (context) => {
          observedPrompt = getCurrentSystemPrompt(context.messages);
          return fauxAssistantMessage("Follow-up after reopen.");
        },
      ]);

      const store = await openNodeSqliteSessionStore(dbPath);
      try {
        const session = await openSession({
          sessionId: "sess-normal",
          models,
          store,
          systemPrompt: "Worker v2",
        });

        expect(session.getSnapshot().status).toBe("idle");
        expect(session.getSnapshot().messages.map((m) => m.role)).toEqual([
          "system",
          "user",
          "assistant",
          "toolResult",
          "assistant",
        ]);

        const next = await session.prompt("follow up");
        expect(next.status).toBe("idle");
        expect(observedPrompt).toBe("Worker v2");
      } finally {
        await store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a session interrupted without auto-replay after hard kill mid-stream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilite-crash-stream-"));
    const dbPath = join(dir, "session.sqlite");
    try {
      const outcome = await runWorker(["crash-stream", dbPath, "sess-stream-crash"], {
        killOnMarker: "READY_TO_KILL",
      });
      expect(outcome.stdout).toContain("READY_TO_KILL");
      expect(outcome.stdout).not.toContain("WORKER_DONE");

      const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("Recovered via explicit continue.")]);

      const store = await openNodeSqliteSessionStore(dbPath);
      try {
        const reopened = await openSession({
          sessionId: "sess-stream-crash",
          models,
          store,
        });

        expect(faux.state.callCount).toBe(0);
        expect(reopened.getSnapshot().status).toBe("interrupted");
        expect(reopened.getSnapshot().messages.map((m) => m.role)).toEqual(["system", "user"]);

        const retried = await reopened.continue();
        expect(retried.status).toBe("idle");
        expect(faux.state.callCount).toBe(1);
      } finally {
        await store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a session interrupted without dangling tool calls after hard kill mid-tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pilite-crash-tool-"));
    const dbPath = join(dir, "session.sqlite");
    try {
      const outcome = await runWorker(["crash-tool", dbPath, "sess-tool-crash"], {
        killOnMarker: "READY_TO_KILL",
      });
      expect(outcome.stdout).toContain("READY_TO_KILL");
      expect(outcome.stdout).not.toContain("WORKER_DONE");

      const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("Clean recovery after tool crash.")]);

      const store = await openNodeSqliteSessionStore(dbPath);
      try {
        const reopened = await openSession({
          sessionId: "sess-tool-crash",
          models,
          store,
        });

        expect(faux.state.callCount).toBe(0);
        expect(reopened.getSnapshot().status).toBe("interrupted");
        // No incomplete assistant toolCall or orphaned toolResult is persisted.
        expect(reopened.getSnapshot().messages.map((m) => m.role)).toEqual(["system", "user"]);

        const retried = await reopened.continue();
        expect(retried.status).toBe("idle");
        expect(faux.state.callCount).toBe(1);
      } finally {
        await store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
