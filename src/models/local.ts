import {
  isModelType,
  type AnyModel,
  type Api,
  type Model,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { HarnessError } from "../types.js";
import { createApiBackendProvider } from "./backend.js";
import { resolveConfigHeaders, resolveConfigValue, type ConfigValueResolverOptions } from "./config-value.js";

export interface LocalModelDefinition {
  readonly id: string;
  readonly name?: string;
  readonly api?: Api;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: Partial<Model<Api>["cost"]>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: Model<Api>["compat"];
}

export interface LocalModelOverride {
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: Partial<Model<Api>["cost"]>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: Model<Api>["compat"];
}

export interface LocalProviderConfig {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly api?: Api;
  /** Literal key or `$ENV` / `${ENV}` reference. Omit for keyless local servers (e.g. Ollama/vLLM). */
  readonly apiKey?: string;
  /** Explicitly allow keyless operation (defaults to `true` for newly created local providers without `apiKey`). */
  readonly allowKeyless?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: Model<Api>["compat"];
  /**
   * When `true` on a custom/local provider, `models.refresh()` probes `{baseUrl}{modelsEndpoint ?? "/models"}`
   * and merges discovered models with static `models` and `modelOverrides`.
   */
  readonly discover?: boolean;
  readonly modelsEndpoint?: string;
  readonly models?: readonly LocalModelDefinition[];
  readonly modelOverrides?: Readonly<Record<string, LocalModelOverride>>;
}

export interface LocalModelsConfig {
  readonly providers: Readonly<Record<string, LocalProviderConfig>>;
}

/**
 * Abstract source for loading local model configurations (JSON file, SQLite settings,
 * UI state, remote config service, etc.).
 */
export interface LocalModelSource {
  readonly name?: string;
  load(signal?: AbortSignal): Promise<LocalModelsConfig> | LocalModelsConfig;
}

/** Wrap an in-memory `LocalModelsConfig` object as a `LocalModelSource`. */
export function createStaticLocalModelSource(
  config: LocalModelsConfig,
  name = "static",
): LocalModelSource {
  return {
    name,
    load: () => structuredClone(config),
  };
}

const DEFAULT_LOCAL_OPENAI_COMPAT: NonNullable<Model<Api>["compat"]> = {
  supportsStore: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
};

function mergeCompat(
  base: Model<Api>["compat"],
  override: Model<Api>["compat"],
): Model<Api>["compat"] {
  if (!override) return base;
  if (!base) return structuredClone(override);
  return { ...base, ...override } as Model<Api>["compat"];
}

function mergeStringHeaders(
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === lower) {
        delete merged[existing];
      }
    }
    merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeProviderHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged: ProviderHeaders = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === lower) {
        delete merged[existing];
      }
    }
    merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function applyModelOverride(model: Model<Api>, override: LocalModelOverride): Model<Api> {
  return {
    ...model,
    name: override.name ?? model.name,
    reasoning: override.reasoning ?? model.reasoning,
    input: override.input ? [...override.input] : model.input,
    contextWindow: override.contextWindow ?? model.contextWindow,
    maxTokens: override.maxTokens ?? model.maxTokens,
    cost: override.cost
      ? {
          input: override.cost.input ?? model.cost.input,
          output: override.cost.output ?? model.cost.output,
          cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
          cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
        }
      : model.cost,
    headers: mergeStringHeaders(model.headers, override.headers),
    compat: mergeCompat(model.compat, override.compat),
  };
}

function buildStaticModel(
  providerId: string,
  definition: LocalModelDefinition,
  config: LocalProviderConfig,
  fallbackBaseUrl: string | undefined,
  fallbackApi: Api | undefined,
  defaultCompat: Model<Api>["compat"],
): Model<Api> {
  const api = definition.api ?? config.api ?? fallbackApi ?? "openai-completions";
  const baseUrl = definition.baseUrl ?? config.baseUrl ?? fallbackBaseUrl;
  if (!baseUrl) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `Local provider "${providerId}", model "${definition.id}": "baseUrl" is required.`,
    );
  }
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    input: definition.input ? [...definition.input] : ["text"],
    contextWindow: definition.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? 16_384,
    cost: {
      input: definition.cost?.input ?? 0,
      output: definition.cost?.output ?? 0,
      cacheRead: definition.cost?.cacheRead ?? 0,
      cacheWrite: definition.cost?.cacheWrite ?? 0,
    },
    ...(definition.headers ? { headers: { ...definition.headers } } : {}),
    compat: mergeCompat(mergeCompat(defaultCompat, config.compat), definition.compat),
  };
}

