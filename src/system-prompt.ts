import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemPrompt,
  type SystemMessage,
  type Tool,
  toToolDeclaration,
} from "@earendil-works/pi-ai";

const SYSTEM_PROMPT_SECTION = "system";

function nextSystemTimestamp(messages: readonly AgentMessage[], now: () => number): number {
  return messages.reduce((timestamp, message) => Math.max(timestamp, message.timestamp + 1), now());
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
