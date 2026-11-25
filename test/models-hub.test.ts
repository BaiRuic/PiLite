import {
  type AuthInteraction,
  contentText,
  createProvider,
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
});
