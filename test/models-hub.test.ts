import {
  type AuthInteraction,
  contentText,
  createProvider,
  getSupportedThinkingLevels,
  hasApi,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createSession, HarnessError, InMemorySessionStore } from "../src/index.js";
import {
  createApiBackendProvider,
  createModelHub,
  createStaticLocalModelSource,
  type LocalModelSource,
  type LocalModelsConfig,
  resolveConfigValue,
} from "../src/models/index.js";
import { createSqliteCredentialStore, createSqliteModelsStore } from "../src/models/sqlite/index.js";
import { SqliteSessionStore } from "../src/store/sqlite/index.js";
import { openNodeSqliteDatabase } from "../src/store/sqlite/node.js";
import { registerCredentialStoreContract, registerModelsStoreContract } from "../src/testing.js";

registerCredentialStoreContract(
  { describe, it, expect },
  "SqliteCredentialStore (node:sqlite :memory:)",
  async (use) => {
    const db = await openNodeSqliteDatabase(":memory:");
    try {
      await use(createSqliteCredentialStore(db));
    } finally {
      await db.close();
    }
  },
);

registerModelsStoreContract(
  { describe, it, expect },
  "SqliteModelsStore (node:sqlite :memory:)",
  async (use) => {
    const db = await openNodeSqliteDatabase(":memory:");
    try {
      await use(createSqliteModelsStore(db));
    } finally {
      await db.close();
    }
  },
);

describe("Config value resolution ($ENV & opt-in !command)", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally tests literal ${VAR} syntax
  it("interpolates $VAR / ${VAR}, supports escaping, and disables !command by default", async () => {
    const env = { API_TOKEN: "tok-123", REGION: "us" };

    expect(await resolveConfigValue("Bearer $API_TOKEN", { env })).toBe("Bearer tok-123");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentionally tests literal ${REGION} interpolation
    expect(await resolveConfigValue("https://${REGION}.example.com", { env })).toBe("https://us.example.com");
    expect(await resolveConfigValue("$$literal-$!bang", { env })).toBe("$literal-!bang");
    expect(await resolveConfigValue("$MISSING_VAR", { env })).toBe(undefined);

    await expect(resolveConfigValue("!echo secret", { env })).rejects.toMatchObject({
      name: "HarnessError",
      code: "INVALID_OPTIONS",
    });

    expect(
      await resolveConfigValue("!get-secret", {
        env,
        execCommand: async (cmd) => (cmd === "get-secret" ? "  from-vault\n" : undefined),
      }),
    ).toBe("from-vault");
  });
});

