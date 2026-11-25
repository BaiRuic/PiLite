import type {
  ApiKeyCredential,
  AuthContext,
  AuthOperationOptions,
  AuthResult,
  Models,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { HarnessError } from "../types.js";
import type { BackendAuthContext, BackendAuthResult } from "./backend.js";
import {
  resolveConfigHeaders,
  resolveConfigValue,
  type ConfigValueResolverOptions,
} from "./config-value.js";

/** Metadata describing a selectable embedding model. */
export interface EmbeddingModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly dimensions?: number;
  readonly maxInputTokens?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EmbeddingOptions {
  readonly signal?: AbortSignal;
  /** Optional output dimension override (supported by e.g. OpenAI `text-embedding-3-*`). */
  readonly dimensions?: number;
}

/** Minimal provider contract for generating dense text embeddings. */
export interface EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  readonly model?: EmbeddingModel;
  readonly dimensions?: number;
  /**
   * Stable non-secret fingerprint (`baseUrl` + `modelId` + `dimensions`).
   * Hosts/vector stores can compare this to detect when an index must be rebuilt.
   */
  fingerprint(): string;
  embed(texts: readonly string[], options?: EmbeddingOptions): Promise<number[][]>;
}

/** Structural subset of `Models` / `ModelHub` needed to reuse provider auth & baseUrl. */
export interface AuthSourceModels {
  getAuth(providerId: string, overrides?: AuthOperationOptions): Promise<AuthResult | undefined>;
  getProvider(id: string): { readonly baseUrl?: string } | undefined;
}

export interface OpenAIEmbeddingProviderOptions {
  /** Provider ID label (defaults to `authFrom.providerId` or `"openai-embedding"`). */
  readonly id?: string;
  /** Embedding model ID sent in the request body (e.g. `"text-embedding-3-small"`, `"nomic-embed-text"`). */
  readonly modelId: string;
  /** Optional display metadata attached to the provider. */
  readonly model?: EmbeddingModel;
  /** Base API URL (e.g. `"https://api.openai.com/v1"`, `"http://127.0.0.1:11434/v1"`). Optional when `authFrom` provides it. */
  readonly baseUrl?: string;
  /** Relative path or full URL for embeddings. Defaults to `"/embeddings"`. */
  readonly endpoint?: string;
  /** Reuse auth (API key, JWT, OAuth token, headers, baseUrl) from an existing `ModelHub` or `Models` registry. */
  readonly authFrom?: {
    readonly models: AuthSourceModels | Models;
    readonly providerId: string;
  };
  /** Custom dynamic auth resolver (ideal for JWT or rotating tokens when not using `authFrom`). */
  readonly getAuth?: (
    ctx: BackendAuthContext,
  ) => Promise<BackendAuthResult | undefined> | BackendAuthResult | undefined;
  /** Shorthand API key (literal or `$ENV` / `${ENV}`). */
  readonly apiKey?: string;
  /** Allow calling keyless local servers (e.g. Ollama / vLLM) without an Authorization header. */
  readonly allowKeyless?: boolean;
  /** Additional static request headers (supports `$ENV` interpolation). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default output dimensions requested from the server (when supported). */
  readonly dimensions?: number;
  /** L2-normalize returned vectors (recommended for cosine similarity). Defaults to `true`. */
  readonly normalize?: boolean;
  /** Per-request timeout in ms. Defaults to `30_000`. */
  readonly timeoutMs?: number;
  /** Maximum response body size in bytes. Defaults to `16 * 1024 * 1024` (16 MiB). */
  readonly maxResponseBytes?: number;
  /** Maximum accepted vector dimensionality. Defaults to `16_384`. */
  readonly maxDimensions?: number;
  /** Injectable `fetch` implementation (defaults to `globalThis.fetch`). */
  readonly fetch?: typeof globalThis.fetch;
  readonly configResolver?: Omit<ConfigValueResolverOptions, "signal">;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DIMENSIONS = 16_384;

function joinUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedPath}`;
}

function mergeHeaders(...sources: Array<ProviderHeaders | Readonly<Record<string, string>> | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === undefined) {
        const lower = key.toLowerCase();
        for (const existing of Object.keys(merged)) {
          if (existing.toLowerCase() === lower) delete merged[existing];
        }
        continue;
      }
      const lower = key.toLowerCase();
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === lower) delete merged[existing];
      }
      merged[key] = value;
    }
  }
  return merged;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > maxBytes) {
      throw new Error(`Embedding response exceeds limit of ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Embedding response exceeds limit of ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Create an `EmbeddingProvider` backed by any OpenAI-compatible `POST /embeddings`
 * endpoint (OpenAI, Ollama, vLLM, LM Studio, OpenRouter, or custom JWT gateways).
 *
 * Can operate standalone or reuse credentials/headers/baseUrl directly from a `ModelHub` / `Models`.
 */
