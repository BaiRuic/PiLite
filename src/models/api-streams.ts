import type { Api, ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { HarnessError } from "../types.js";

/**
 * Standard chat wire protocols with lazy `pi-ai` stream implementations.
 * SDK packages (`openai`, `@anthropic-ai/sdk`, `@google/genai`) remain lazy-loaded until first use.
 */
export const STANDARD_LAZY_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const satisfies readonly Api[];

/**
 * Resolve one of the standard chat wire protocols to its lazy `pi-ai` stream implementation.
 * SDK packages (`openai`, `@anthropic-ai/sdk`, `@google/genai`) remain lazy-loaded until first use.
 */
export function resolveLazyApiStreams(api: string): ProviderStreams | undefined {
  switch (api) {
    case "openai-completions":
      return openAICompletionsApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "google-generative-ai":
      return googleGenerativeAIApi();
    default:
      return undefined;
  }
}

/**
 * Build a `createProvider({ api })` dispatch map from requested API IDs and optional custom stream implementations.
 */
export function buildApiStreamMap(
  apis: readonly Api[],
  customApis?: Partial<Record<Api, ProviderStreams>>,
): Partial<Record<Api, ProviderStreams>> {
  const map: Partial<Record<Api, ProviderStreams>> = {};

  if (customApis) {
    for (const [key, value] of Object.entries(customApis)) {
      if (value) {
        map[key as Api] = value;
      }
    }
  }

  for (const api of apis) {
    if (map[api]) continue;
    const resolved = resolveLazyApiStreams(api);
    if (!resolved) {
      throw new HarnessError(
        "INVALID_OPTIONS",
        `Unsupported wire API "${api}". Pass a custom implementation via apiStreams["${api}"].`,
      );
    }
    map[api] = resolved;
  }

  return map;
}
