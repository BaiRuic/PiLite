import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemPrompt,
  type SystemMessage,
  type Tool,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, PromptSection } from "./extensions/types.js";

export const SYSTEM_PROMPT_SECTION = "system";

function nextSystemTimestamp(messages: readonly AgentMessage[], now: () => number): number {
  return messages.reduce((timestamp, message) => Math.max(timestamp, message.timestamp + 1), now());
}

/**
 * Replay every `SystemMessage.sections` patch in order to obtain the active
 * section map (insertion order preserved; `null` deletes a key).
 *
 * Mirrors `pi-durable`'s `replaySections()`.
 */
export function replaySections(messages: readonly AgentMessage[]): Map<string, string> {
  const shown = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    for (const [key, value] of Object.entries(message.sections)) {
      if (value === null) shown.delete(key);
      else shown.set(key, value);
    }
  }
  return shown;
}

/**
 * Render prompt sections in order. Returning `undefined` omits the section; tagged
 * text is wrapped as `<key>\n...\n</key>` unless `tag === false`.
 *
 * Mirrors `pi-durable`'s `renderSections()`: a section that throws while not aborted
 * reports the error and keeps its previously shown text so failures neither crash the
 * turn nor silently delete instructions.
 */
export async function renderSections(
  sections: readonly PromptSection[],
  ctx: ExtensionContext,
  shown: ReadonlyMap<string, string>,
  onError?: (error: unknown, section: PromptSection) => void,
): Promise<Map<string, string>> {
  const shownRecord: Readonly<Record<string, string>> = Object.fromEntries(shown);
  const desired = new Map<string, string>();
  for (const section of sections) {
    let text: string | undefined;
    try {
      text = await section.render(ctx, shownRecord);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      onError?.(error, section);
      const kept = shown.get(section.key);
      if (kept !== undefined) desired.set(section.key, kept);
      continue;
    }
    if (text === undefined) continue;
    desired.set(section.key, section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
  }
  return desired;
}

/**
 * Compute minimal `SystemMessage.sections` patches that transform `shown` into `desired`
 * in both values and key order (mirrors `pi-durable`'s `planSections()`).
 *
 * - Returns `[]` when nothing changed.
 * - Returns 1 minimal delta patch when key order is preserved.
 * - Returns `[removeAllNull, desiredInOrder]` when section order changed.
 */
export function planSections(
  shown: ReadonlyMap<string, string>,
  desired: ReadonlyMap<string, string>,
): Record<string, string | null>[] {
  const patchedOrder = [
    ...[...shown.keys()].filter((key) => desired.has(key)),
    ...[...desired.keys()].filter((key) => !shown.has(key)),
  ];
  const desiredOrder = [...desired.keys()];
  if (patchedOrder.some((key, index) => key !== desiredOrder[index])) {
    return [Object.fromEntries([...shown.keys()].map((key) => [key, null])), Object.fromEntries(desired)];
  }

  const patch: Record<string, string | null> = {};
  for (const [key, value] of shown) {
    const next = desired.get(key);
    if (next !== value) patch[key] = next ?? null;
  }
  for (const [key, value] of desired) {
    if (!shown.has(key)) patch[key] = value;
  }
  return Object.keys(patch).length === 0 ? [] : [patch];
}

/** Convert planned section patch maps into positional `SystemMessage` entries. */
export function buildSectionPatchMessages(
  messages: readonly AgentMessage[],
  patches: readonly Record<string, string | null>[],
  now: () => number,
): SystemMessage[] {
  if (patches.length === 0) return [];
  const baseTimestamp = nextSystemTimestamp(messages, now);
  return patches.map((sections, index) => ({
    role: "system",
    content: "",
    sections,
    timestamp: baseTimestamp + index,
  }));
}

/**
 * Seed the leading system message for a newly created session.
 *
 * The prompt is stored in a named section rather than raw `content` so later
 * host-driven updates replace it cleanly via section patching instead of
 * concatenating onto the original prompt.
 */
export function createInitialTranscript(
  systemPrompt: string | undefined,
  tools: readonly Tool[],
  now: () => number,
): AgentMessage[] {
  const hasPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
  const hasTools = tools.length > 0;
  if (!hasPrompt && !hasTools) {
    return [];
  }

  const systemMessage: SystemMessage = {
    role: "system",
    content: "",
    ...(hasPrompt ? { sections: { [SYSTEM_PROMPT_SECTION]: systemPrompt } } : {}),
    ...(hasTools ? { toolsAdded: tools.map(toToolDeclaration) } : {}),
    timestamp: now(),
  };

  return [systemMessage];
}

/**
 * Build a positional system patch message when the host's desired system prompt
 * differs from the transcript's replayed system prompt.
 */
export function buildSystemPromptPatch(
  messages: readonly AgentMessage[],
  desiredSystemPrompt: string | undefined,
  now: () => number,
): SystemMessage | undefined {
  if (desiredSystemPrompt === undefined) {
    return undefined;
  }

  const currentPrompt = getCurrentSystemPrompt(messages);
  if (currentPrompt === desiredSystemPrompt) {
    return undefined;
  }

  return {
    role: "system",
    content: "",
    sections: {
      [SYSTEM_PROMPT_SECTION]: desiredSystemPrompt.length > 0 ? desiredSystemPrompt : null,
    },
    timestamp: nextSystemTimestamp(messages, now),
  };
}