export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingProviderOptions,
): EmbeddingProvider {
  if (!options.modelId.trim()) {
    throw new HarnessError("INVALID_OPTIONS", "OpenAIEmbeddingProviderOptions.modelId must be non-empty.");
  }

  const id = options.id ?? options.authFrom?.providerId ?? options.model?.provider ?? "openai-embedding";
  const endpoint = options.endpoint ?? "/embeddings";
  const normalize = options.normalize ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxDimensions = options.maxDimensions ?? DEFAULT_MAX_DIMENSIONS;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const fallbackBaseUrl =
    options.baseUrl ??
    options.model?.baseUrl ??
    (options.authFrom ? options.authFrom.models.getProvider(options.authFrom.providerId)?.baseUrl : undefined);

  if (!fallbackBaseUrl && !options.authFrom && !options.getAuth) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `Embedding provider "${id}": specify "baseUrl", "authFrom", or "getAuth".`,
    );
  }

  const resolveRequestParams = async (
    signal: AbortSignal,
  ): Promise<{ baseUrl: string; headers: Record<string, string> }> => {
    const staticHeaders = await resolveConfigHeaders(options.headers, {
      ...options.configResolver,
      signal,
    });
    const modelHeaders = await resolveConfigHeaders(options.model?.headers, {
      ...options.configResolver,
      signal,
    });

    let resolvedBaseUrl = fallbackBaseUrl;
    let apiKey: string | undefined;
    let dynamicHeaders: ProviderHeaders | undefined;

    if (options.authFrom) {
      const authResult = await options.authFrom.models.getAuth(options.authFrom.providerId, { signal });
      if (authResult) {
        apiKey = authResult.auth.apiKey;
        dynamicHeaders = authResult.auth.headers;
        if (authResult.auth.baseUrl) resolvedBaseUrl = authResult.auth.baseUrl;
      } else if (!options.allowKeyless) {
        throw new HarnessError(
          "INVALID_OPTIONS",
          `Provider "${options.authFrom.providerId}" is not configured for embedding requests.`,
        );
      }
      if (!resolvedBaseUrl) {
        resolvedBaseUrl = options.authFrom.models.getProvider(options.authFrom.providerId)?.baseUrl;
      }
    } else if (options.getAuth) {
      const authContext: AuthContext = {
        env: async (name) =>
          options.configResolver?.env?.[name] ??
          (typeof globalThis.process !== "undefined" ? globalThis.process.env[name] : undefined),
        fileExists: async () => false,
      };
      const credential: ApiKeyCredential | undefined = undefined;
      const authResult = await options.getAuth({ credential, authContext, signal });
      if (!authResult && !options.allowKeyless) {
        throw new HarnessError("INVALID_OPTIONS", `Embedding provider "${id}" is not authenticated.`);
      }
      apiKey = authResult?.apiKey;
      dynamicHeaders = authResult?.headers;
      if (authResult?.baseUrl) resolvedBaseUrl = authResult.baseUrl;
    } else if (options.apiKey !== undefined) {
      apiKey = await resolveConfigValue(options.apiKey, { ...options.configResolver, signal });
      if (!apiKey && !options.allowKeyless) {
        throw new HarnessError("INVALID_OPTIONS", `Embedding provider "${id}" failed to resolve apiKey.`);
      }
    } else if (!options.allowKeyless) {
      throw new HarnessError(
        "INVALID_OPTIONS",
        `Embedding provider "${id}" requires "authFrom", "getAuth", "apiKey", or "allowKeyless: true".`,
      );
    }

    if (!resolvedBaseUrl) {
      throw new HarnessError("INVALID_OPTIONS", `Embedding provider "${id}" has no resolved baseUrl.`);
    }

    const baseMerged = mergeHeaders(
      { "content-type": "application/json", accept: "application/json" },
      dynamicHeaders,
      modelHeaders,
      staticHeaders,
    );
    const hasAuthHeader = Object.keys(baseMerged).some((k) => k.toLowerCase() === "authorization");
    const headers =
      apiKey && apiKey !== "local" && !hasAuthHeader
        ? mergeHeaders(baseMerged, { authorization: `Bearer ${apiKey}` })
        : baseMerged;

    return { baseUrl: resolvedBaseUrl, headers };
  };

  const configuredDimensions = options.dimensions ?? options.model?.dimensions;

  return {
    id,
    modelId: options.modelId,
    ...(options.model ? { model: structuredClone(options.model) } : {}),
    ...(configuredDimensions !== undefined ? { dimensions: configuredDimensions } : {}),
    fingerprint(): string {
      const base = (fallbackBaseUrl ?? id).replace(/\/+$/, "");
      return `${base}#${options.modelId}${configuredDimensions !== undefined ? `@${configuredDimensions}` : ""}`;
    },
    async embed(texts: readonly string[], callOptions: EmbeddingOptions = {}): Promise<number[][]> {
      if (texts.length === 0) return [];
      callOptions.signal?.throwIfAborted();
      if (!fetchImpl) {
        throw new HarnessError("INVALID_OPTIONS", "No fetch implementation available for embeddings.");
      }

      const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const effectiveSignal =
        callOptions.signal && timeoutSignal
          ? AbortSignal.any([callOptions.signal, timeoutSignal])
          : (callOptions.signal ?? timeoutSignal ?? new AbortController().signal);

      const { baseUrl, headers } = await resolveRequestParams(effectiveSignal);
      const url = joinUrl(baseUrl, endpoint);
      const requestedDimensions = callOptions.dimensions ?? configuredDimensions;

      const body: Record<string, unknown> = {
        model: options.modelId,
        input: [...texts],
        encoding_format: "float",
      };
      if (requestedDimensions !== undefined) {
        body.dimensions = requestedDimensions;
      }

      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `Embedding request to "${url}" failed for model "${options.modelId}": HTTP ${response.status}`,
        );
      }

      const rawText = await readBoundedText(response, maxResponseBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        throw new Error(`Invalid JSON in embedding response from "${url}".`, { cause: error });
      }

      const data =
        typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)
          ? ((parsed as { data: unknown[] }).data as Array<{ index?: unknown; embedding?: unknown }>)
          : undefined;
      if (!data || data.length !== texts.length) {
        throw new Error(
          `Embedding response from "${url}" returned ${data?.length ?? 0} vectors for ${texts.length} inputs.`,
        );
      }

      const sorted = data
        .map((row, fallbackIndex) => ({
          index: typeof row.index === "number" ? row.index : fallbackIndex,
          embedding: row.embedding,
        }))
        .sort((a, b) => a.index - b.index);

      let expectedDims: number | undefined;
      return sorted.map((row, expectedIndex) => {
        if (row.index !== expectedIndex) {
          throw new Error(`Embedding response indices are non-contiguous at position ${expectedIndex}.`);
        }
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          throw new Error(`Embedding vector at index ${expectedIndex} is empty or invalid.`);
        }
        if (row.embedding.length > maxDimensions) {
          throw new Error(
            `Embedding vector dimension ${row.embedding.length} exceeds limit ${maxDimensions}.`,
          );
        }
        if (expectedDims === undefined) {
          expectedDims = row.embedding.length;
        } else if (row.embedding.length !== expectedDims) {
          throw new Error(
            `Inconsistent embedding dimensions: expected ${expectedDims}, got ${row.embedding.length}.`,
          );
        }
        const vector = row.embedding as unknown[];
        for (let i = 0; i < vector.length; i += 1) {
          if (typeof vector[i] !== "number" || !Number.isFinite(vector[i])) {
            throw new Error(`Embedding vector at index ${expectedIndex} contains a non-finite number.`);
          }
        }
        const nums = vector as number[];
        if (!normalize) {
          return nums.slice();
        }
        const norm = Math.hypot(...nums);
        if (!norm || !Number.isFinite(norm)) {
          throw new Error(`Embedding vector at index ${expectedIndex} has zero norm and cannot be normalized.`);
        }
        return nums.map((n) => n / norm);
      });
    },
  };
}
