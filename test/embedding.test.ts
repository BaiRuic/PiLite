import { describe, expect, it } from "vitest";
import { HarnessError } from "../src/index.js";
import {
  createApiBackendProvider,
  createModelHub,
  createOpenAIEmbeddingProvider,
  createStaticLocalModelSource,
  type EmbeddingUsageEvent,
} from "../src/models/index.js";
import { createSqliteModelsStore } from "../src/models/sqlite/index.js";
import { openNodeSqliteDatabase } from "../src/store/sqlite/node.js";

describe("createOpenAIEmbeddingProvider (standalone)", () => {
  it("calls POST /embeddings, sorts by index, L2-normalizes by default, reports usage, and computes stable fingerprints", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const usageEvents: EmbeddingUsageEvent[] = [];
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
          usage: {
            prompt_tokens: 12,
            total_tokens: 12,
          },
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
      onUsage: (event) => usageEvents.push(event),
      fetch: mockFetch,
    });

    // Empty input short-circuits without hitting network.
    expect(await embedder.embed([])).toEqual({ embeddings: [] });
    expect(requests).toHaveLength(0);

    const { embeddings: vectors, usage } = await embedder.embed(["first", "second"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-live-secret");
    expect(requests[0]!.body).toEqual({
      model: "text-embedding-3-small",
      input: ["first", "second"],
      encoding_format: "float",
      dimensions: 2,
    });
    expect(usage).toEqual({ promptTokens: 12, totalTokens: 12 });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      providerId: "openai",
      modelId: "text-embedding-3-small",
      inputCount: 2,
      usage: { promptTokens: 12, totalTokens: 12 },
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
    expect(raw.embeddings).toEqual([
      [3, 4],
      [0, 5],
    ]);
    expect(raw.usage).toEqual({ promptTokens: 12, totalTokens: 12 });
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

  it("enforces fixed vs variable dimensions, supports maxBatchSize chunking, encodingFormat: null, and custom endpoint", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const usageEvents: EmbeddingUsageEvent[] = [];
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      const inputs = body.input as string[];
      return new Response(
        JSON.stringify({
          data: inputs.map((_, idx) => ({ index: idx, embedding: [3, 4] })),
          usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    // 1. Fixed-dimension model: never sends dimensions in request body; incompatible override throws upfront.
    const fixedModel = {
      id: "nomic-embed-text",
      name: "Nomic Embed",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      endpoint: "/custom-embed",
      dimensions: 768,
      supportsDimensions: false,
      maxBatchSize: 2,
      encodingFormat: null as null,
    };

    expect(() =>
      createOpenAIEmbeddingProvider({
        modelId: fixedModel.id,
        model: fixedModel,
        allowKeyless: true,
        dimensions: 512,
        fetch: mockFetch,
      }),
    ).toThrow(HarnessError);

    const fixedEmbedder = createOpenAIEmbeddingProvider({
      modelId: fixedModel.id,
      model: fixedModel,
      allowKeyless: true,
      onUsage: (e) => usageEvents.push(e),
      fetch: mockFetch,
    });

    await expect(fixedEmbedder.embed(["a"], { dimensions: 512 })).rejects.toThrow(HarnessError);
    expect(requests).toHaveLength(0);

    // 5 inputs with maxBatchSize=2 -> 3 sequential batches (2, 2, 1), aggregated usage, no encoding_format or dimensions.
    const batched = await fixedEmbedder.embed(["t1", "t2", "t3", "t4", "t5"]);
    expect(batched.embeddings).toHaveLength(5);
    expect(batched.usage).toEqual({ promptTokens: 50, totalTokens: 50 });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.inputCount).toBe(5);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:11434/v1/custom-embed",
        body: { model: "nomic-embed-text", input: ["t1", "t2"] },
      },
      {
        url: "http://127.0.0.1:11434/v1/custom-embed",
        body: { model: "nomic-embed-text", input: ["t3", "t4"] },
      },
      { url: "http://127.0.0.1:11434/v1/custom-embed", body: { model: "nomic-embed-text", input: ["t5"] } },
    ]);

    // 2. Variable-dimension model (supportsDimensions: true): sends configured/overridden dimensions.
    requests.length = 0;
    const varEmbedder = createOpenAIEmbeddingProvider({
      modelId: "text-embedding-3-small",
      model: {
        id: "text-embedding-3-small",
        name: "OpenAI Embedding 3 Small",
        provider: "gw",
        baseUrl: "https://gw.example.com/openai/v1",
        dimensions: 1536,
        supportsDimensions: true,
      },
      allowKeyless: true,
      fetch: mockFetch,
    });
    await varEmbedder.embed(["a"]);
    await varEmbedder.embed(["b"], { dimensions: 512 });
    expect(requests[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["a"],
      encoding_format: "float",
      dimensions: 1536,
    });
    expect(requests[1]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["b"],
      encoding_format: "float",
      dimensions: 512,
    });
  });

  it("discovers top-level embeddings from GET /models, persists them offline in SqliteModelsStore, and coexists with local Ollama embeddings", async () => {
    const db = await openNodeSqliteDatabase(":memory:");
    try {
      let catalogFetchCount = 0;
      const seenRequests: Array<{
        url: string;
        headers: Record<string, string>;
        body?: Record<string, unknown>;
      }> = [];

      const mockFetch: typeof globalThis.fetch = async (input, init) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        seenRequests.push({ url, headers, body });

        if (url === "https://gw.example.com/v1/models") {
          catalogFetchCount += 1;
          return new Response(
            JSON.stringify({
              object: "list",
              data: [
                {
                  id: "claude-sonnet-4-5",
                  type: "model", // Ensure standard non-"chat" upstream type values are never dropped.
                  api: "anthropic-messages",
                  baseUrl: "https://gw.example.com/anthropic",
                },
              ],
              embeddings: [
                {
                  id: "text-embedding-3-small",
                  name: "OpenAI Embedding 3 Small",
                  baseUrl: "https://gw.example.com/openai/v1",
                  dimensions: 1536,
                  supportsDimensions: true,
                  maxInputTokens: 8191,
                  maxBatchSize: 2048,
                  cost: { input: 0.02 },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url.endsWith("/embeddings")) {
          return new Response(
            JSON.stringify({
              data: [{ index: 0, embedding: [3, 4] }],
              usage: { prompt_tokens: 4, total_tokens: 4 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response("Not Found", { status: 404 });
      };

      const makeGateway = () =>
        createApiBackendProvider({
          id: "my-gateway",
          baseUrl: "https://gw.example.com/v1",
          getAuth: async () => ({
            apiKey: "jwt-1",
            headers: { "x-gateway-token": "jwt-1" },
          }),
          fetch: mockFetch,
        });

      const localOllama = createStaticLocalModelSource({
        providers: {
          "ollama-local": {
            baseUrl: "http://127.0.0.1:11434/v1",
            embeddingModels: [
              {
                id: "nomic-embed-text",
                name: "Nomic Embed Text",
                dimensions: 768,
                supportsDimensions: false,
                maxInputTokens: 8192,
                maxBatchSize: 32,
                encodingFormat: null,
              },
            ],
          },
        },
      });

      const hub1 = createModelHub({
        modelsStore: createSqliteModelsStore(db),
        providers: [makeGateway()],
        localSources: [localOllama],
        fetch: mockFetch,
      });

      await hub1.init({ allowNetwork: true });
      expect(catalogFetchCount).toBe(1);
      expect(hub1.getModels("my-gateway").map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);

      const available1 = await hub1.getAvailableEmbeddingModels();
      expect(available1.map((m) => `${m.provider}/${m.id}`).sort()).toEqual([
        "my-gateway/text-embedding-3-small",
        "ollama-local/nomic-embed-text",
      ]);

      // Call remote gateway embedding & local Ollama embedding.
      await hub1.createEmbeddingProvider("my-gateway", "text-embedding-3-small").embed(["hello"]);
      await hub1.createEmbeddingProvider("ollama-local", "nomic-embed-text").embed(["world"]);

      const gwEmbedReq = seenRequests.find((r) => r.url === "https://gw.example.com/openai/v1/embeddings");
      expect(gwEmbedReq?.headers["x-gateway-token"]).toBe("jwt-1");
      expect(gwEmbedReq?.body).toEqual({
        model: "text-embedding-3-small",
        input: ["hello"],
        encoding_format: "float",
        dimensions: 1536,
      });

      const ollamaEmbedReq = seenRequests.find((r) => r.url === "http://127.0.0.1:11434/v1/embeddings");
      expect(ollamaEmbedReq?.headers.authorization).toBeUndefined();
      expect(ollamaEmbedReq?.body).toEqual({
        model: "nomic-embed-text",
        input: ["world"],
      });

      // Simulate restart completely offline: fresh ModelHub restores remote embeddings from SqliteModelsStore!
      const hub2 = createModelHub({
        modelsStore: createSqliteModelsStore(db),
        providers: [makeGateway()],
        localSources: [localOllama],
        fetch: mockFetch,
      });
      await hub2.init({ allowNetwork: false });
      expect(catalogFetchCount).toBe(1); // Zero network requests!

      expect(hub2.getModels("my-gateway").map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);
      const restored = hub2.getEmbeddingModel("my-gateway", "text-embedding-3-small");
      expect(restored).toEqual({
        id: "text-embedding-3-small",
        name: "OpenAI Embedding 3 Small",
        provider: "my-gateway",
        baseUrl: "https://gw.example.com/openai/v1",
        dimensions: 1536,
        supportsDimensions: true,
        maxInputTokens: 8191,
        maxBatchSize: 2048,
        cost: { input: 0.02 },
      });
      expect((await hub2.getAvailableEmbeddingModels()).map((m) => `${m.provider}/${m.id}`).sort()).toEqual([
        "my-gateway/text-embedding-3-small",
        "ollama-local/nomic-embed-text",
      ]);
    } finally {
      await db.close();
    }
  });
});
