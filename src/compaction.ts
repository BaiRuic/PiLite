import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type ClientIdentity,
  type Context,
  contentText,
  getCurrentSystemMessage,
  type Model,
  type Models,
  type SystemMessage,
} from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN_ESTIMATE = 4;

const DEFAULT_SUMMARIZATION_PROMPT = [
  "Summarize the earlier conversation concisely for continuing the task.",
  "Preserve key facts, decisions, file paths, identifiers, tool outcomes, constraints, and open questions.",
  "Do not invent details not present in the transcript.",
].join(" ");

export type CompactionTrigger = "manual" | "threshold" | "overflow";

/**
 * Non-destructive compaction checkpoint stored alongside the full append-only transcript.
 *
 * Modeled after `pi-durable` (`CompactionEntry.head`) and `pi-coding-agent`
 * (`CompactionEntry.firstKeptEntryId`): historical messages are preserved intact in
 * `SessionSnapshot.messages`, while the model context is projected from the latest checkpoint.
 */
export interface CompactionCheckpoint {
  readonly id: string;
  /** Index in `SessionSnapshot.messages` of the first message kept verbatim for the model. */
  readonly firstKeptIndex: number;
  /** Index in `SessionSnapshot.messages` where compaction occurred (for UI divider placement). */
  readonly compactedAtIndex: number;
  readonly summary: string;
  readonly trigger: CompactionTrigger;
  readonly compactedMessages: number;
  readonly keptMessages: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly timestamp: number;
}

export interface CompactionSummarizerInput {
  readonly messages: readonly AgentMessage[];
  readonly instructions?: string;
  readonly model: Model<Api>;
  readonly signal?: AbortSignal;
}

export type CompactionSummarizer = (input: CompactionSummarizerInput) => Promise<string>;

export interface CompactionOptions {
  /** Enable automatic threshold and context-overflow compaction. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Tokens reserved for the next response + tool outputs before threshold compaction triggers. Default `16384`. */
  readonly reserveTokens?: number;
  /** Approximate token budget of recent messages kept verbatim. Default `20000`. */
  readonly keepRecentTokens?: number;
  /** Override the model's `contextWindow` for threshold checks. */
  readonly contextWindow?: number;
  /** Optional custom summarizer; defaults to `models.completeSimple` with the session's model. */
  readonly summarizer?: CompactionSummarizer;
}

export interface CompactionRequestOptions {
  readonly instructions?: string;
  readonly keepRecentTokens?: number;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly summary?: string;
  readonly checkpoint?: CompactionCheckpoint;
  readonly compactedMessages: number;
  readonly keptMessages: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/** Format a compaction summary into the synthetic user message injected at the checkpoint head. */
export function createCompactionSummaryMessage(summary: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `<conversation_summary>\n${summary}\n</conversation_summary>` }],
    timestamp,
  };
}

/**
 * Project the effective model context from a full append-only transcript and its
 * non-destructive compaction checkpoints.
 *
 * When no checkpoints exist, returns a defensive copy of `messages`. Otherwise uses the
 * newest checkpoint: `[systemBaselineBeforeKept?, summaryMessage, ...messages.slice(firstKeptIndex)]`.
 */
export function projectContextMessages(
  messages: readonly AgentMessage[],
  compactions?: readonly CompactionCheckpoint[],
): AgentMessage[] {
  if (!compactions || compactions.length === 0) {
    return structuredClone([...messages]);
  }

  const latest = compactions[compactions.length - 1]!;
  const firstKeptIndex = Math.max(0, Math.min(latest.firstKeptIndex, messages.length));
  const systemBaseline = getCurrentSystemMessage(messages.slice(0, firstKeptIndex));
  const summaryMessage = createCompactionSummaryMessage(latest.summary, latest.timestamp);
  const tail = messages.slice(firstKeptIndex);

  return [
    ...(systemBaseline ? [structuredClone(systemBaseline)] : []),
    summaryMessage,
    ...structuredClone(tail),
  ];
}

/** Rough character-based token estimate (chars / 4) for compaction sizing. */
export function estimateMessageTokens(message: AgentMessage): number {
  let chars = 0;
  if (message.role === "system") {
    chars += contentText(message.content).length;
    for (const value of Object.values(message.sections ?? {})) {
      if (value) chars += value.length;
    }
    if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
  } else if (message.role === "user") {
    if (typeof message.content === "string") {
      chars += message.content.length;
    } else {
      for (const block of message.content) {
        chars += block.type === "text" ? block.text.length : 1_200;
      }
    }
  } else if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "thinking") chars += block.thinking.length;
      else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
    }
  } else if (message.role === "toolResult") {
    for (const block of message.content) {
      chars += block.type === "text" ? block.text.length : 1_200;
    }
  } else {
    chars += JSON.stringify(message).length;
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE));
}

export function estimateTranscriptTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

interface IndexedMessage {
  readonly message: AgentMessage;
  /** Original index in full `SessionSnapshot.messages`, or `undefined` for a prior compaction summary. */
  readonly fullIndex: number | undefined;
}

/**
 * Group non-system messages into atomic units so an assistant message containing
 * `toolCall` blocks is never separated from its following `toolResult` messages.
 */