describe("ModelHub: OAuth login, custom JWT backend, local sources, and hot-swap", () => {
  it("supports interactive OAuth login, persists to SQLite, and auto-refreshes expired tokens across restarts", async () => {
    const db = await openNodeSqliteDatabase(":memory:");
    try {
      // Also open SqliteSessionStore on the SAME db to confirm zero table collisions.
      const sessionStore = await SqliteSessionStore.open(db);
      expect((await sessionStore.list()).items).toEqual([]);

      const credentials = createSqliteCredentialStore(db);
      const modelsStore = createSqliteModelsStore(db);

      let refreshCalls = 0;
      const makeOAuthProvider = () => {
        const faux = fauxProvider({ provider: "sub-oauth", models: [{ id: "sub-1" }] });
        return createProvider({
          id: "sub-oauth",
          name: "Subscription OAuth",
          auth: {
            oauth: {
              name: "Sub OAuth",
              loginLabel: "Sign in with Subscription",
              async login(interaction) {
                interaction.notify({ type: "auth_url", url: "https://auth.example.com/login" });
                const code = await interaction.prompt({
                  type: "manual_code",
                  message: "Paste code",
                });
                const cred: OAuthCredential = {
                  type: "oauth",
                  access: `access-from-${code}`,
                  refresh: `refresh-from-${code}`,
                  // Expired immediately so the next getAuth() exercises locked token refresh.
                  expires: Date.now() - 10_000,
                };
                return cred;
              },
              async refresh(cred) {
                refreshCalls += 1;
                return {
                  ...cred,
                  access: `refreshed-access-${refreshCalls}`,
                  refresh: `refreshed-token-${refreshCalls}`,
                  expires: Date.now() + 3_600_000,
                };
              },
              async toAuth(cred) {
                return { apiKey: cred.access, headers: { "X-Auth-Mode": "oauth" } };
              },
            },
          },
          models: faux.provider.getModels(),
          api: {
            stream: faux.provider.stream,
            streamSimple: faux.provider.streamSimple,
          },
        });
      };

      const hub1 = createModelHub({
        credentials,
        modelsStore,
        providers: [makeOAuthProvider()],
      });

      expect(hub1.listLoginProviders()).toEqual([
        {
          id: "sub-oauth",
          name: "Subscription OAuth",
          supportsOAuth: true,
          supportsApiKeyLogin: false,
          oauthLabel: "Sign in with Subscription",
        },
      ]);

      const seenUrls: string[] = [];
      const interaction: AuthInteraction = {
        notify: (e) => {
          if (e.type === "auth_url") seenUrls.push(e.url);
        },
        prompt: async () => "code-xyz",
      };

      await hub1.login("sub-oauth", "oauth", interaction);
      expect(seenUrls).toEqual(["https://auth.example.com/login"]);

      // Simulate process restart with a fresh ModelHub backed by the same SQLite DB.
      const hub2 = createModelHub({
        credentials: createSqliteCredentialStore(db),
        modelsStore: createSqliteModelsStore(db),
        providers: [makeOAuthProvider()],
      });
      await hub2.init({ allowNetwork: false });

      const resolved = await hub2.getAuth("sub-oauth");
      expect(refreshCalls).toBe(1);
      expect(resolved?.auth.apiKey).toBe("refreshed-access-1");
      expect(resolved?.auth.headers).toEqual({ "X-Auth-Mode": "oauth" });

      // Subsequent getAuth() uses the newly persisted token without refreshing again.
      const resolvedAgain = await hub2.getAuth("sub-oauth");
      expect(refreshCalls).toBe(1);
      expect(resolvedAgain?.auth.apiKey).toBe("refreshed-access-1");
    } finally {
      await db.close();
    }
  });

  it("fetches models from a custom JWT API backend and restores them offline from SqliteModelsStore", async () => {
    const db = await openNodeSqliteDatabase(":memory:");
    try {
      const modelsStore = createSqliteModelsStore(db);
      let currentJwt = "jwt-token-v1";
      let fetchCount = 0;
      const seenHeaders: Array<Record<string, string>> = [];

      const mockFetch: typeof globalThis.fetch = async (input, init) => {
        fetchCount += 1;
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        expect(String(input)).toBe("https://ai.corp.internal/v1/catalog");
        return new Response(
          JSON.stringify({
            items: [
              { id: "corp-fast", name: "Corp Fast", context: 64_000, reasoning: false },
              { id: "corp-reason", name: "Corp Reason", context: 200_000, reasoning: true },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const makeBackend = () =>
        createApiBackendProvider({
          id: "corp-ai",
          name: "Corp AI",
          baseUrl: "https://ai.corp.internal/v1",
          modelsEndpoint: "/catalog",
          getAuth: async () => ({
            apiKey: currentJwt,
            headers: { "X-Tenant": "eng" },
            source: "corp-jwt",
          }),
          parseModels: (raw, defaults) => {
            const body = raw as {
              items: Array<{ id: string; name: string; context: number; reasoning: boolean }>;
            };
            return body.items.map((item) => ({
              id: item.id,
              name: item.name,
              api: defaults.defaultApi,
              provider: defaults.providerId,
              baseUrl: defaults.baseUrl,
              reasoning: item.reasoning,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: item.context,
              maxTokens: 16_384,
            }));
          },
          fetch: mockFetch,
        });

      const hub1 = createModelHub({ modelsStore, providers: [makeBackend()] });
      await hub1.init({ allowNetwork: false });
      expect(hub1.getModels("corp-ai")).toEqual([]);
      expect(fetchCount).toBe(0);

      const refreshed = await hub1.refresh({ allowNetwork: true });
      expect(refreshed.errors.size).toBe(0);
      expect(fetchCount).toBe(1);
      expect(seenHeaders[0]?.authorization ?? seenHeaders[0]?.Authorization).toBe("Bearer jwt-token-v1");
      expect(seenHeaders[0]?.["X-Tenant"]).toBe("eng");
      expect(hub1.getModels("corp-ai").map((m) => m.id)).toEqual(["corp-fast", "corp-reason"]);

      // Rotate JWT and verify live auth reflects the new token immediately.
      currentJwt = "jwt-token-v2";
      const auth = await hub1.getAuth("corp-ai");
      expect(auth?.auth.apiKey).toBe("jwt-token-v2");

      // Restart offline: fresh ModelHub restores the cached catalog from SQLite without hitting fetch!
      const hub2 = createModelHub({
        modelsStore: createSqliteModelsStore(db),
        providers: [makeBackend()],
      });
      await hub2.init({ allowNetwork: false });
      expect(fetchCount).toBe(1);
      expect(hub2.getModels("corp-ai").map((m) => m.id)).toEqual(["corp-fast", "corp-reason"]);
      expect(hub2.getModel("corp-ai", "corp-reason")?.contextWindow).toBe(200_000);
    } finally {
      await db.close();
    }
  });

  it("loads local sources with OpenAI /models auto-discovery, overlays built-ins, and hot-reloads into HarnessSession", async () => {
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 32_000 }],
    });
    faux.setResponses([fauxAssistantMessage("before reload"), fauxAssistantMessage("after reload")]);

    let localConfig: LocalModelsConfig = {
      providers: {
        // Overlay built-in faux provider with proxy baseUrl, header via $ENV, and modelOverrides.
        faux: {
          baseUrl: "https://proxy.local/v1",
          headers: { "X-Proxy-Key": "$PROXY_SECRET" },
          modelOverrides: {
            "faux-1": { contextWindow: 64_000, reasoning: true },
          },
        },
        // Keyless local Ollama server with auto-discovery + override on discovered model.
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          discover: true,
          modelOverrides: {
            "qwen3:32b": { contextWindow: 131_072, reasoning: true },
          },
        },
      },
    };

    const dynamicSource: LocalModelSource = {
      name: "memory-settings",
      load: () => structuredClone(localConfig),
    };

    const mockLocalFetch: typeof globalThis.fetch = async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/models");
      return new Response(
        JSON.stringify({
          data: [{ id: "qwen3:32b" }, { id: "llama3.2:latest" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const hub = createModelHub({
      providers: [faux.provider],
      localSources: [dynamicSource, createStaticLocalModelSource({ providers: {} })],
      configResolver: { env: { PROXY_SECRET: "secret-42" } },
      fetch: mockLocalFetch,
    });

    await hub.init({ allowNetwork: true });

    // Built-in faux provider received overlay.
    const overlaidFaux = hub.getModel("faux", "faux-1");
    expect(overlaidFaux?.baseUrl).toBe("https://proxy.local/v1");
    expect(overlaidFaux?.contextWindow).toBe(64_000);
    expect(overlaidFaux?.reasoning).toBe(true);
    expect((await hub.getAuth("faux"))?.auth.headers?.["X-Proxy-Key"]).toBe("secret-42");

    // Local Ollama provider discovered models and applied overrides + keyless auth.
    const qwen = hub.getModel("ollama", "qwen3:32b");
    expect(qwen?.contextWindow).toBe(131_072);
    expect(qwen?.reasoning).toBe(true);
    expect(qwen && hasApi(qwen, "openai-completions") && qwen.compat?.supportsStore).toBe(false);
    expect((await hub.getAuth("ollama"))?.auth.apiKey).toBe("local");

    // Wire hub into HarnessSession via hot-swappable ModelsProvider.
    const session = await createSession({
      sessionId: "sess-hub-hot-reload",
      models: hub.asModelsProvider(),
      store: new InMemorySessionStore(),
      model: { provider: "faux", modelId: "faux-1" },
    });

    const r1 = await session.prompt("hi 1");
    expect(contentText(r1.snapshot.messages.at(-1)!.content as any)).toBe("before reload");

    // Mutate local config and reload -> session picks up updated model metadata immediately!
    localConfig = {
      providers: {
        faux: {
          modelOverrides: {
            "faux-1": { contextWindow: 256_000 },
          },
        },
      },
    };
    await hub.reload({ allowNetwork: false });
    expect(hub.getModel("faux", "faux-1")?.contextWindow).toBe(256_000);
    expect(hub.getProvider("ollama")).toBe(undefined);

    const r2 = await session.prompt("hi 2");
    expect(contentText(r2.snapshot.messages.at(-1)!.content as any)).toBe("after reload");
    expect(r2.status).toBe("idle");
  });

  it("rejects empty provider IDs cleanly with HarnessError", () => {
    expect(() => createApiBackendProvider({ id: " ", baseUrl: "https://example.com/v1" })).toThrow(
      HarnessError,
    );
  });

  it("preserves refreshed dynamic provider models when setProvider/removeProvider mutates another provider", async () => {
    const dynamicBackend = createApiBackendProvider({
      id: "corp-dynamic",
      baseUrl: "https://corp.example.com/v1",
      apiKey: "tok",
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ id: "corp-model-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const extraFaux = fauxProvider({ provider: "extra-faux", models: [{ id: "extra-1" }] });

    const hub = createModelHub({ providers: [dynamicBackend] });
    await hub.refresh();
    expect(hub.getModel("corp-dynamic", "corp-model-1")).toBeDefined();

    // Adding and removing an unrelated provider must not wipe corp-dynamic's refreshed catalog.
    hub.setProvider(extraFaux.provider);
    expect(hub.getModel("extra-faux", "extra-1")).toBeDefined();
    expect(hub.getModel("corp-dynamic", "corp-model-1")).toBeDefined();

    hub.removeProvider("extra-faux");
    expect(hub.getModel("extra-faux", "extra-1")).toBeUndefined();
    expect(hub.getModel("corp-dynamic", "corp-model-1")).toBeDefined();
  });

  it("passes through per-model pi-ai metadata fields (compat, thinkingLevelMap, headers, promptCache, inputLimits, samplingParams)", async () => {
    const backend = createApiBackendProvider({
      id: "cf-gateway",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "jwt-token",
      modelDefaults: {
        compat: { supportsStore: false, supportsDeveloperRole: false },
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "deepseek-r1",
                api: "openai-completions",
                baseUrl: "https://gw.example.com/deepseek/v1",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 128_000,
                maxTokens: 32_000,
                cost: {
                  input: 0.55,
                  output: 2.19,
                  cacheRead: 0.14,
                  cacheWrite: 0,
                  tiers: [
                    {
                      inputTokensAbove: 200_000,
                      input: 1.1,
                      output: 4.38,
                      cacheRead: 0.28,
                      cacheWrite: 0,
                    },
                  ],
                },
                compat: { thinkingFormat: "deepseek", supportsDeveloperRole: true },
                thinkingLevelMap: { xhigh: "xhigh", minimal: null },
                headers: { "x-model-tier": "pro", "x-ignored-non-string": 123 },
                promptCache: { short: 300, long: 3600 },
                inputLimits: { maxRequestBytes: 20_000_000, images: { maxPerRequest: 10 } },
                samplingParams: { temperature: 0.3 },
                samplingParamsByThinkingLevel: { high: { temperature: 0.1 } },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const hub = createModelHub({ providers: [backend] });
    await hub.refresh();

    const model = hub.getModel("cf-gateway", "deepseek-r1");
    expect(model).toBeDefined();
    expect(model?.baseUrl).toBe("https://gw.example.com/deepseek/v1");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.cost.tiers).toEqual([
      {
        inputTokensAbove: 200_000,
        input: 1.1,
        output: 4.38,
        cacheRead: 0.28,
        cacheWrite: 0,
      },
    ]);
    // Per-model compat merges over modelDefaults.compat.
    expect(model?.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: true,
      thinkingFormat: "deepseek",
    });
    expect(model?.headers).toEqual({ "x-model-tier": "pro" });
    expect(model?.thinkingLevelMap).toEqual({ xhigh: "xhigh", minimal: null });
    expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(model?.promptCache).toEqual({ short: 300, long: 3600 });
    expect(model?.inputLimits).toEqual({ maxRequestBytes: 20_000_000, images: { maxPerRequest: 10 } });
    expect(model?.samplingParams).toEqual({ temperature: 0.3 });
    expect(model?.samplingParamsByThinkingLevel).toEqual({ high: { temperature: 0.1 } });
  });

  it("supports multi-protocol gateways by default without clobbering per-model baseUrl", async () => {
    const dispatched: Array<{ api: string; baseUrl: string; modelId: string }> = [];
    const makeSpyStream = (apiName: string) => {
      const faux = fauxProvider({ provider: "cf-multi", models: [{ id: "dummy" }] });
      return {
        stream: (model: any, context: any, options: any) => {
          dispatched.push({ api: apiName, baseUrl: model.baseUrl, modelId: model.id });
          faux.setResponses([fauxAssistantMessage(`ok:${apiName}:${model.baseUrl}`)]);
          return faux.provider.stream(model, context, options);
        },
        streamSimple: (model: any, context: any, options: any) => {
          dispatched.push({ api: apiName, baseUrl: model.baseUrl, modelId: model.id });
          faux.setResponses([fauxAssistantMessage(`ok:${apiName}:${model.baseUrl}`)]);
          return faux.provider.streamSimple(model, context, options);
        },
      };
    };

    let overrideBaseUrl: string | undefined;
    const backend = createApiBackendProvider({
      id: "cf-multi",
      baseUrl: "https://gw.example.com/v1",
      getAuth: async () => ({
        apiKey: "jwt-token",
        headers: { "x-gateway-token": "jwt-token" },
        ...(overrideBaseUrl ? { baseUrl: overrideBaseUrl } : {}),
      }),
      // Inject spies via apiStreams without passing `apis` so default 4-API wiring is exercised too.
      apiStreams: {
        "anthropic-messages": makeSpyStream("anthropic-messages"),
        "openai-responses": makeSpyStream("openai-responses"),
        "google-generative-ai": makeSpyStream("google-generative-ai"),
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-sonnet-4-5",
                api: "anthropic-messages",
                baseUrl: "https://gw.example.com/anthropic",
              },
              {
                id: "gpt-5.4",
                api: "openai-responses",
                baseUrl: "https://gw.example.com/openai/v1",
              },
              {
                id: "gemini-2.5-pro",
                api: "google-generative-ai",
                baseUrl: "https://gw.example.com/google/v1beta",
              },
              {
                id: "default-openai-model",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const hub = createModelHub({ providers: [backend] });
    await hub.refresh();

    // Without explicit getAuth().baseUrl, auth.baseUrl is undefined so per-model baseUrl is preserved.
    const auth = await hub.getAuth("cf-multi");
    expect(auth?.auth.baseUrl).toBeUndefined();
    expect(auth?.auth.headers?.["x-gateway-token"]).toBe("jwt-token");
    expect(hub.getModel("cf-multi", "default-openai-model")?.baseUrl).toBe("https://gw.example.com/v1");

    // Stream through pi-ai Models to confirm each model keeps its own protocol & baseUrl.
    const claude = hub.getModel("cf-multi", "claude-sonnet-4-5")!;
    const gpt = hub.getModel("cf-multi", "gpt-5.4")!;
    const gemini = hub.getModel("cf-multi", "gemini-2.5-pro")!;

    await hub.models
      .streamSimple(claude, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })
      .result();
    await hub.models
      .streamSimple(gpt, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })
      .result();
    await hub.models
      .streamSimple(gemini, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })
      .result();

    expect(dispatched).toEqual([
      {
        api: "anthropic-messages",
        baseUrl: "https://gw.example.com/anthropic",
        modelId: "claude-sonnet-4-5",
      },
      { api: "openai-responses", baseUrl: "https://gw.example.com/openai/v1", modelId: "gpt-5.4" },
      {
        api: "google-generative-ai",
        baseUrl: "https://gw.example.com/google/v1beta",
        modelId: "gemini-2.5-pro",
      },
    ]);

    // When getAuth() explicitly returns a baseUrl, it intentionally overrides the request baseUrl.
    overrideBaseUrl = "https://staging-gw.example.com/override";
    await hub.models
      .streamSimple(claude, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })
      .result();
    expect(dispatched.at(-1)).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://staging-gw.example.com/override",
      modelId: "claude-sonnet-4-5",
    });
  });
});
