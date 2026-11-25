import type { ClientIdentity, Models } from "@earendil-works/pi-ai";
import { type CompactionSummarizer, defaultSummarizeMessages } from "../compaction.js";
import { HarnessError } from "../types.js";
import type { ExtensionFactory } from "./types.js";

/** Internal registration name used by `HarnessSession` for its fallback compaction handler. */
export const BUILTIN_COMPACTION_EXTENSION_NAME = "builtin:compaction";

export interface DefaultCompactionExtensionOptions {
  /** Resolves the active `Models` registry (invoked lazily per compaction). */
  readonly getModels: () => Models;
  /** Optional `pi-ai` client identity forwarded to `models.completeSimple`. */
  readonly identity?: ClientIdentity;
  /** Optional custom summarizer; defaults to `defaultSummarizeMessages`. */
  readonly summarizer?: CompactionSummarizer;
}

/**
 * Built-in reference compaction extension implemented via `pi.on("session_before_compact")`.
 *
 * `HarnessSession` automatically appends this extension at the end of its extension list so
 * user-registered `session_before_compact` handlers run first and can cancel compaction,
 * adjust `customInstructions`, or supply a custom `summary` / `firstKeptIndex` / `details`.
 *
 * Hosts can also use this factory as a template when writing domain-specific compaction
 * extensions (for example routing summaries to a cheaper model or preserving structured metadata).
 */
export function createDefaultCompactionExtension(
  options: DefaultCompactionExtensionOptions,
): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", async (event, ctx) => {
      const model = ctx.model;
      if (!model) {
        throw new HarnessError("MODEL_NOT_FOUND", "Cannot compact session without a resolved model.");
      }

      const summary = options.summarizer
        ? await options.summarizer({
            messages: structuredClone(event.preparation.messagesToSummarize),
            instructions: event.customInstructions,
            model,
            signal: event.signal,
          })
        : await defaultSummarizeMessages({
            models: options.getModels(),
            model,
            messages: event.preparation.messagesToSummarize,
            instructions: event.customInstructions,
            identity: options.identity,
            signal: event.signal,
          });

      return { compaction: { summary } };
    });
  };
}
