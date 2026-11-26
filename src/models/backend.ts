import {
  type Api,
  type ApiKeyCredential,
  type AuthContext,
  createProvider,
  type Model,
  type OAuthAuth,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { HarnessError } from "../types.js";
import { buildApiStreamMap, STANDARD_LAZY_APIS } from "./api-streams.js";
import { type ConfigValueResolverOptions, resolveConfigHeaders, resolveConfigValue } from "./config-value.js";

export interface BackendAuthResult {
  readonly apiKey?: string;
  readonly headers?: ProviderHeaders;
  readonly baseUrl?: string;
  readonly source?: string;
}

export interface BackendAuthContext {
  readonly credential?: ApiKeyCredential;
  readonly authContext: AuthContext;
  readonly signal: AbortSignal;
}

export interface ParsedModelDefaults {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly defaultApi: Api;
  readonly modelDefaults?: Partial<
    Pick<Model<Api>, "reasoning" | "input" | "contextWindow" | "maxTokens" | "cost" | "compat">
  >;
}

export interface ApiBackendProviderOptions {
  /** Unique provider ID used in `ModelRef = { provider: id, modelId }`. */
  readonly id: string;
  /** Display name (defaults to `id`). */
  readonly name?: string;
  /** Base API URL, e.g. `"https://ai.mycompany.com/v1"`. */
  readonly baseUrl: string;
  /** Default wire protocol for discovered models. Defaults to `"openai-completions"`. */
  readonly defaultApi?: Api;
  /**
   * Wire protocols this backend can serve.
   * Defaults to all four standard lazy chat APIs (`openai-completions`, `openai-responses`,
   * `anthropic-messages`, `google-generative-ai`).
   */
  readonly apis?: readonly Api[];
  /** Custom stream implementations keyed by wire API. */
  readonly apiStreams?: Partial<Record<Api, ProviderStreams>>;
  /** Static headers sent on both model discovery and inference requests. Supports `$ENV` interpolation. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Dynamic auth resolver (ideal for JWT, rotating session tokens, tenant headers, etc.).
   * Invoked on every request and catalog refresh.
   */
  readonly getAuth?: (
    ctx: BackendAuthContext,
  ) => Promise<BackendAuthResult | undefined> | BackendAuthResult | undefined;
  /** Shorthand API key (literal or `$ENV`) when `getAuth` is not provided. */
  readonly apiKey?: string;
  /** Allow requests without an API key (e.g. trusted internal/local endpoints). Defaults to `false`. */
  readonly allowKeyless?: boolean;
  /** Optional custom OAuth flow if the backend supports OAuth login. */
  readonly oauth?: OAuthAuth;
  /** Static baseline models (used offline before first refresh or as fallback). */
  readonly models?: readonly Model<Api>[];
  /**
   * Relative path or absolute URL for fetching models. Defaults to `"/models"`.
   * Set to `null` to disable remote model discovery when `fetchModels` is not supplied.
   */
  readonly modelsEndpoint?: string | null;
  /** Default metadata applied to discovered models when the backend omits fields. */
  readonly modelDefaults?: ParsedModelDefaults["modelDefaults"];
  /** Fully custom model catalog fetcher. Overrides `modelsEndpoint` + `parseModels`. */
  readonly fetchModels?: (
    ctx: RefreshModelsContext & { readonly baseUrl: string; readonly headers: ProviderHeaders },
  ) => Promise<readonly Model<Api>[]>;
  /** Custom parser for the JSON response returned by `modelsEndpoint`. */
  readonly parseModels?: (payload: unknown, defaults: ParsedModelDefaults) => readonly Model<Api>[];
  /** Injectable `fetch` implementation (defaults to `globalThis.fetch`). */
  readonly fetch?: typeof globalThis.fetch;
  /** Resolver options for `$ENV` / optional `!command` in `apiKey` and `headers`. */
  readonly configResolver?: Omit<ConfigValueResolverOptions, "signal">;
}

function joinUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedPath}`;
}

function mergeCaseInsensitiveHeaders(...sources: Array<ProviderHeaders | undefined>): ProviderHeaders {
  const result: ProviderHeaders = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(result)) {
        if (existing.toLowerCase() === lower) {
          delete result[existing];
        }
      }
      result[key] = value;
    }
  }
  return result;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const obj = asPlainObject(value);
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Default parser supporting standard OpenAI `GET /models` (`{ data: [...] }`),
 * `{ models: [...] }`, or a plain JSON array of model objects.
 */
export function parseOpenAICompatibleModels(payload: unknown, defaults: ParsedModelDefaults): Model<Api>[] {
  const rawList = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : typeof payload === "object" &&
          payload !== null &&
          Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : undefined;

  if (!rawList) {
    throw new Error(`Invalid model list payload from provider "${defaults.providerId}".`);
  }

  const result: Model<Api>[] = [];
  for (const item of rawList) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;

    const api = (
      typeof record.api === "string" && record.api.trim() ? record.api.trim() : defaults.defaultApi
    ) as Api;
    const baseUrl =
      typeof record.baseUrl === "string" && record.baseUrl.trim() ? record.baseUrl.trim() : defaults.baseUrl;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
    const contextWindow =
      asPositiveNumber(record.contextWindow) ??
      asPositiveNumber(record.context_length) ??
      asPositiveNumber(record.max_model_len) ??
      defaults.modelDefaults?.contextWindow ??
      128_000;
    const maxTokens =
      asPositiveNumber(record.maxTokens) ??
      asPositiveNumber(record.max_completion_tokens) ??
      asPositiveNumber(record.max_output_tokens) ??
      defaults.modelDefaults?.maxTokens ??
      16_384;
    const reasoning =
      typeof record.reasoning === "boolean" ? record.reasoning : (defaults.modelDefaults?.reasoning ?? false);
    const input = Array.isArray(record.input)
      ? record.input.filter((v): v is "text" | "image" => v === "text" || v === "image")
      : (defaults.modelDefaults?.input ?? ["text"]);
    const costRecord =
      typeof record.cost === "object" && record.cost !== null
        ? (record.cost as Partial<Model<Api>["cost"]>)
        : undefined;
    const defaultCost = defaults.modelDefaults?.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };

    const defaultCompat = asPlainObject(defaults.modelDefaults?.compat);
    const recordCompat = asPlainObject(record.compat);
    const mergedCompat =
      defaultCompat || recordCompat
        ? (structuredClone({ ...(defaultCompat ?? {}), ...(recordCompat ?? {}) }) as Model<Api>["compat"])
        : undefined;
    const thinkingLevelMap = asPlainObject(record.thinkingLevelMap) as Model<Api>["thinkingLevelMap"];
    const headers = asStringRecord(record.headers);
    const promptCache = asPlainObject(record.promptCache) as Model<Api>["promptCache"];
    const inputLimits = asPlainObject(record.inputLimits) as Model<Api>["inputLimits"];
    const samplingParams = asPlainObject(record.samplingParams) as Model<Api>["samplingParams"];
    const samplingParamsByThinkingLevel = asPlainObject(
      record.samplingParamsByThinkingLevel,
    ) as Model<Api>["samplingParamsByThinkingLevel"];

    const costTiers = Array.isArray(costRecord?.tiers)
      ? costRecord.tiers
      : Array.isArray(defaultCost.tiers)
        ? defaultCost.tiers
        : undefined;

    result.push({
      id,
      name,
      api,
      provider: defaults.providerId,
      baseUrl,
      reasoning,
      input: input.length > 0 ? input : ["text"],
      contextWindow,
      maxTokens,
      cost: {
        input: costRecord?.input ?? defaultCost.input,
        output: costRecord?.output ?? defaultCost.output,
        cacheRead: costRecord?.cacheRead ?? defaultCost.cacheRead,
        cacheWrite: costRecord?.cacheWrite ?? defaultCost.cacheWrite,
        ...(costTiers ? { tiers: structuredClone(costTiers) } : {}),
      },
      ...(headers ? { headers } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap: structuredClone(thinkingLevelMap) } : {}),
      ...(promptCache ? { promptCache: structuredClone(promptCache) } : {}),
      ...(inputLimits ? { inputLimits: structuredClone(inputLimits) } : {}),
      ...(samplingParams ? { samplingParams: structuredClone(samplingParams) } : {}),
      ...(samplingParamsByThinkingLevel
        ? { samplingParamsByThinkingLevel: structuredClone(samplingParamsByThinkingLevel) }
        : {}),
      ...(mergedCompat ? { compat: mergedCompat } : {}),
    });
  }
  return result;
}

/**
 * Create a `pi-ai` `Provider` backed by a custom HTTP API (JWT, rotating tokens,
 * custom headers, OpenAI/Anthropic compatible endpoints, and automatic `ModelsStore` caching).
 */
export function createApiBackendProvider(options: ApiBackendProviderOptions): Provider<Api> {
  if (!options.id.trim()) {
    throw new HarnessError("INVALID_OPTIONS", "ApiBackendProviderOptions.id must be a non-empty string.");
  }
  if (!options.baseUrl.trim()) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `Provider "${options.id}": baseUrl must be a non-empty string.`,
    );
  }

  const defaultApi: Api = options.defaultApi ?? "openai-completions";
  const declaredApis = new Set<Api>(options.apis ?? STANDARD_LAZY_APIS);
  declaredApis.add(defaultApi);
  for (const model of options.models ?? []) {
    declaredApis.add(model.api);
  }
  const apiMap = buildApiStreamMap([...declaredApis], options.apiStreams);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const resolveStaticHeaders = (signal?: AbortSignal) =>
    resolveConfigHeaders(options.headers, { ...options.configResolver, signal });

  const resolveBackendAuth = async (
    authContext: AuthContext,
    credential: ApiKeyCredential | undefined,
    signal: AbortSignal,
  ): Promise<BackendAuthResult | undefined> => {
    const staticHeaders = await resolveStaticHeaders(signal);

    if (options.getAuth) {
      const resolved = await options.getAuth({ credential, authContext, signal });
      if (!resolved) return undefined;
      const mergedHeaders = mergeCaseInsensitiveHeaders(staticHeaders, resolved.headers);
      return {
        apiKey: resolved.apiKey ?? (options.allowKeyless ? "local" : undefined),
        // Only propagate baseUrl when getAuth() explicitly overrides it;
        // otherwise pi-ai uses each model's own baseUrl (supporting multi-protocol gateways).
        ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
        ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
        source: resolved.source ?? "custom-auth",
      };
    }

    if (credential?.key) {
      return {
        apiKey: credential.key,
        ...(staticHeaders ? { headers: staticHeaders } : {}),
        source: "stored credential",
      };
    }

    if (options.apiKey !== undefined) {
      const resolvedKey = await resolveConfigValue(options.apiKey, { ...options.configResolver, signal });
      if (!resolvedKey) return undefined;
      return {
        apiKey: resolvedKey,
        ...(staticHeaders ? { headers: staticHeaders } : {}),
        source: "configured apiKey",
      };
    }

    if (options.allowKeyless) {
      return {
        apiKey: "local",
        ...(staticHeaders ? { headers: staticHeaders } : {}),
        source: "keyless",
      };
    }

    return undefined;
  };

  const discoveryEnabled = options.fetchModels !== undefined || options.modelsEndpoint !== null;
  const modelsEndpoint = options.modelsEndpoint ?? "/models";

  return createProvider<Api>({
    id: options.id,
    name: options.name ?? options.id,
    baseUrl: options.baseUrl,
    auth: {
      apiKey: {
        name: `${options.name ?? options.id} API`,
        resolve: async ({ ctx, credential, signal }) => {
          const resolved = await resolveBackendAuth(ctx, credential, signal);
          if (!resolved) return undefined;
          return {
            auth: {
              ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
              ...(resolved.headers !== undefined ? { headers: resolved.headers } : {}),
              ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
            },
            ...(resolved.source !== undefined ? { source: resolved.source } : {}),
          };
        },
      },
      ...(options.oauth ? { oauth: options.oauth } : {}),
    },
    models: options.models ? structuredClone(options.models) : [],
    api: apiMap,
    ...(discoveryEnabled
      ? {
          fetchModels: async (ctx: RefreshModelsContext): Promise<readonly Model<Api>[]> => {
            const staticHeaders = await resolveStaticHeaders(ctx.signal);
            let dynamicHeaders: ProviderHeaders | undefined;
            let bearerToken: string | undefined;
            let effectiveBaseUrl = ctx.baseUrl ?? options.baseUrl;

            if (ctx.credential?.type === "oauth") {
              if (options.oauth) {
                const oauthAuth = await options.oauth.toAuth(ctx.credential);
                bearerToken = oauthAuth.apiKey;
                dynamicHeaders = oauthAuth.headers;
                if (oauthAuth.baseUrl) effectiveBaseUrl = oauthAuth.baseUrl;
              } else {
                bearerToken = ctx.credential.access;
              }
            } else if (options.getAuth) {
              const resolved = await options.getAuth({
                credential: ctx.credential,
                authContext: {
                  env: async (name) =>
                    options.configResolver?.env?.[name] ??
                    (typeof globalThis.process !== "undefined" ? globalThis.process.env[name] : undefined),
                  fileExists: async () => false,
                },
                signal: ctx.signal,
              });
              bearerToken = resolved?.apiKey;
              dynamicHeaders = resolved?.headers;
              if (resolved?.baseUrl) effectiveBaseUrl = resolved.baseUrl;
            } else if (ctx.credential?.key) {
              bearerToken = ctx.credential.key;
            } else if (options.apiKey !== undefined) {
              bearerToken = await resolveConfigValue(options.apiKey, {
                ...options.configResolver,
                signal: ctx.signal,
              });
            }

            const hasExplicitAuthHeader = Boolean(
              Object.keys(staticHeaders ?? {}).some((k) => k.toLowerCase() === "authorization") ||
                Object.keys(dynamicHeaders ?? {}).some((k) => k.toLowerCase() === "authorization"),
            );
            const requestHeaders = mergeCaseInsensitiveHeaders(
              { accept: "application/json" },
              staticHeaders,
              dynamicHeaders,
              bearerToken && bearerToken !== "local" && !hasExplicitAuthHeader
                ? { authorization: `Bearer ${bearerToken}` }
                : undefined,
            );

            if (options.fetchModels) {
              return options.fetchModels({
                ...ctx,
                baseUrl: effectiveBaseUrl,
                headers: requestHeaders,
              });
            }

            if (!fetchImpl) {
              throw new HarnessError("INVALID_OPTIONS", "No global fetch implementation available.");
            }
            const url = joinUrl(effectiveBaseUrl, modelsEndpoint);
            const response = await fetchImpl(url, {
              headers: requestHeaders as Record<string, string>,
              signal: ctx.signal,
            });
            if (!response.ok) {
              throw new Error(
                `Failed to fetch models from "${url}" for provider "${options.id}": HTTP ${response.status}`,
              );
            }
            const payload = (await response.json()) as unknown;
            const parser = options.parseModels ?? parseOpenAICompatibleModels;
            return parser(payload, {
              providerId: options.id,
              baseUrl: effectiveBaseUrl,
              defaultApi,
              modelDefaults: options.modelDefaults,
            });
          },
        }
      : {}),
  });
}
