import type {
  AgentEvent,
  AgentMessage,
  AgentToolCallOutcome,
  AgentToolResult,
  AgentToolUpdateCallback,
  ThinkingLevel,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  ImageContent,
  JsonValue,
  Model,
  Models,
  ProviderHeaders,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-schema";
import type {
  CompactionCheckpoint,
  CompactionPreparation,
  CompactionResult,
  CompactionTrigger,
} from "../compaction.js";
import type { CustomSessionEntry, ModelRef, SessionSnapshot } from "../types.js";

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
  /** Timeout in milliseconds. */
  readonly timeout?: number;
}

export interface ExtensionExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed?: boolean;
  readonly truncated?: boolean;
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

/** Current context token usage relative to the active model's context window. */
export interface ContextUsage {
  /** Estimated context tokens, or `null` when unknown. */
  readonly tokens: number | null;
  /** Active model context window size in tokens. */
  readonly contextWindow: number;
  /** Context usage as a percentage of `contextWindow`, or `null` when `tokens` is `null`. */
  readonly percent: number | null;
}

/** Options for fire-and-forget compaction via `ctx.compact()`. */
export interface ExtensionCompactOptions {
  readonly customInstructions?: string;
  readonly onComplete?: (result: CompactionResult) => void;
  readonly onError?: (error: Error) => void;
}

/** Options for `pi.sendUserMessage()`. */
export interface SendUserMessageOptions {
  /** Delivery mode when a run is currently active: `"steer"` or `"followUp"`. */
  readonly deliverAs?: "steer" | "followUp";
}

/** Metadata for a registered tool returned by `pi.getAllTools()`. */
export interface ExtensionToolInfo {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ExtensionContext {
  readonly sessionId: string;
  readonly model: Model<Api> | undefined;
  /** Active `pi-ai` `Models` registry (catalog, auth, and direct model calls). */
  readonly models: Models;
  readonly thinkingLevel: ThinkingLevel;
  readonly signal: AbortSignal | undefined;
  readonly hasUI: boolean;
  readonly ui: ExtensionUIContext;
  getSystemPrompt(): string;
  getSnapshot(): SessionSnapshot;
  getCustomEntries<T = unknown>(customType?: string): readonly CustomSessionEntry<T>[];
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): ContextUsage | undefined;
  /** Trigger manual compaction without awaiting completion. */
  compact(options?: ExtensionCompactOptions): void;
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

/**
 * Dynamic, named system prompt section (aligned with `pi-durable`'s `PromptSection`).
 *
 * Rendered before each provider request; only minimal `SystemMessage.sections`
 * delta patches are emitted so unchanged prefix sections keep prompt cache hits.
 */
export interface PromptSection {
  /** Unique non-integer-like section key (e.g. `"workspace"`, `"skills"`, `"memory"`). */
  readonly key: string;
  /**
   * Render section text for the upcoming request, or return `undefined` to omit/remove it.
   * `shown` contains the sections currently active in the transcript after replaying prior patches.
   */
  render(
    ctx: ExtensionContext,
    shown: Readonly<Record<string, string>>,
  ): string | undefined | Promise<string | undefined>;
  /** Default `true`: wrap non-undefined text as `<key>\n...\n</key>`. Set `false` for raw text. */
  readonly tag?: boolean;
}

export type PromptSectionWrapper = (section: PromptSection) => PromptSection;

/** Typed builder helper for a `PromptSection` (mirrors `pi-durable`'s `section()`). */
export function definePromptSection(
  key: string,
  render: PromptSection["render"],
  options?: { readonly tag?: boolean },
): PromptSection {
  return options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
}

export interface SessionStartExtensionEvent {
  readonly type: "session_start";
  readonly reason: "create" | "open" | "fork";
}

export interface SessionShutdownExtensionEvent {
  readonly type: "session_shutdown";
}

/** Fired after an agent run has completely settled (committed to store and returned to idle). */
export interface AgentSettledExtensionEvent {
  readonly type: "agent_settled";
  readonly aborted: boolean;
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
  readonly images?: ImageContent[];
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

/**
 * Return any non-`undefined` value to replace the provider request payload directly.
 * Return `undefined` to keep the payload unchanged.
 */
export type BeforeProviderRequestResult = unknown;

/**
 * Fired after request headers are assembled, before the provider HTTP call.
 * Handlers mutate `headers` in place (setting a key to `null` deletes that header);
 * the return value is ignored.
 */
export interface BeforeProviderHeadersEvent {
  readonly type: "before_provider_headers";
  readonly headers: ProviderHeaders;
  readonly model: Model<Api>;
}

export interface AfterProviderResponseEvent {
  readonly type: "after_provider_response";
  readonly response: unknown;
  readonly model: Model<Api>;
}

export type ModelSelectSource = "set" | "cycle" | "restore";

/** Fired when the session's active model changes. */
export interface ModelSelectEvent {
  readonly type: "model_select";
  readonly model: Model<Api>;
  readonly previousModel: Model<Api> | undefined;
  readonly source: ModelSelectSource;
}

/** Fired when the session's active thinking level changes. */
export interface ThinkingLevelSelectEvent {
  readonly type: "thinking_level_select";
  readonly level: ThinkingLevel;
  readonly previousLevel: ThinkingLevel;
}

export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user text input is received by `session.prompt()`, before agent processing. */
export interface InputEvent {
  readonly type: "input";
  readonly text: string;
  readonly images?: ImageContent[];
  readonly source: InputSource;
  readonly streamingBehavior?: "steer" | "followUp";
}

export type InputEventResult =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly text: string; readonly images?: ImageContent[] }
  | { readonly action: "handled" };

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
  readonly structuredContent?: JsonValue;
  readonly usage?: Usage;
  readonly isError: boolean;
  /** Set when invoked via `ctx.executeTool()` from inside a running tool. */
  readonly parentToolCallId?: string;
}

