import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  QueueMode,
  ThinkingLevel,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { ClientIdentity, Models, ThinkingBudgets } from "@earendil-works/pi-ai";
import type { CompactionCheckpoint, CompactionOptions } from "./compaction.js";
import type {
  ExtensionDiagnostic,
  ExtensionExecFn,
  ExtensionRegistration,
  ExtensionUIAdapter,
} from "./extensions/types.js";

export const SESSION_SNAPSHOT_VERSION = 1 as const;

/** Static `Models` instance or getter invoked per request for hot-swapping providers/credentials. */
export type ModelsProvider = Models | (() => Models);

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export type SessionStatus = "idle" | "running" | "aborted" | "interrupted" | "error";

export type SessionTerminalStatus = "idle" | "aborted" | "error";

export interface CustomSessionEntry<T = unknown> {
  readonly id: string;
  readonly customType: string;
  readonly data?: T;
  readonly timestamp: number;
}

export interface SessionSnapshot {
  readonly version: typeof SESSION_SNAPSHOT_VERSION;
  readonly sessionId: string;
  readonly model: ModelRef;
  readonly thinkingLevel?: ThinkingLevel;
  readonly title?: string;
  readonly parentSessionId?: string;
  readonly messages: AgentMessage[];
  /** Non-destructive compaction checkpoints; the newest checkpoint governs model context projection. */
  readonly compactions?: CompactionCheckpoint[];
  readonly customEntries?: CustomSessionEntry[];
  readonly status: SessionStatus;
  readonly lastError?: string;
  readonly createdAt?: number;
  readonly updatedAt: number;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly model: ModelRef;
  readonly status: SessionStatus;
  readonly title?: string;
  readonly parentSessionId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
}

export interface SessionListQuery {
  readonly parentSessionId?: string;
  readonly status?: SessionStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionListPage {
  readonly items: SessionSummary[];
  readonly nextCursor?: string;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionSnapshot | null>;
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  list(query?: SessionListQuery): Promise<SessionListPage>;
  close?(): Promise<void>;
}

/** Build a `SessionSummary` from a full `SessionSnapshot`. */
export function summarizeSnapshot(snapshot: SessionSnapshot): SessionSummary {
  return {
    sessionId: snapshot.sessionId,
    model: { provider: snapshot.model.provider, modelId: snapshot.model.modelId },
    status: snapshot.status,
    ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
    ...(snapshot.parentSessionId !== undefined ? { parentSessionId: snapshot.parentSessionId } : {}),
    createdAt: snapshot.createdAt ?? snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
    messageCount: snapshot.messages.length,
  };
}

/** Sort summaries newest-updated first, breaking ties deterministically by `sessionId`. */
export function sortSessionSummaries(summaries: SessionSummary[]): SessionSummary[] {
  return summaries.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
}

export type SessionEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export interface SessionRunResult {
  readonly status: SessionTerminalStatus;
  readonly lastError?: string;
  readonly snapshot: SessionSnapshot;
}

export interface RetryEvent {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly errorMessage: string;
}

export interface RetryOptions {
  /** Maximum retry attempts for transient provider errors. Defaults to `3` when `retry` is provided. */
  readonly maxRetries?: number;
  /** Base exponential backoff delay in ms. Defaults to `2000`. */
  readonly baseDelayMs?: number;
  /** Maximum backoff delay in ms. Defaults to `60000`. */
  readonly maxDelayMs?: number;
  /** Optional observer invoked before each retry wait. */
  readonly onRetry?: (event: RetryEvent) => void;
  /** Custom sleep implementation (useful for deterministic tests). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SessionStats {
  readonly sessionId: string;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly totalMessages: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export interface ForkSessionOptions {
  readonly sessionId?: string;
  /** Optional exclusive message index to fork at; defaults to full current history. */
  readonly atMessageIndex?: number;
  readonly title?: string;
  readonly generateId?: () => string;
}

export interface BaseSessionOptions {
  readonly models: ModelsProvider;
  readonly store: SessionStore;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentTool<any>[];
  readonly extensions?: readonly ExtensionRegistration[];
  readonly ui?: ExtensionUIAdapter;
  readonly exec?: ExtensionExecFn;
  readonly onExtensionDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  readonly thinkingLevel?: ThinkingLevel;
  readonly thinkingBudgets?: ThinkingBudgets;
  readonly toolExecution?: ToolExecutionMode;
  readonly steeringMode?: QueueMode;
  readonly followUpMode?: QueueMode;
  /** Request attribution identity; defaults to `{ attribution: null }`. */
  readonly identity?: ClientIdentity;
  /** Optional upper bound on tool-calling turns within a single run. */
  readonly maxTurns?: number;
  /** Optional automatic retry policy for transient provider errors. */
  readonly retry?: RetryOptions;
  /** Optional context compaction settings (threshold & overflow recovery). */
  readonly compaction?: CompactionOptions;
  readonly now?: () => number;
}

export interface CreateSessionOptions extends BaseSessionOptions {
  readonly sessionId?: string;
  readonly model: ModelRef;
  readonly title?: string;
  readonly generateId?: () => string;
}

export interface OpenSessionOptions extends BaseSessionOptions {
  readonly sessionId: string;
}

export type HarnessErrorCode =
  | "INVALID_OPTIONS"
  | "MODEL_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_EXISTS"
  | "SESSION_BUSY"
  | "SESSION_IDLE"
  | "SESSION_INVALIDATED"
  | "UNSUPPORTED_SNAPSHOT_VERSION"
  | "NOTHING_TO_CONTINUE";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;

  constructor(code: HarnessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessError";
    this.code = code;
  }
}
