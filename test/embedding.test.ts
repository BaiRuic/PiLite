import { describe, expect, it } from "vitest";
import { HarnessError } from "../src/index.js";
import {
  createApiBackendProvider,
  createModelHub,
  createOpenAIEmbeddingProvider,
  createStaticLocalModelSource,
} from "../src/models/index.js";

describe("createOpenAIEmbeddingProvider (standalone)", () => {
  it("calls POST /embeddings, sorts by index, L2-normalizes by default, and computes stable fingerprints", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      // Return indices out of order to verify deterministic sorting.
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 5] },
            { index: 0, embedding: [3, 4] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const embedder = createOpenAIEmbeddingProvider({
      id: "openai",
      modelId: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "$TEST_EMBED_KEY",
      dimensions: 2,
      configResolver: { env: { TEST_EMBED_KEY: "sk-live-secret" } },
      fetch: mockFetch,
    });

    // Empty input short-circuits without hitting network.
    expect(await embedder.embed([])).toEqual([]);
    expect(requests).toHaveLength(0);

    const vectors = await embedder.embed(["first", "second"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-live-secret");
    expect(requests[0]!.body).toEqual({
      model: "text-embedding-3-small",
      input: ["first", "second"],
      encoding_format: "float",
      dimensions: 2,
    });

    // [3, 4] -> [0.6, 0.8]; [0, 5] -> [0, 1]
    expect(vectors[0]![0]).toBeCloseTo(0.6, 6);
    expect(vectors[0]![1]).toBeCloseTo(0.8, 6);
    expect(vectors[1]![0]).toBeCloseTo(0, 6);
    expect(vectors[1]![1]).toBeCloseTo(1, 6);

    // Fingerprint is deterministic, never contains the secret key, and changes when model/dimensions change.
    const fp = embedder.fingerprint();
    expect(fp).toBe("https://api.openai.com/v1#text-embedding-3-small@2");
    expect(fp).not.toContain("sk-live-secret");

    // Raw vectors when normalize: false.
    const rawEmbedder = createOpenAIEmbeddingProvider({
      modelId: "nomic-embed-text",
      baseUrl: "http://127.0.0.1:11434/v1",
      allowKeyless: true,
      normalize: false,
      fetch: mockFetch,
    });
    const raw = await rawEmbedder.embed(["a", "b"]);
    expect(raw).toEqual([
      [3, 4],
      [0, 5],
    ]);
    expect(requests[1]!.headers.authorization).toBe(undefined);
  });

  it("validates HTTP status, vector counts, dimensions, zero-norm vectors, and response size limit", async () => {
    const make = (response: () => Response, extra?: { maxResponseBytes?: number }) =>
      createOpenAIEmbeddingProvider({
        modelId: "embed-test",
        baseUrl: "https://embed.test/v1",
        allowKeyless: true,
        fetch: async () => response(),
        ...extra,
      });

    await expect(make(() => new Response("fail", { status: 500 })).embed(["a"])).rejects.toThrow(/HTTP 500/);
    await expect(
      make(() => new Response(JSON.stringify({ data: [] }), { status: 200 })).embed(["a"]),
    ).rejects.toThrow(/returned 0 vectors/);
    await expect(
      make(
        () =>
          new Response(
            JSON.stringify({
              data: [
                { index: 0, embedding: [1, 2] },
                { index: 1, embedding: [1, 2, 3] },
              ],
            }),
            { status: 200 },
          ),
      ).embed(["a", "b"]),
    ).rejects.toThrow(/Inconsistent embedding dimensions/);
    await expect(
      make(
        () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] }), { status: 200 }),
      ).embed(["a"]),
    ).rejects.toThrow(/zero norm/);
    await expect(
      make(
        () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }), { status: 200 }),
        { maxResponseBytes: 16 },
      ).embed(["a"]),
    ).rejects.toThrow(/exceeds limit/);
  });
});

describe("ModelHub embedding model discovery, selection, and auth reuse", () => {
  it("lists configured/available embedding models and reuses ModelHub JWT & local keyless auth", async () => {
    let currentJwt = "jwt-v1";
    const seenAuth: Array<{ url: string; auth?: string; tenant?: string }> = [];

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth.push({
        url: String(input),
        auth: headers.authorization ?? headers.Authorization,
        tenant: headers["X-Tenant"],
      });
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 0] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const corpBackend = createApiBackendProvider({
      id: "corp-ai",
      baseUrl: "https://ai.corp.test/v1",
      modelsEndpoint: null,
      getAuth: async () => ({
        apiKey: currentJwt,
        headers: { "X-Tenant": "team-a" },
      }),
    });

    const unconfiguredBackend = createApiBackendProvider({
      id: "unconfigured",
      baseUrl: "https://unconfigured.test/v1",
      modelsEndpoint: null,
      apiKey: "$MISSING_API_KEY",
    });

    const localSource = createStaticLocalModelSource({
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          embeddingModels: [{ id: "nomic-embed-text", name: "Nomic Embed", dimensions: 768 }],
        },
        unconfigured: {
          embeddingModels: [{ id: "embed-disabled", dimensions: 1536 }],
        },
      },
    });

    const hub = createModelHub({
      providers: [corpBackend, unconfiguredBackend],
      localSources: [localSource],
      embeddingModels: [
        {
          id: "corp-embed-v1",
          name: "Corp Embed v1",
          provider: "corp-ai",
          baseUrl: "https://ai.corp.test/v1",
          dimensions: 1024,
        },
      ],
      configResolver: { env: {} },
      fetch: mockFetch,
    });

    await hub.init({ allowNetwork: false });

    // All declared embedding models are inspectable (from programmatic registration + localSources).
    const all = hub.getEmbeddingModels();
    expect(all.map((m) => `${m.provider}/${m.id}`).sort()).toEqual([
      "corp-ai/corp-embed-v1",
      "ollama/nomic-embed-text",
      "unconfigured/embed-disabled",
    ]);

    // Only models whose provider has valid auth (JWT backend + keyless Ollama) are available.
    const available = await hub.getAvailableEmbeddingModels();
    expect(available.map((m) => `${m.provider}/${m.id}`).sort()).toEqual([
      "corp-ai/corp-embed-v1",
      "ollama/nomic-embed-text",
    ]);

    // Select corp-ai/corp-embed-v1 -> reuses live rotating JWT + custom tenant header!
    const corpEmbedder = hub.createEmbeddingProvider("corp-ai", "corp-embed-v1");
    expect(corpEmbedder.dimensions).toBe(1024);
    await corpEmbedder.embed(["hello"]);
    currentJwt = "jwt-v2";
    await corpEmbedder.embed(["world"]);

    // Select ollama/nomic-embed-text -> keyless local request without Authorization header.
    const ollamaEmbedder = hub.createEmbeddingProvider("ollama", "nomic-embed-text");
    await ollamaEmbedder.embed(["local doc"]);

    expect(seenAuth).toEqual([
      { url: "https://ai.corp.test/v1/embeddings", auth: "Bearer jwt-v1", tenant: "team-a" },
      { url: "https://ai.corp.test/v1/embeddings", auth: "Bearer jwt-v2", tenant: "team-a" },
      { url: "http://127.0.0.1:11434/v1/embeddings", auth: undefined, tenant: undefined },
    ]);

    // Unknown provider with no baseUrl rejects with MODEL_NOT_FOUND.
    expect(() => hub.createEmbeddingProvider("nope", "missing")).toThrow(HarnessError);
  });
});
