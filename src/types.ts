import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { ClientIdentity, Models, ThinkingBudgets } from "@earendil-works/pi-ai";
import type {
  ExtensionDiagnostic,
  ExtensionExecFn,
  ExtensionRegistration,
  ExtensionUIAdapter,
} from "./extensions/types.js";

export const SESSION_SNAPSHOT_VERSION = 1 as const;

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
  readonly messages: AgentMessage[];
  readonly customEntries?: CustomSessionEntry[];
  readonly status: SessionStatus;
  readonly lastError?: string;
  readonly updatedAt: number;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionSnapshot | null>;
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;
}

export type SessionEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export interface SessionRunResult {
  readonly status: SessionTerminalStatus;
  readonly lastError?: string;
  readonly snapshot: SessionSnapshot;
}

export interface BaseSessionOptions {
  readonly models: Models;
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
  /** Request attribution identity; defaults to `{ attribution: null }`. */
  readonly identity?: ClientIdentity;
  /** Optional upper bound on tool-calling turns within a single run. */
  readonly maxTurns?: number;
  readonly now?: () => number;
}

export interface CreateSessionOptions extends BaseSessionOptions {
  readonly sessionId?: string;
  readonly model: ModelRef;
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