function groupAtomicMessages(items: readonly IndexedMessage[]): IndexedMessage[][] {
  const groups: IndexedMessage[][] = [];
  let index = 0;
  while (index < items.length) {
    const current = items[index]!;
    if (current.message.role === "assistant") {
      const toolCallIds = new Set(
        current.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
      );
      if (toolCallIds.size > 0) {
        const group: IndexedMessage[] = [current];
        index += 1;
        while (index < items.length) {
          const next = items[index]!;
          if (next.message.role === "toolResult" && toolCallIds.has(next.message.toolCallId)) {
            group.push(next);
            index += 1;
            continue;
          }
          break;
        }
        groups.push(group);
        continue;
      }
    }
    groups.push([current]);
    index += 1;
  }
  return groups;
}

export interface CompactionPlan {
  readonly systemBaseline: SystemMessage | undefined;
  readonly toSummarize: AgentMessage[];
  readonly kept: AgentMessage[];
  /** Index in the full transcript of the first message kept verbatim. */
  readonly firstKeptIndex: number;
  /** Index in the full transcript where compaction was recorded (`messages.length`). */
  readonly compactedAtIndex: number;
}

/**
 * Find a safe non-destructive compaction cut point over `messages` (respecting any prior
 * `compactions` so subsequent compactions fold the previous summary forward) that keeps
 * recent atomic message groups within `keepRecentTokens` without splitting tool pairs.
 */
export function planCompaction(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
  compactions?: readonly CompactionCheckpoint[],
): CompactionPlan | null {
  const latest = compactions && compactions.length > 0 ? compactions[compactions.length - 1] : undefined;
  const activeStart = latest ? Math.max(0, Math.min(latest.firstKeptIndex, messages.length)) : 0;

  const indexed: IndexedMessage[] = [];
  if (latest) {
    indexed.push({
      message: createCompactionSummaryMessage(latest.summary, latest.timestamp),
      fullIndex: undefined,
    });
  }
  for (let i = activeStart; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "system") continue;
    indexed.push({ message, fullIndex: i });
  }

  const groups = groupAtomicMessages(indexed);
  // Require at least one real message beyond any prior summary plus one kept group.
  const minSplitGroupIndex = latest ? 2 : 1;
  if (groups.length <= minSplitGroupIndex) {
    return null;
  }

  let keptTokens = 0;
  let splitGroupIndex = groups.length;

  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i]!;
    const groupTokens = estimateTranscriptTokens(group.map((item) => item.message));
    if (splitGroupIndex < groups.length && keptTokens + groupTokens > keepRecentTokens) {
      break;
    }
    keptTokens += groupTokens;
    splitGroupIndex = i;
  }

  if (splitGroupIndex < minSplitGroupIndex) {
    return null;
  }

  const toSummarizeItems = groups.slice(0, splitGroupIndex).flat();
  const keptItems = groups.slice(splitGroupIndex).flat();
  const firstKeptIndex = keptItems[0]?.fullIndex;
  if (toSummarizeItems.length === 0 || firstKeptIndex === undefined) {
    return null;
  }

  return {
    systemBaseline: getCurrentSystemMessage(messages.slice(0, firstKeptIndex)),
    toSummarize: toSummarizeItems.map((item) => item.message),
    kept: keptItems.map((item) => item.message),
    firstKeptIndex,
    compactedAtIndex: messages.length,
  };
}

function renderMessagesForSummary(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`User: ${contentText(message.content)}`);
    } else if (message.role === "assistant") {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
        else if (block.type === "toolCall")
          parts.push(`[toolCall ${block.name}(${JSON.stringify(block.arguments)})]`);
      }
      if (parts.length > 0) lines.push(`Assistant: ${parts.join("\n")}`);
    } else if (message.role === "toolResult") {
      const text = contentText(message.content);
      lines.push(`ToolResult(${message.toolName}${message.isError ? ", error" : ""}): ${text}`);
    }
  }
  return lines.join("\n\n");
}

export async function defaultSummarizeMessages(params: {
  readonly models: Models;
  readonly model: Model<Api>;
  readonly messages: readonly AgentMessage[];
  readonly instructions?: string;
  readonly identity?: ClientIdentity;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const transcriptText = renderMessagesForSummary(params.messages);
  const promptText = params.instructions
    ? `Additional focus instructions: ${params.instructions}\n\nConversation to summarize:\n\n${transcriptText}`
    : `Conversation to summarize:\n\n${transcriptText}`;

  const context: Context = {
    systemPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
  };

  const response = await params.models.completeSimple(params.model, context, {
    ...(params.identity !== undefined ? { identity: params.identity } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  });

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Compaction summarization failed (${response.stopReason})`);
  }

  const summary = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!summary) {
    throw new Error("Compaction summarizer returned an empty summary.");
  }

  return summary;
}

/**
 * Verify that slicing `messages.slice(0, cutIndex)` does not sever an assistant
 * `toolCall` from its following `toolResult` messages.
 */
export function isSafeForkBoundary(messages: readonly AgentMessage[], cutIndex: number): boolean {
  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return true;
  }
  const nextMessage = messages[cutIndex];
  if (nextMessage?.role !== "toolResult") {
    return true;
  }
  // Check whether any assistant message before `cutIndex` issued this toolCallId.
  for (let i = cutIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === "assistant") {
      const hasCall = candidate.content.some(
        (block) => block.type === "toolCall" && block.id === nextMessage.toolCallId,
      );
      if (hasCall) return false;
      break;
    }
    if (candidate?.role === "user") {
      break;
    }
  }
  return true;
}