/** Merge multiple `LocalModelsConfig` objects in order (later sources override earlier ones). */
export function mergeLocalModelsConfigs(configs: readonly LocalModelsConfig[]): LocalModelsConfig {
  const providers: Record<string, LocalProviderConfig> = {};

  for (const config of configs) {
    for (const [providerId, next] of Object.entries(config.providers ?? {})) {
      const prev = providers[providerId];
      if (!prev) {
        providers[providerId] = structuredClone(next);
        continue;
      }

      const mergedModels = [...(prev.models ?? [])];
      for (const def of next.models ?? []) {
        const idx = mergedModels.findIndex((m) => m.id === def.id);
        if (idx >= 0) mergedModels[idx] = structuredClone(def);
        else mergedModels.push(structuredClone(def));
      }

      const mergedOverrides: Record<string, LocalModelOverride> = {
        ...structuredClone(prev.modelOverrides ?? {}),
      };
      for (const [modelId, override] of Object.entries(next.modelOverrides ?? {})) {
        mergedOverrides[modelId] = {
          ...(mergedOverrides[modelId] ?? {}),
          ...structuredClone(override),
        };
      }

      providers[providerId] = {
        ...prev,
        ...next,
        headers: mergeStringHeaders(prev.headers, next.headers),
        compat: mergeCompat(prev.compat, next.compat),
        ...(mergedModels.length > 0 ? { models: mergedModels } : {}),
        ...(Object.keys(mergedOverrides).length > 0 ? { modelOverrides: mergedOverrides } : {}),
      };
    }
  }

  return { providers };
}

export interface ComposeLocalProviderOptions {
  readonly configResolver?: Omit<ConfigValueResolverOptions, "signal">;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiStreams?: Partial<Record<Api, ProviderStreams>>;
}

function applyProviderLevelOverlays<TModel extends AnyModel>(
  providerId: string,
  models: readonly TModel[],
  config: LocalProviderConfig,
): TModel[] {
  const next: AnyModel[] = models.map((model) => {
    const baseUrl = config.baseUrl ?? model.baseUrl;
    if (!isModelType(model, "chat")) {
      return { ...model, baseUrl };
    }
    let updated: Model<Api> = {
      ...model,
      baseUrl,
      compat: mergeCompat(model.compat, config.compat),
    };
    const override = config.modelOverrides?.[updated.id];
    if (override) {
      updated = applyModelOverride(updated, override);
    }
    return updated;
  });

  const firstChat = next.find((m): m is Model<Api> => isModelType(m, "chat"));
  for (const def of config.models ?? []) {
    const built = buildStaticModel(
      providerId,
      def,
      config,
      firstChat?.baseUrl,
      firstChat?.api,
      undefined,
    );
    const override = config.modelOverrides?.[built.id];
    const finalModel = override ? applyModelOverride(built, override) : built;
    const idx = next.findIndex((m) => isModelType(m, "chat") && m.id === finalModel.id);
    if (idx >= 0) next[idx] = finalModel;
    else next.push(finalModel);
  }

  return next as TModel[];
}

/**
 * Compile a `LocalProviderConfig` into a `pi-ai` `Provider`:
 * - When `baseProvider` is present, overlays `baseUrl`, `headers`, `compat`, `apiKey`, `models`, and `modelOverrides`
 *   while preserving `baseProvider`'s OAuth/streaming/refresh capabilities.
 * - When `baseProvider` is absent, creates a standalone local/custom provider (with optional `/models` discovery).
 */
