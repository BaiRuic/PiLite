import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createCliAuthInteraction,
  createJsonFileModelSource,
  FileCredentialStore,
  FileModelsStore,
} from "../src/models/node/index.js";
import {
  registerCredentialStoreContract,
  registerModelsStoreContract,
} from "../src/testing.js";

registerCredentialStoreContract(
  { describe, it, expect },
  "FileCredentialStore (node:fs)",
  async (use) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-file-cred-"));
    try {
      await use(new FileCredentialStore(join(dir, "auth.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

registerModelsStoreContract(
  { describe, it, expect },
  "FileModelsStore (node:fs)",
  async (use) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-file-models-"));
    try {
      await use(new FileModelsStore(join(dir, "models-store.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

describe("createJsonFileModelSource (JSON/JSONC)", () => {
  it("loads JSONC with comments and BOM, and returns empty config on missing optional file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-harness-models-json-"));
    try {
      const missingPath = join(dir, "missing.json");
      const optionalSource = createJsonFileModelSource(missingPath);
      expect(await optionalSource.load()).toEqual({ providers: {} });

      const requiredSource = createJsonFileModelSource(missingPath, { required: true });
      await expect(requiredSource.load()).rejects.toThrow();

      const jsoncPath = join(dir, "models.json");
      await writeFile(
        jsoncPath,
        `\uFEFF{
          // Local Ollama server with URL containing // inside string
          "providers": {
            "ollama": {
              /* block comment */
              "baseUrl": "http://127.0.0.1:11434/v1",
              "discover": true,
              "models": [
                { "id": "qwen3:8b", "contextWindow": 32768 }
              ]
            }
          }
        }`,
        "utf8",
      );

      const loaded = await createJsonFileModelSource(jsoncPath).load();
      expect(loaded.providers.ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
      expect(loaded.providers.ollama?.discover).toBe(true);
      expect(loaded.providers.ollama?.models?.[0]?.id).toBe("qwen3:8b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createCliAuthInteraction", () => {
  it("handles auth_url, device_code, select, secret, manual_code, and prompt-level cancellation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += chunk.toString("utf8");
    });

    const openedUrls: string[] = [];
    const interaction = createCliAuthInteraction({
      input,
      output,
      openUrl: (url) => {
        openedUrls.push(url);
      },
    });

    interaction.notify({
      type: "auth_url",
      url: "https://auth.example.com/start",
      instructions: "Complete sign-in in browser.",
    });
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example.com/device",
      userCode: "ABCD-1234",
    });

    expect(openedUrls).toEqual([
      "https://auth.example.com/start",
      "https://auth.example.com/device",
    ]);
    expect(written).toContain("https://auth.example.com/start");
    expect(written).toContain("ABCD-1234");

    // Select option #2
    const selectPromise = interaction.prompt({
      type: "select",
      message: "Choose method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device", label: "Device Code" },
      ],
    });
    input.write("2\n");
    expect(await selectPromise).toBe("device");

    // Secret input (non-TTY stream)
    const secretPromise = interaction.prompt({
      type: "secret",
      message: "Enter API key",
    });
    input.write("sk-test-secret\n");
    expect(await secretPromise).toBe("sk-test-secret");

    // Per-prompt signal cancellation (simulates browser callback winning over manual_code prompt)
    const promptAbort = new AbortController();
    const manualPromise = interaction.prompt({
      type: "manual_code",
      message: "Paste redirect code",
      signal: promptAbort.signal,
    });
    promptAbort.abort(new Error("Callback received"));
    await expect(manualPromise).rejects.toThrow();

    input.end();
    output.end();
  });
});