export interface ToolResultExtensionResult {
  readonly content?: (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly structuredContent?: JsonValue;
  readonly usage?: Usage;
  readonly isError?: boolean;
  readonly terminate?: boolean;
}

type AgentEventByType = {
  [E in AgentEvent as E["type"]]: E;
};

export interface ExtensionEventMap extends AgentEventByType {
  session_start: SessionStartExtensionEvent;
  session_shutdown: SessionShutdownExtensionEvent;
  agent_settled: AgentSettledExtensionEvent;
  session_before_compact: SessionBeforeCompactEvent;
  session_compact: SessionCompactEvent;
  session_compact_failed: SessionCompactFailedEvent;
  input: InputEvent;
  before_agent_start: BeforeAgentStartEvent;
  context: ContextExtensionEvent;
  before_provider_request: BeforeProviderRequestEvent;
  before_provider_headers: BeforeProviderHeadersEvent;
  after_provider_response: AfterProviderResponseEvent;
  model_select: ModelSelectEvent;
  thinking_level_select: ThinkingLevelSelectEvent;
  tool_call: ToolCallExtensionEvent;
  tool_result: ToolResultExtensionEvent;
}

export interface ExtensionEventResultMap {
  session_start: void;
  session_shutdown: void;
  agent_settled: void;
  session_before_compact: SessionBeforeCompactResult | void;
  session_compact: void;
  session_compact_failed: void;
  input: InputEventResult | void;
  before_agent_start: BeforeAgentStartResult | void;
  context: ContextExtensionResult | void;
  before_provider_request: BeforeProviderRequestResult | void;
  before_provider_headers: void;
  after_provider_response: void;
  model_select: void;
  thinking_level_select: void;
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
  on(event: "before_provider_request", handler: ExtensionEventHandler<"before_provider_request">): () => void;
  on<K extends Exclude<ExtensionEventName, "before_provider_request">>(
    event: K,
    handler: ExtensionEventHandler<K>,
  ): () => void;
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown,
  ): () => void;
  registerTool<TParameters extends Record<string, any> = Record<string, any>, TDetails = unknown>(
    tool: ExtensionToolDefinition<TParameters, TDetails>,
  ): void;
  /** Register or replace a named prompt section in place (preserving first-registration order). */
  registerPromptSection(section: PromptSection): void;
  /** Wrap an existing prompt section by key (mirrors `pi-durable`'s `wrapSection`). */
  wrapPromptSection(key: string, wrapper: PromptSectionWrapper): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getAllTools(): ExtensionToolInfo[];
  /** Switch the session's active model. Returns `false` if unavailable or unauthenticated. */
  setModel(model: ModelRef | Model<Api>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getSessionName(): string | undefined;
  setSessionName(name: string | undefined): Promise<void>;
  /**
   * Send a user message to the session. Triggers a new prompt turn when idle,
   * or queues via `steer` / `followUp` when a run is active (`options.deliverAs` required).
   */
  sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void;
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