export function composeLocalProvider(
  providerId: string,
  baseProvider: Provider<Api> | undefined,
  config: LocalProviderConfig,
  options: ComposeLocalProviderOptions = {},
): Provider<Api> {
  if (!baseProvider) {
    if (!config.baseUrl?.trim()) {
      throw new HarnessError(
        "INVALID_OPTIONS",
        `Local provider "${providerId}" is not a built-in provider and requires "baseUrl".`,
      );
    }
    const defaultApi = config.api ?? "openai-completions";
    const defaultCompat = defaultApi === "openai-completions" ? DEFAULT_LOCAL_OPENAI_COMPAT : undefined;
    const staticModels = (config.models ?? []).map((def) => {
      const built = buildStaticModel(providerId, def, config, config.baseUrl, defaultApi, defaultCompat);
      const override = config.modelOverrides?.[built.id];
      return override ? applyModelOverride(built, override) : built;
    });
    const declaredApis = new Set<Api>([defaultApi]);
    for (const m of staticModels) declaredApis.add(m.api);

    const provider = createApiBackendProvider({
      id: providerId,
      name: config.name ?? providerId,
      baseUrl: config.baseUrl,
      defaultApi,
      apis: [...declaredApis],
      apiStreams: options.apiStreams,
      headers: config.headers,
      apiKey: config.apiKey,
      allowKeyless: config.allowKeyless ?? config.apiKey === undefined,
      models: staticModels,
      modelsEndpoint: config.discover ? (config.modelsEndpoint ?? "/models") : null,
      modelDefaults: {
        compat: mergeCompat(defaultCompat, config.compat),
      },
      fetch: options.fetch,
      configResolver: options.configResolver,
    });

    if (!config.modelOverrides || Object.keys(config.modelOverrides).length === 0) {
      return provider;
    }

    const applyOverridesToList = <TModel extends AnyModel>(list: readonly TModel[]): TModel[] =>
      list.map((m) => {
        if (!isModelType(m, "chat")) return m;
        const ov = config.modelOverrides?.[m.id];
        return (ov ? applyModelOverride(m, ov) : m) as TModel;
      });

    return {
      ...provider,
      getModels: () => applyOverridesToList(provider.getModels()),
      ...(provider.getAllModels
        ? { getAllModels: () => applyOverridesToList(provider.getAllModels!()) }
        : {}),
    };
  }

  // Overlay onto an existing (built-in or backend) provider.
  const baseApiKeyAuth = baseProvider.auth.apiKey;
  const wrappedApiKeyAuth =
    baseApiKeyAuth || config.apiKey !== undefined || config.headers !== undefined || config.baseUrl !== undefined
      ? {
          name: baseApiKeyAuth?.name ?? `${config.name ?? baseProvider.name} API`,
          ...(baseApiKeyAuth?.login ? { login: baseApiKeyAuth.login } : {}),
          ...(baseApiKeyAuth?.check && config.apiKey === undefined ? { check: baseApiKeyAuth.check } : {}),
          resolve: async (input: Parameters<NonNullable<Provider["auth"]["apiKey"]>["resolve"]>[0]) => {
            const extraHeaders = await resolveConfigHeaders(config.headers, {
              ...options.configResolver,
              signal: input.signal,
            });
            const baseResolved = baseApiKeyAuth ? await baseApiKeyAuth.resolve(input) : undefined;
            const configuredKey =
              config.apiKey !== undefined
                ? await resolveConfigValue(config.apiKey, {
                    ...options.configResolver,
                    signal: input.signal,
                  })
                : undefined;

            const effectiveKey = input.credential?.key ?? baseResolved?.auth.apiKey ?? configuredKey;
            if (!baseResolved && !effectiveKey && !config.allowKeyless) {
              return undefined;
            }
            const mergedHeaders = mergeProviderHeaders(baseResolved?.auth.headers, extraHeaders);
            return {
              auth: {
                ...(effectiveKey !== undefined
                  ? { apiKey: effectiveKey }
                  : config.allowKeyless
                    ? { apiKey: "local" }
                    : {}),
                ...(mergedHeaders ? { headers: mergedHeaders } : {}),
                ...(config.baseUrl ?? baseResolved?.auth.baseUrl
                  ? { baseUrl: config.baseUrl ?? baseResolved?.auth.baseUrl }
                  : {}),
              },
              ...(baseResolved?.env ? { env: baseResolved.env } : {}),
              source: baseResolved?.source ?? (configuredKey ? "local-config" : "keyless"),
            };
          },
        }
      : undefined;

  return {
    ...baseProvider,
    name: config.name ?? baseProvider.name,
    baseUrl: config.baseUrl ?? baseProvider.baseUrl,
    auth: {
      ...(wrappedApiKeyAuth ? { apiKey: wrappedApiKeyAuth } : {}),
      ...(baseProvider.auth.oauth ? { oauth: baseProvider.auth.oauth } : {}),
    },
    getModels: () => applyProviderLevelOverlays(providerId, baseProvider.getModels(), config),
    ...(baseProvider.getAllModels
      ? {
          getAllModels: () => applyProviderLevelOverlays(providerId, baseProvider.getAllModels!(), config),
        }
      : {}),
  };
}
