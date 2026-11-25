import type {
  AgentEvent,
  AgentMessage,
  AgentToolCallOutcome,
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-schema";
import type { CompactionCheckpoint, CompactionPreparation, CompactionTrigger } from "../compaction.js";
import type { CustomSessionEntry, SessionSnapshot } from "../types.js";

export interface ExtensionUIDialogOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface ExtensionUIContext {
  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ExtensionUIAdapter {
  select?: ExtensionUIContext["select"];
  confirm?: ExtensionUIContext["confirm"];
  input?: ExtensionUIContext["input"];
  notify?: ExtensionUIContext["notify"];
}

export interface ExtensionExecOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ExtensionExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ExtensionExecFn = (
  command: string,
  args: string[],
  options?: ExtensionExecOptions,
) => Promise<ExtensionExecResult>;

export interface ExtensionEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export interface ExecuteToolOptions {
  readonly signal?: AbortSignal;
  readonly onUpdate?: AgentToolUpdateCallback<any>;
}

export interface ExtensionContext {
  readonly sessionId: string;
  readonly model: Model<Api> | undefined;
  readonly hasUI: boolean;
  readonly ui: ExtensionUIContext;
  getSystemPrompt(): string;
  getSnapshot(): SessionSnapshot;
  getCustomEntries<T = unknown>(customType?: string): readonly CustomSessionEntry<T>[];
  isIdle(): boolean;
  getSignal(): AbortSignal | undefined;
  abort(): void;
  /**
   * Execute another registered tool through the same validation and
   * `tool_call` / `tool_result` extension hook pipeline as model-issued calls.
   */
  executeTool(
    name: string,
    args: Record<string, unknown>,
    options?: ExecuteToolOptions,
  ): Promise<AgentToolCallOutcome>;
}

export interface ExtensionToolDefinition<
  TParameters extends Record<string, any> = Record<string, any>,
  TDetails = unknown,
> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

/** Typed identity helper for defining extension tools (mirrors `pi-coding-agent`'s `defineTool`). */
export function defineTool<TParameters extends Record<string, any> = Record<string, any>, TDetails = unknown>(
  tool: ExtensionToolDefinition<TParameters, TDetails>,
): ExtensionToolDefinition<TParameters, TDetails> {
  return tool;
}

export interface SessionStartExtensionEvent {
  readonly type: "session_start";
  readonly reason: "create" | "open";
}

export interface SessionShutdownExtensionEvent {
  readonly type: "session_shutdown";
}

/** Fired before context compaction (can cancel, adjust instructions, or provide a custom summary). */
export interface SessionBeforeCompactEvent {
  readonly type: "session_before_compact";
  readonly preparation: CompactionPreparation;
  /** Full append-only session transcript at the compaction point. */
  readonly messages: AgentMessage[];
  readonly customInstructions?: string;
  readonly reason: CompactionTrigger;
  /** True when an overflowed turn will be retried immediately after this compaction. */
  readonly willRetry: boolean;
  readonly signal?: AbortSignal;
}

export interface SessionBeforeCompactResult {
  /** Cancel this compaction cleanly without error. */
  readonly cancel?: boolean;
  /** Custom compaction output produced by the extension (skips downstream summarizers). */
  readonly compaction?: {
    readonly summary: string;
    /** Optional custom cut index in `event.messages` (validated against `isSafeForkBoundary`). */
    readonly firstKeptIndex?: number;
    /** Optional token/cost usage from the LLM call(s) that generated this summary. */
    readonly usage?: Usage;
    /** Optional extension-specific metadata persisted on the `CompactionCheckpoint`. */
    readonly details?: unknown;
  };
  /** Override instructions forwarded to downstream `session_before_compact` handlers. */
  readonly customInstructions?: string;
}

/** Fired after a compaction checkpoint has been committed/applied. */
export interface SessionCompactEvent {
  readonly type: "session_compact";
  readonly checkpoint: CompactionCheckpoint;
  /** True when the compaction summary came from a user-registered extension handler. */
  readonly fromExtension: boolean;
  readonly reason: CompactionTrigger;
  readonly willRetry: boolean;
}

/** Fired when compaction fails or is aborted. */
export interface SessionCompactFailedEvent {
  readonly type: "session_compact_failed";
  readonly reason: CompactionTrigger;
  readonly errorMessage?: string;
  readonly aborted: boolean;
  readonly willRetry: boolean;
  /** True when the failure originated in a user-registered `session_before_compact` handler. */
  readonly fromExtension: boolean;
}

export interface BeforeAgentStartEvent {
  readonly type: "before_agent_start";
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface BeforeAgentStartResult {
  readonly systemPrompt?: string;
}

export interface ContextExtensionEvent {
  readonly type: "context";
  readonly messages: AgentMessage[];
}

export interface ContextExtensionResult {
  readonly messages?: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
  readonly type: "before_provider_request";
  readonly payload: unknown;
  readonly model: Model<Api>;
}

export interface BeforeProviderRequestResult {
  readonly payload?: unknown;
}

export interface AfterProviderResponseEvent {
  readonly type: "after_provider_response";
  readonly response: unknown;
  readonly model: Model<Api>;
}

export interface ToolCallExtensionEvent {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** Set when invoked via `ctx.executeTool()` from inside a running tool. */
  readonly parentToolCallId?: string;
}

export interface ToolCallExtensionResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly terminate?: boolean;
}

export interface ToolResultExtensionEvent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: (TextContent | ImageContent)[];
  readonly details: unknown;
  readonly isError: boolean;
  /** Set when invoked via `ctx.executeTool()` from inside a running tool. */
  readonly parentToolCallId?: string;
}

export interface ToolResultExtensionResult {
  readonly content?: (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly terminate?: boolean;
}

type AgentEventByType = {
  [E in AgentEvent as E["type"]]: E;
};

export interface ExtensionEventMap extends AgentEventByType {
  session_start: SessionStartExtensionEvent;
  session_shutdown: SessionShutdownExtensionEvent;
  session_before_compact: SessionBeforeCompactEvent;
  session_compact: SessionCompactEvent;
  session_compact_failed: SessionCompactFailedEvent;
  before_agent_start: BeforeAgentStartEvent;
  context: ContextExtensionEvent;
  before_provider_request: BeforeProviderRequestEvent;
  after_provider_response: AfterProviderResponseEvent;
  tool_call: ToolCallExtensionEvent;
  tool_result: ToolResultExtensionEvent;
}

export interface ExtensionEventResultMap {
  session_start: void;
  session_shutdown: void;
  session_before_compact: SessionBeforeCompactResult | void;
  session_compact: void;
  session_compact_failed: void;
  before_agent_start: BeforeAgentStartResult | void;
  context: ContextExtensionResult | void;
  before_provider_request: BeforeProviderRequestResult | void;
  after_provider_response: void;
  tool_call: ToolCallExtensionResult | void;
  tool_result: ToolResultExtensionResult | void;
  agent_start: void;
  agent_end: void;
  turn_start: void;
  turn_end: void;
  message_start: void;
  message_update: void;
  message_end: void;
  tool_execution_start: void;
  tool_execution_update: void;
  tool_execution_end: void;
}

export type ExtensionEventName = keyof ExtensionEventMap;

export type ExtensionEventHandler<K extends ExtensionEventName> = (
  event: ExtensionEventMap[K],
  ctx: ExtensionContext,
) => Promise<ExtensionEventResultMap[K]> | ExtensionEventResultMap[K];

export interface ExtensionDiagnostic {
  readonly kind: "deferred_event" | "handler_error";
  readonly extensionName: string;
  readonly event?: string;
  readonly message: string;
  readonly error?: unknown;
}

export interface ExtensionAPI {
  on<K extends ExtensionEventName>(event: K, handler: ExtensionEventHandler<K>): () => void;
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown,
  ): () => void;
  registerTool<TParameters extends Record<string, any> = Record<string, any>, TDetails = unknown>(
    tool: ExtensionToolDefinition<TParameters, TDetails>,
  ): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getAllTools(): string[];
  appendEntry<T = unknown>(customType: string, data?: T): CustomSessionEntry<T>;
  exec(command: string, args: string[], options?: ExtensionExecOptions): Promise<ExtensionExecResult>;
  readonly events: ExtensionEventBus;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type ExtensionRegistration =
  | ExtensionFactory
  | {
      readonly name: string;
      readonly factory: ExtensionFactory;
    };
