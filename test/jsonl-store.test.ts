import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlCorruptionError,
  JsonlStorageReadOnlyError,
  openNodeJsonlSessionStore,
} from "../src/store/jsonl/node.js";
import { registerSessionStoreContract } from "../src/testing.js";
import { SESSION_SNAPSHOT_VERSION, type SessionSnapshot } from "../src/types.js";

registerSessionStoreContract({ describe, it, expect }, "JsonlSessionStore (node:fs)", async (use) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-harness-jsonl-"));
  const store = await openNodeJsonlSessionStore(dir);
  try {
    await use(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function makeSnapshot(
  sessionId: string,
  status: SessionSnapshot["status"],
  updatedAt: number,
): SessionSnapshot {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    sessionId,
    model: { provider: "faux", modelId: "faux-1" },
    messages: [{ role: "user", content: [{ type: "text", text: `msg-${updatedAt}` }], timestamp: updatedAt }],
    status,
    updatedAt,
  };
}

describe("JsonlSessionStore (crash tolerance, compaction, and readOnly mode)", () => {
  it("recovers from a torn final line by truncating in writable mode and skipping in readOnly mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-jsonl-torn-"));
    try {
      const writer = await openNodeJsonlSessionStore(dir, { fsync: true });
      const snap1 = makeSnapshot("torn-session", "running", 100);
      await writer.save("torn-session", snap1);
      await writer.close();

      // Simulate a process crash mid-append leaving a truncated JSON tail.
      const filePath = join(dir, "torn-session.jsonl");
      const beforeCorrupt = await readFile(filePath, "utf8");
      await appendFile(filePath, '{"format":1,"type":"snapshot","snapshot":{"sessionId":"torn', "utf8");

      // Read-only open must skip the torn tail without modifying the file and reject writes.
      const reader = await openNodeJsonlSessionStore(dir, { readOnly: true });
      try {
        expect(await reader.load("torn-session")).toEqual(snap1);
        await expect(reader.save("torn-session", snap1)).rejects.toBeInstanceOf(JsonlStorageReadOnlyError);
        await expect(reader.compact("torn-session")).rejects.toBeInstanceOf(JsonlStorageReadOnlyError);
        await expect(reader.delete("torn-session")).rejects.toBeInstanceOf(JsonlStorageReadOnlyError);
      } finally {
        await reader.close();
      }
      expect(await readFile(filePath, "utf8")).not.toBe(beforeCorrupt);

      // Writable open repairs (truncates) the torn tail cleanly.
      const repaired = await openNodeJsonlSessionStore(dir);
      try {
        expect(await repaired.load("torn-session")).toEqual(snap1);
        expect(await readFile(filePath, "utf8")).toBe(beforeCorrupt);

        const snap2 = makeSnapshot("torn-session", "idle", 200);
        await repaired.save("torn-session", snap2);
        expect(await repaired.load("torn-session")).toEqual(snap2);
      } finally {
        await repaired.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws JsonlCorruptionError when a non-final line is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-jsonl-corrupt-"));
    try {
      const store = await openNodeJsonlSessionStore(dir);
      const snap = makeSnapshot("bad-mid", "idle", 1);
      await store.save("bad-mid", snap);

      const filePath = join(dir, "bad-mid.jsonl");
      await appendFile(filePath, "not-json\n", "utf8");
      await appendFile(
        filePath,
        `${JSON.stringify({ format: 1, type: "snapshot", snapshot: snap })}\n`,
        "utf8",
      );

      await expect(store.load("bad-mid")).rejects.toBeInstanceOf(JsonlCorruptionError);
      await store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compacts session files automatically at threshold and encodes unsafe session IDs safely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-jsonl-compact-"));
    try {
      const store = await openNodeJsonlSessionStore(dir, { compactAfterLines: 3 });
      const weirdId = "../team/session:1";
      await store.save(weirdId, makeSnapshot(weirdId, "running", 1));
      await store.save(weirdId, makeSnapshot(weirdId, "idle", 2));
      await store.save(weirdId, makeSnapshot(weirdId, "idle", 3));

      expect((await store.load(weirdId))?.updatedAt).toBe(3);

      // Explicit compaction on a non-existent session returns false.
      expect(await store.compact("does-not-exist")).toBe(false);
      expect(await store.compact(weirdId)).toBe(true);

      await store.close();
      await expect(store.load(weirdId)).rejects.toThrow(/closed/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
