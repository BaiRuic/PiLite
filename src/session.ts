import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentToolCall,
  runToolCall,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type ClientIdentity,
  contentText,
  getCurrentSystemMessage,
  type ImageContent,
  isContextOverflow,
  isRetryableAssistantError,
  type JsonObject,
  type Model,
  type Models,
  retryDelayMs,
  type SystemMessage,
  type TextContent,
} from "@earendil-works/pi-ai";
import {
  type CompactionOptions,
  type CompactionRequestOptions,
  type CompactionResult,
  defaultSummarizeMessages,
  estimateTranscriptTokens,
  isSafeForkBoundary,
  planCompaction,
} from "./compaction.js";
import { ExtensionRunner } from "./extensions/runner.js";
import { buildSystemPromptPatch, createInitialTranscript } from "./system-prompt.js";
import {
  type BaseSessionOptions,
  type CreateSessionOptions,
  type CustomSessionEntry,
  type ForkSessionOptions,
  HarnessError,
  type ModelRef,
  type ModelsProvider,
  type OpenSessionOptions,
  type RetryOptions,
  SESSION_SNAPSHOT_VERSION,
  type SessionEventListener,
  type SessionRunResult,
  type SessionSnapshot,
  type SessionStats,
  type SessionStore,
  type SessionTerminalStatus,
} from "./types.js";

const DEFAULT_HARNESS_IDENTITY: ClientIdentity = { attribution: null };
const DEFAULT_RETRY_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

interface ActiveRun {
  promise: Promise<SessionRunResult>;
  abortRequested: boolean;
  abortController: AbortController;
}

function validateMaxTurns(maxTurns: number | undefined): void {
  if (maxTurns === undefined) return;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `maxTurns must be a positive safe integer, got: ${String(maxTurns)}`,
    );
  }
}

function validateRetryOptions(retry: RetryOptions | undefined): void {
  if (!retry) return;
  if (retry.maxRetries !== undefined && (!Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < 0)) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `retry.maxRetries must be a non-negative integer, got: ${String(retry.maxRetries)}`,
    );
  }
  if (retry.baseDelayMs !== undefined && (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0)) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `retry.baseDelayMs must be a non-negative finite number, got: ${String(retry.baseDelayMs)}`,
    );
  }
  if (retry.maxDelayMs !== undefined && (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < 0)) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `retry.maxDelayMs must be a non-negative finite number, got: ${String(retry.maxDelayMs)}`,
    );
  }
}

function validateCompactionOptions(compaction: CompactionOptions | undefined): void {
  if (!compaction) return;
  if (
    compaction.reserveTokens !== undefined &&
    (!Number.isSafeInteger(compaction.reserveTokens) || compaction.reserveTokens < 0)
  ) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `compaction.reserveTokens must be a non-negative integer, got: ${String(compaction.reserveTokens)}`,
    );
  }
  if (
    compaction.keepRecentTokens !== undefined &&
    (!Number.isSafeInteger(compaction.keepRecentTokens) || compaction.keepRecentTokens < 0)
  ) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `compaction.keepRecentTokens must be a non-negative integer, got: ${String(compaction.keepRecentTokens)}`,
    );
  }
}

function generateRandomId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  throw new HarnessError(
    "INVALID_OPTIONS",
    "Web Crypto API (globalThis.crypto.randomUUID) is unavailable in this runtime.",
  );
}

function resolveModels(source: ModelsProvider): Models {
  return typeof source === "function" ? source() : source;
}

function resolveModelOrThrow(models: Models, ref: ModelRef): Model<Api> {
  const model = models.getModel(ref.provider, ref.modelId);
  if (!model) {
    throw new HarnessError(
      "MODEL_NOT_FOUND",
      `Model "${ref.provider}/${ref.modelId}" is not available in the provided Models registry.`,
    );
  }
  return model;
}

function normalizePromptInput(
  input: string | AgentMessage | AgentMessage[],
  images: ImageContent[] | undefined,
  now: () => number,
): AgentMessage[] {
  if (Array.isArray(input)) {
    return input.map((message) => structuredClone(message));
  }
  if (typeof input !== "string") {
    return [structuredClone(input)];
  }
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
  if (images && images.length > 0) {
    content.push(...images.map((image) => structuredClone(image)));
  }
  return [{ role: "user", content, timestamp: now() }];
}

function extractPromptText(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      parts.push(contentText(message.content));
    }
  }
  return parts.join("\n");
}

function isEmptyAbortedAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant" || message.stopReason !== "aborted") {
    return false;
  }
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) return false;
    if (block.type === "thinking" && block.thinking.trim().length > 0) return false;
    if (block.type === "toolCall") return false;
  }
  return true;
}

function findLastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate?.role === "assistant") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Drop trailing failed/aborted assistant messages so `continue()` can retry
 * the preceding unanswered user or tool-result input.
 */
function stripTrailingFailedAssistants(messages: readonly AgentMessage[]): AgentMessage[] {
  const result = messages.slice();
  while (result.length > 0) {
    const tail = result[result.length - 1];
    if (tail?.role === "assistant" && (tail.stopReason === "aborted" || tail.stopReason === "error")) {
      result.pop();
      continue;
    }
    break;
  }
  return result;
}

function insertBeforeTrailingNonSystem(
  messages: readonly AgentMessage[],
  patch: AgentMessage,
): AgentMessage[] {
  let insertIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "system") {
      insertIndex = i;
      break;
    }
  }
  return [...messages.slice(0, insertIndex), patch, ...messages.slice(insertIndex)];
}

function defaultSleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class HarnessSession {
  readonly sessionId: string;

  private readonly modelsSource: ModelsProvider;
  private readonly store: SessionStore;
  private readonly agent: Agent;
  private readonly extensions: ExtensionRunner;
  private readonly baseOptions: BaseSessionOptions;
  private readonly now: () => number;
  private readonly maxTurns: number | undefined;
  private readonly retry: RetryOptions | undefined;
  private readonly compaction: CompactionOptions | undefined;
  private readonly identity: ClientIdentity;
  private readonly desiredSystemPrompt: string | undefined;
  private readonly listeners = new Set<SessionEventListener>();

  private committedSnapshot: SessionSnapshot;
  private customEntries: CustomSessionEntry[];
  private activeRun: ActiveRun | undefined;
  private activeRunSystemPromptOverride: string | undefined;
  private invalidated = false;
  private closed = false;
  private completedTurnsInRun = 0;
  private maxTurnsReachedInRun = false;

  private constructor(params: {
    snapshot: SessionSnapshot;
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
    extensions: ExtensionRunner;
    options: BaseSessionOptions;
  }) {
    const { snapshot, model, thinkingLevel, extensions, options } = params;
    this.sessionId = snapshot.sessionId;
    this.modelsSource = options.models;
    this.store = options.store;
    this.extensions = extensions;
    this.baseOptions = options;
    this.now = options.now ?? (() => Date.now());
    this.maxTurns = options.maxTurns;
    this.retry = options.retry;
    this.compaction = options.compaction;
    this.identity = options.identity ?? DEFAULT_HARNESS_IDENTITY;
    this.desiredSystemPrompt = options.systemPrompt;
    this.committedSnapshot = structuredClone(snapshot);
    this.customEntries = structuredClone(snapshot.customEntries ?? []);

    this.agent = new Agent({
      initialState: {
        systemPrompt: "",
        // Keep `model` unset until execution/setModel resolves it (matches pi-coding-agent / pi-durable).
        model: model as Model<Api>,
        thinkingLevel,
        tools: extensions.getActiveAgentTools(),
        messages: structuredClone(snapshot.messages),
      },
      streamFn: (reqModel, context, streamOptions) => {
        const currentModels = this.getModels();
        const freshModel = currentModels.getModel(reqModel.provider, reqModel.id) ?? reqModel;
        return currentModels.streamSimple(freshModel, context, streamOptions);
      },
      sessionId: snapshot.sessionId,
      identity: this.identity,
      thinkingBudgets: options.thinkingBudgets,
      toolExecution: options.toolExecution,
      ...(options.steeringMode !== undefined ? { steeringMode: options.steeringMode } : {}),
      ...(options.followUpMode !== undefined ? { followUpMode: options.followUpMode } : {}),
      transformContext: async (messages) => {
        const transformed = await this.extensions.emitContext(messages);
        const forced = this.activeRunSystemPromptOverride;
        if (forced === undefined) {
          return transformed;
        }
        const current = getCurrentSystemMessage(transformed);
        const head: SystemMessage = {
          role: "system",
          content: forced,
          ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
          timestamp: current?.timestamp ?? this.now(),
        };
        return [head, ...transformed.filter((message) => message.role !== "system")];
      },
      beforeToolCall: async ({ toolCall, args }) =>
        this.extensions.emitToolCall({
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
        }),
      afterToolCall: async ({ toolCall, args, result, isError }) =>
        this.extensions.emitToolResult({
          type: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
          content: result.content,
          details: result.details,
          isError,
        }),
      onPayload: async (payload, reqModel) => this.extensions.emitBeforeProviderRequest(payload, reqModel),
      onResponse: async (response, reqModel) => {
        await this.extensions.emitAfterProviderResponse(response, reqModel);
      },
      finishTurn: ({ message, toolResults }) => {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          return undefined;
        }
        if (this.maxTurns === undefined) {
          return undefined;
        }
        this.completedTurnsInRun += 1;
        if (toolResults.length > 0 && this.completedTurnsInRun >= this.maxTurns) {
          this.maxTurnsReachedInRun = true;
          return { action: "end" };
        }
        return undefined;
      },
    });

    this.extensions.bind({
      sessionId: snapshot.sessionId,
      getModel: () => this.resolvedModel,
      ui: options.ui,
      exec: options.exec,
      onDiagnostic: options.onExtensionDiagnostic,
      getSystemPrompt: () => this.activeRunSystemPromptOverride ?? this.systemPrompt,
      getSnapshot: () => this.getSnapshot(),
      getCustomEntries: <T = unknown>(customType?: string) => {
        const filtered =
          customType === undefined
            ? this.customEntries
            : this.customEntries.filter((entry) => entry.customType === customType);
        return structuredClone(filtered) as CustomSessionEntry<T>[];
      },
      appendCustomEntry: <T = unknown>(customType: string, data?: T): CustomSessionEntry<T> => {
        const entry: CustomSessionEntry<T> = {
          id: generateRandomId(),
          customType,
          ...(data !== undefined ? { data: structuredClone(data) } : {}),
          timestamp: this.now(),
        };
        this.customEntries.push(entry);
        return structuredClone(entry);
      },
      isIdle: () => !this.isRunning,
      getSignal: () => this.agent.signal,
      abort: () => {
        void this.abort();
      },
      executeTool: async (name, args, execOptions, parentToolCallId) => {
        const toolCall: AgentToolCall = {
          type: "toolCall",
          id: generateRandomId(),
          name,
          arguments: args as JsonObject,
        };
        const currentModel = this.resolvedModel;
        const assistantMessage =
          findLastAssistantMessage(this.agent.state.messages) ??
          ({
            role: "assistant",
            content: [toolCall],
            api: currentModel?.api ?? "openai-completions",
            provider: currentModel?.provider ?? this.committedSnapshot.model.provider,
            model: currentModel?.id ?? this.committedSnapshot.model.modelId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: this.now(),
          } satisfies AssistantMessage);

        const allTools = this.extensions.getAllAgentTools();
        return runToolCall(toolCall, {
          tools: allTools,
          assistantMessage,
          context: {
            messages: this.agent.state.messages,
            tools: allTools,
          },
          signal: execOptions?.signal ?? this.agent.signal,
          onUpdate: execOptions?.onUpdate,
          beforeToolCall: async ({ toolCall: tc, args: validatedArgs }) =>
            this.extensions.emitToolCall({
              type: "tool_call",
              toolCallId: tc.id,
              toolName: tc.name,
              input: (validatedArgs && typeof validatedArgs === "object" ? validatedArgs : {}) as Record<
                string,
                unknown
              >,
              ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
            }),
          afterToolCall: async ({ toolCall: tc, args: validatedArgs, result, isError }) =>
            this.extensions.emitToolResult({
              type: "tool_result",
              toolCallId: tc.id,
              toolName: tc.name,
              input: (validatedArgs && typeof validatedArgs === "object" ? validatedArgs : {}) as Record<
                string,
                unknown
              >,
              content: result.content,
              details: result.details,
              isError,
              ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
            }),
        });
      },
      onActiveToolsChanged: (tools) => {
        this.agent.state.tools = tools;
      },
    });

    this.agent.subscribe(async (event: AgentEvent, signal: AbortSignal) => {
      if (event.type === "agent_start" && this.activeRun?.abortRequested) {
        this.agent.abort();
      }
      await this.extensions.emitAgentEvent(event);
      for (const listener of [...this.listeners]) {
        await listener(event, signal);
      }
    });
  }

  /** @internal */
  static async create(options: CreateSessionOptions): Promise<HarnessSession> {
    validateMaxTurns(options.maxTurns);
    validateRetryOptions(options.retry);
    validateCompactionOptions(options.compaction);
    const resolvedModel = resolveModelOrThrow(resolveModels(options.models), options.model);
    const now = options.now ?? (() => Date.now());
    const sessionId = options.sessionId ?? options.generateId?.() ?? generateRandomId();

    if (!sessionId.trim()) {
      throw new HarnessError("INVALID_OPTIONS", "sessionId must be a non-empty string.");
    }

    const existing = await options.store.load(sessionId);
    if (existing !== null) {
      throw new HarnessError("SESSION_EXISTS", `Session "${sessionId}" already exists.`);
    }

    const extensions = await ExtensionRunner.load({
      extensions: options.extensions ?? [],
      baseTools: options.tools ?? [],
      onDiagnostic: options.onExtensionDiagnostic,
    });

    const timestamp = now();
    const thinkingLevel = options.thinkingLevel ?? "off";
    const initialMessages = createInitialTranscript(
      options.systemPrompt,
      extensions.getActiveAgentTools(),
      now,
    );
    const snapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId,
      model: { provider: options.model.provider, modelId: options.model.modelId },
      thinkingLevel,
      ...(options.title !== undefined ? { title: options.title } : {}),
      messages: initialMessages,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await options.store.save(sessionId, snapshot);

    const session = new HarnessSession({
      snapshot,
      model: resolvedModel,
      thinkingLevel,
      extensions,
      options,
    });
    await session.finalizeStartup("create");
    return session;
  }

  /** @internal */
  static async open(options: OpenSessionOptions): Promise<HarnessSession> {
    validateMaxTurns(options.maxTurns);
    validateRetryOptions(options.retry);
    validateCompactionOptions(options.compaction);
    const now = options.now ?? (() => Date.now());
    const loaded = await options.store.load(options.sessionId);
    if (loaded === null) {
      throw new HarnessError("SESSION_NOT_FOUND", `Session "${options.sessionId}" was not found.`);
    }
    if (loaded.version !== SESSION_SNAPSHOT_VERSION) {
      throw new HarnessError(
        "UNSUPPORTED_SNAPSHOT_VERSION",
        `Unsupported snapshot version "${String(loaded.version)}" for session "${options.sessionId}".`,
      );
    }

    const resolvedModel = resolveModels(options.models).getModel(loaded.model.provider, loaded.model.modelId);
    const thinkingLevel = options.thinkingLevel ?? loaded.thinkingLevel ?? "off";

    const extensions = await ExtensionRunner.load({
      extensions: options.extensions ?? [],
      baseTools: options.tools ?? [],
      onDiagnostic: options.onExtensionDiagnostic,
    });

    let snapshot = loaded;
    if (loaded.status === "running") {
      const recovered: SessionSnapshot = {
        version: SESSION_SNAPSHOT_VERSION,
        sessionId: loaded.sessionId,
        model: { provider: loaded.model.provider, modelId: loaded.model.modelId },
        ...(loaded.thinkingLevel !== undefined ? { thinkingLevel: loaded.thinkingLevel } : {}),
        ...(loaded.title !== undefined ? { title: loaded.title } : {}),
        ...(loaded.parentSessionId !== undefined ? { parentSessionId: loaded.parentSessionId } : {}),
        messages: structuredClone(loaded.messages),
        ...(loaded.customEntries && loaded.customEntries.length > 0
          ? { customEntries: structuredClone(loaded.customEntries) }
          : {}),
        status: "interrupted",
        ...(loaded.createdAt !== undefined ? { createdAt: loaded.createdAt } : {}),
        updatedAt: now(),
      };
      await options.store.save(loaded.sessionId, recovered);
      snapshot = recovered;
    }

    const session = new HarnessSession({
      snapshot,
      model: resolvedModel,
      thinkingLevel,
      extensions,
      options,
    });
    await session.finalizeStartup("open");
    return session;
  }

  /** Latest committed snapshot (defensive copy). */
  getSnapshot(): SessionSnapshot {
    return structuredClone(this.committedSnapshot);
  }

  /** Current persisted model reference. */
  get model(): ModelRef {
    return {
      provider: this.committedSnapshot.model.provider,
      modelId: this.committedSnapshot.model.modelId,
    };
  }

  /** Resolved `pi-ai` model from the active `Models` registry, or `undefined` when unavailable. */
  get resolvedModel(): Model<Api> | undefined {
    return this.getModels().getModel(
      this.committedSnapshot.model.provider,
      this.committedSnapshot.model.modelId,
    );
  }

  /** Current thinking level. */
  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }

  /** Current session display title, if set. */
  get title(): string | undefined {
    return this.committedSnapshot.title;
  }

  /** Effective system prompt that will apply on the next request. */
  get systemPrompt(): string {
    return this.desiredSystemPrompt ?? this.agent.state.systemPrompt;
  }

  /** Whether a run is currently active on this session handle. */
  get isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  /** Currently active tool names exposed to the model. */
  getActiveTools(): string[] {
    return this.extensions.getActiveToolNames();
  }

  /** Aggregate message counts, tokens, and costs from committed history. */
  getStats(): SessionStats {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    let cacheWriteCost = 0;
    let totalCost = 0;

    const addUsage = (usage: AssistantMessage["usage"] | undefined) => {
      if (!usage) return;
      inputTokens += usage.input;
      outputTokens += usage.output;
      cacheReadTokens += usage.cacheRead;
      cacheWriteTokens += usage.cacheWrite;
      totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      inputCost += usage.cost.input;
      outputCost += usage.cost.output;
      cacheReadCost += usage.cost.cacheRead;
      cacheWriteCost += usage.cost.cacheWrite;
      totalCost += usage.cost.total;
    };

    for (const message of this.committedSnapshot.messages) {
      if (message.role === "user") {
        userMessages += 1;
      } else if (message.role === "assistant") {
        assistantMessages += 1;
        for (const block of message.content) {
          if (block.type === "toolCall") toolCalls += 1;
        }
        addUsage(message.usage);
      } else if (message.role === "toolResult") {
        toolResults += 1;
        addUsage(message.usage);
      }
    }

    return {
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: this.committedSnapshot.messages.length,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        total: totalTokens,
      },
      cost: {
        input: inputCost,
        output: outputCost,
        cacheRead: cacheReadCost,
        cacheWrite: cacheWriteCost,
        total: totalCost,
      },
    };
  }

  /** Switch the session's model while idle and persist the updated `ModelRef`. */
  async setModel(modelRef: ModelRef): Promise<void> {
    this.assertReadyForRun();
    const resolved = resolveModelOrThrow(this.getModels(), modelRef);
    const updated = this.buildSnapshot({
      model: { provider: modelRef.provider, modelId: modelRef.modelId },
      messages: this.committedSnapshot.messages,
      status: this.committedSnapshot.status,
      lastError: this.committedSnapshot.lastError,
    });
    await this.store.save(this.sessionId, updated);
    this.agent.state.model = resolved;
    this.committedSnapshot = structuredClone(updated);
  }

  /** Change the session's thinking level while idle and persist it. */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.assertReadyForRun();
    const updated = this.buildSnapshot({
      thinkingLevel: level,
      messages: this.committedSnapshot.messages,
      status: this.committedSnapshot.status,
      lastError: this.committedSnapshot.lastError,
    });
    await this.store.save(this.sessionId, updated);
    this.agent.state.thinkingLevel = level;
    this.committedSnapshot = structuredClone(updated);
  }

  /** Set or clear the session's display title while idle and persist it. */
  async setTitle(title: string | undefined): Promise<void> {
    this.assertReadyForRun();
    const updated = this.buildSnapshot({
      title,
      messages: this.committedSnapshot.messages,
      status: this.committedSnapshot.status,
      lastError: this.committedSnapshot.lastError,
    });
    await this.store.save(this.sessionId, updated);
    this.committedSnapshot = structuredClone(updated);
  }

  /**
   * Reset conversation history while preserving model, thinking level, title,
   * and current system/tool baseline. Optionally starts the fresh transcript
   * with a handoff note.
   */
  async reset(handoffText?: string): Promise<SessionSnapshot> {
    this.assertReadyForRun();
    const baseline = getCurrentSystemMessage(this.agent.state.messages);
    const nextMessages: AgentMessage[] = baseline ? [structuredClone(baseline)] : [];

    const patch = buildSystemPromptPatch(nextMessages, this.desiredSystemPrompt, this.now);
    if (patch) {
      nextMessages.push(patch);
    }

    if (handoffText !== undefined && handoffText.length > 0) {
      nextMessages.push({
        role: "user",
        content: [{ type: "text", text: handoffText }],
        timestamp: this.now(),
      });
    }

    const updated = this.buildSnapshot({
      messages: nextMessages,
      status: "idle",
      lastError: undefined,
    });
    await this.store.save(this.sessionId, updated);
    this.agent.state.messages = structuredClone(nextMessages);
    this.committedSnapshot = structuredClone(updated);
    return this.getSnapshot();
  }

  /**
   * Fork this session into a new independent session with its own `sessionId`
   * (and therefore its own provider cache / session affinity).
   */
  async fork(options: ForkSessionOptions = {}): Promise<HarnessSession> {
    this.assertReadyForRun();
    const currentMessages = this.committedSnapshot.messages;
    const cutIndex = options.atMessageIndex ?? currentMessages.length;

    if (!Number.isSafeInteger(cutIndex) || cutIndex < 0 || cutIndex > currentMessages.length) {
      throw new HarnessError(
        "INVALID_OPTIONS",
        `atMessageIndex must be an integer between 0 and ${currentMessages.length}, got: ${String(cutIndex)}`,
      );
    }
    if (!isSafeForkBoundary(currentMessages, cutIndex)) {
      throw new HarnessError(
        "INVALID_OPTIONS",
        `Cannot fork at message index ${cutIndex}: boundary splits a toolCall from its toolResult.`,
      );
    }

    const newSessionId = options.sessionId ?? options.generateId?.() ?? generateRandomId();
    if (!newSessionId.trim()) {
      throw new HarnessError("INVALID_OPTIONS", "sessionId must be a non-empty string.");
    }
    const existing = await this.store.load(newSessionId);
    if (existing !== null) {
      throw new HarnessError("SESSION_EXISTS", `Session "${newSessionId}" already exists.`);
    }

    const resolvedModel = this.resolvedModel;
    const forkedExtensions = await ExtensionRunner.load({
      extensions: this.baseOptions.extensions ?? [],
      baseTools: this.baseOptions.tools ?? [],
      onDiagnostic: this.baseOptions.onExtensionDiagnostic,
    });
    forkedExtensions.setActiveToolNames(this.getActiveTools());

    const timestamp = this.now();
    const title = options.title !== undefined ? options.title : this.committedSnapshot.title;
    const forkedSnapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: newSessionId,
      model: {
        provider: this.committedSnapshot.model.provider,
        modelId: this.committedSnapshot.model.modelId,
      },
      thinkingLevel: this.thinkingLevel,
      ...(title !== undefined ? { title } : {}),
      parentSessionId: this.sessionId,
      messages: structuredClone(currentMessages.slice(0, cutIndex)),
      ...(this.customEntries.length > 0 ? { customEntries: structuredClone(this.customEntries) } : {}),
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.save(newSessionId, forkedSnapshot);

    const forkedOptions: BaseSessionOptions = {
      ...this.baseOptions,
      // Keep the forked transcript's system prompt baseline unless explicitly overridden later.
      systemPrompt: undefined,
    };
    const forked = new HarnessSession({
      snapshot: forkedSnapshot,
      model: resolvedModel,
      thinkingLevel: this.thinkingLevel,
      extensions: forkedExtensions,
      options: forkedOptions,
    });
    await forked.finalizeStartup("create");
    return forked;
  }

  /**
   * Manually compact older conversation messages into a summary while preserving
   * recent turns and never splitting tool-call / tool-result pairs.
   */
  async compact(options: CompactionRequestOptions = {}): Promise<CompactionResult> {
    this.assertReadyForRun();
    this.agent.state.model = resolveModelOrThrow(this.getModels(), this.committedSnapshot.model);
    const keepRecentTokens =
      options.keepRecentTokens ?? this.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;

    const outcome = await this.runCompactionOnMessages(
      this.agent.state.messages,
      keepRecentTokens,
      options.instructions,
      undefined,
    );
    if (!outcome.compacted) {
      return outcome.result;
    }

    const entry: CustomSessionEntry = {
      id: generateRandomId(),
      customType: "harness.compaction",
      data: {
        summary: outcome.result.summary,
        compactedMessages: outcome.result.compactedMessages,
        keptMessages: outcome.result.keptMessages,
        tokensBefore: outcome.result.tokensBefore,
        tokensAfter: outcome.result.tokensAfter,
      },
      timestamp: this.now(),
    };
    const nextCustomEntries = [...structuredClone(this.customEntries), entry];
    const updated = this.buildSnapshot({
      messages: outcome.nextMessages,
      customEntries: nextCustomEntries,
      status: this.committedSnapshot.status,
      lastError: this.committedSnapshot.lastError,
    });

    await this.store.save(this.sessionId, updated);
    this.agent.state.messages = structuredClone(outcome.nextMessages);
    this.customEntries = nextCustomEntries;
    this.committedSnapshot = structuredClone(updated);
    return outcome.result;
  }

  /** Subscribe to `pi-agent-core` events for runs driven by this session. */
  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Queue a steering message to guide an active run after the current tool round. */
  steer(input: string, images?: ImageContent[]): void;
  steer(message: AgentMessage): void;
  steer(input: string | AgentMessage, images?: ImageContent[]): void {
    this.assertActiveForQueue("steer");
    const [message] = normalizePromptInput(input, images, this.now);
    if (message) {
      this.agent.steer(message);
    }
  }

  /** Queue a follow-up message to execute after the active run would otherwise finish. */
  followUp(input: string, images?: ImageContent[]): void;
  followUp(message: AgentMessage): void;
  followUp(input: string | AgentMessage, images?: ImageContent[]): void {
    this.assertActiveForQueue("followUp");
    const [message] = normalizePromptInput(input, images, this.now);
    if (message) {
      this.agent.followUp(message);
    }
  }

  /** Discard any queued steering and follow-up messages. */
  clearQueues(): void {
    this.agent.clearAllQueues();
  }

  /** Whether any steering or follow-up messages are currently queued. */
  hasQueuedMessages(): boolean {
    return this.agent.hasQueuedMessages();
  }

  /**
   * Abort the active run (including any retry backoff wait) and wait until both
   * `pi-agent-core` and final snapshot persistence have settled.
   */
  async abort(): Promise<void> {
    const current = this.activeRun;
    if (!current) {
      return;
    }
    current.abortRequested = true;
    current.abortController.abort();
    this.agent.clearAllQueues();
    this.agent.abort();
    await current.promise.catch(() => undefined);
  }

  /** Notify extensions of session shutdown. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.extensions.emitSessionShutdown();
  }

  /** Send a new prompt and commit the run result atomically on completion. */
  async prompt(input: string, images?: ImageContent[]): Promise<SessionRunResult>;
  async prompt(message: AgentMessage | AgentMessage[]): Promise<SessionRunResult>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<SessionRunResult> {
    this.assertReadyForRun();
    const userMessages = normalizePromptInput(input, images, this.now);
    const systemPatch = buildSystemPromptPatch(this.agent.state.messages, this.desiredSystemPrompt, this.now);
    const pendingMessages: AgentMessage[] = systemPatch ? [systemPatch, ...userMessages] : userMessages;

    return this.startRun({
      kind: "prompt",
      promptText: extractPromptText(userMessages),
      pendingMessages,
      preRunMessages: [...structuredClone(this.agent.state.messages), ...structuredClone(pendingMessages)],
    });
  }

  /**
   * Explicitly continue from an unanswered trailing user/toolResult message
   * (for example after an `interrupted`, `aborted`, or `error` run).
   */
  async continue(): Promise<SessionRunResult> {
    this.assertReadyForRun();

    const candidateMessages = stripTrailingFailedAssistants(this.agent.state.messages);
    const lastMessage = candidateMessages[candidateMessages.length - 1];
    if (!lastMessage || candidateMessages.every((message) => message.role === "system")) {
      throw new HarnessError("NOTHING_TO_CONTINUE", "No user or toolResult message to continue from.");
    }
    if (lastMessage.role === "assistant") {
      throw new HarnessError("NOTHING_TO_CONTINUE", "Cannot continue from a completed assistant message.");
    }

    const systemPatch = buildSystemPromptPatch(candidateMessages, this.desiredSystemPrompt, this.now);
    const preRunMessages = systemPatch
      ? insertBeforeTrailingNonSystem(candidateMessages, systemPatch)
      : candidateMessages;

    return this.startRun({
      kind: "continue",
      promptText: extractPromptText(candidateMessages.slice(-1)),
      preRunMessages: structuredClone(preRunMessages),
    });
  }

  private buildSnapshot(overrides: {
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    title?: string | undefined;
    messages: AgentMessage[];
    customEntries?: CustomSessionEntry[];
    status: SessionSnapshot["status"];
    lastError?: string | undefined;
  }): SessionSnapshot {
    const model = overrides.model ?? this.committedSnapshot.model;
    const thinkingLevel = overrides.thinkingLevel ?? this.agent.state.thinkingLevel;
    const title = "title" in overrides ? overrides.title : this.committedSnapshot.title;
    const customEntries = overrides.customEntries ?? this.customEntries;
    const lastError = overrides.lastError;
    const createdAt = this.committedSnapshot.createdAt ?? this.committedSnapshot.updatedAt;

    return {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: this.sessionId,
      model: { provider: model.provider, modelId: model.modelId },
      thinkingLevel,
      ...(title !== undefined ? { title } : {}),
      ...(this.committedSnapshot.parentSessionId !== undefined
        ? { parentSessionId: this.committedSnapshot.parentSessionId }
        : {}),
      messages: structuredClone(overrides.messages),
      ...(customEntries.length > 0 ? { customEntries: structuredClone(customEntries) } : {}),
      status: overrides.status,
      ...(lastError !== undefined ? { lastError } : {}),
      createdAt,
      updatedAt: this.now(),
    };
  }

  private async runCompactionOnMessages(
    messages: readonly AgentMessage[],
    keepRecentTokens: number,
    instructions: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<
    | { readonly compacted: false; readonly result: CompactionResult }
    | { readonly compacted: true; readonly nextMessages: AgentMessage[]; readonly result: CompactionResult }
  > {
    const tokensBefore = estimateTranscriptTokens(messages);
    const plan = planCompaction(messages, keepRecentTokens);
    if (!plan) {
      return {
        compacted: false,
        result: {
          compacted: false,
          compactedMessages: 0,
          keptMessages: messages.filter((m) => m.role !== "system").length,
          tokensBefore,
          tokensAfter: tokensBefore,
        },
      };
    }

    const summary = this.compaction?.summarizer
      ? await this.compaction.summarizer({
          messages: structuredClone(plan.toSummarize),
          instructions,
          model: this.agent.state.model,
          signal,
        })
      : await defaultSummarizeMessages({
          models: this.getModels(),
          model: this.agent.state.model,
          messages: plan.toSummarize,
          instructions,
          identity: this.identity,
          signal,
        });

    const summaryMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: `<conversation_summary>\n${summary}\n</conversation_summary>` }],
      timestamp: this.now(),
    };

    const nextMessages: AgentMessage[] = [
      ...(plan.systemBaseline ? [structuredClone(plan.systemBaseline)] : []),
      summaryMessage,
      ...structuredClone(plan.kept),
    ];
    const tokensAfter = estimateTranscriptTokens(nextMessages);

    return {
      compacted: true,
      nextMessages,
      result: {
        compacted: true,
        summary,
        compactedMessages: plan.toSummarize.length,
        keptMessages: plan.kept.length,
        tokensBefore,
        tokensAfter,
      },
    };
  }

  private async finalizeStartup(reason: "create" | "open"): Promise<void> {
    const entriesBefore = this.customEntries.length;
    await this.extensions.emitSessionStart(reason);
    if (this.customEntries.length > entriesBefore) {
      const updated = this.buildSnapshot({
        messages: this.committedSnapshot.messages,
        status: this.committedSnapshot.status,
        lastError: this.committedSnapshot.lastError,
      });
      await this.store.save(this.sessionId, updated);
      this.committedSnapshot = structuredClone(updated);
    }
  }

  private getModels(): Models {
    return resolveModels(this.modelsSource);
  }

  private assertReadyForRun(): void {
    if (this.invalidated) {
      throw new HarnessError(
        "SESSION_INVALIDATED",
        `Session "${this.sessionId}" was invalidated after a persistence failure. Reopen it before running again.`,
      );
    }
    if (this.activeRun) {
      throw new HarnessError("SESSION_BUSY", `Session "${this.sessionId}" already has an active run.`);
    }
  }

  private assertActiveForQueue(method: "steer" | "followUp"): void {
    if (this.invalidated) {
      throw new HarnessError(
        "SESSION_INVALIDATED",
        `Session "${this.sessionId}" was invalidated after a persistence failure. Reopen it before running again.`,
      );
    }
    if (!this.activeRun) {
      throw new HarnessError(
        "SESSION_IDLE",
        `Cannot call ${method}() while session "${this.sessionId}" is idle. Use prompt() instead.`,
      );
    }
  }

  private startRun(
    plan:
      | {
          kind: "prompt";
          promptText: string;
          pendingMessages: AgentMessage[];
          preRunMessages: AgentMessage[];
        }
      | { kind: "continue"; promptText: string; preRunMessages: AgentMessage[] },
  ): Promise<SessionRunResult> {
    const runHandle: ActiveRun = {
      promise: Promise.resolve() as unknown as Promise<SessionRunResult>,
      abortRequested: false,
      abortController: new AbortController(),
    };
    this.activeRun = runHandle;

    const promise = (async (): Promise<SessionRunResult> => {
      try {
        return await this.executeRun(plan, runHandle);
      } finally {
        this.agent.clearAllQueues();
        this.activeRunSystemPromptOverride = undefined;
        if (this.activeRun === runHandle) {
          this.activeRun = undefined;
        }
      }
    })();

    runHandle.promise = promise;
    return promise;
  }

  private effectiveContextWindow(): number {
    return this.compaction?.contextWindow ?? this.agent.state.model?.contextWindow ?? 0;
  }

  private async executeRun(
    plan:
      | {
          kind: "prompt";
          promptText: string;
          pendingMessages: AgentMessage[];
          preRunMessages: AgentMessage[];
        }
      | { kind: "continue"; promptText: string; preRunMessages: AgentMessage[] },
    runHandle: ActiveRun,
  ): Promise<SessionRunResult> {
    this.agent.state.model = resolveModelOrThrow(this.getModels(), this.committedSnapshot.model);
    const beforeCustomEntries = structuredClone(this.customEntries);
    const beforeMessages = structuredClone(this.agent.state.messages);

    // Optional threshold auto-compaction before starting the run.
    let activePlan = plan;
    if (this.compaction?.enabled === true) {
      const contextWindow = this.effectiveContextWindow();
      const reserveTokens = this.compaction.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
      const keepRecentTokens = this.compaction.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;
      if (
        contextWindow > 0 &&
        estimateTranscriptTokens(activePlan.preRunMessages) > contextWindow - reserveTokens
      ) {
        const compacted = await this.runCompactionOnMessages(
          this.agent.state.messages,
          keepRecentTokens,
          undefined,
          runHandle.abortController.signal,
        );
        if (compacted.compacted) {
          this.agent.state.messages = structuredClone(compacted.nextMessages);
          this.customEntries.push({
            id: generateRandomId(),
            customType: "harness.compaction",
            data: {
              trigger: "threshold",
              summary: compacted.result.summary,
              compactedMessages: compacted.result.compactedMessages,
              keptMessages: compacted.result.keptMessages,
              tokensBefore: compacted.result.tokensBefore,
              tokensAfter: compacted.result.tokensAfter,
            },
            timestamp: this.now(),
          });
          if (activePlan.kind === "prompt") {
            activePlan = {
              ...activePlan,
              preRunMessages: [
                ...structuredClone(compacted.nextMessages),
                ...structuredClone(activePlan.pendingMessages),
              ],
            };
          } else {
            activePlan = {
              ...activePlan,
              preRunMessages: structuredClone(compacted.nextMessages),
            };
          }
        }
      }
    }

    const beforeStart = await this.extensions.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: activePlan.promptText,
      systemPrompt: this.systemPrompt,
    });
    if (beforeStart?.systemPrompt !== undefined) {
      this.activeRunSystemPromptOverride = beforeStart.systemPrompt;
    }

    const preRunSnapshot = this.buildSnapshot({
      messages: activePlan.preRunMessages,
      status: "running",
      lastError: undefined,
    });

    // Persist user input + running state before starting execution;
    // if pre-run persistence fails, do not start the run or mutate agent state.
    try {
      await this.store.save(this.sessionId, preRunSnapshot);
    } catch (error) {
      this.agent.state.messages = beforeMessages;
      this.customEntries = beforeCustomEntries;
      throw error;
    }
    this.committedSnapshot = structuredClone(preRunSnapshot);

    if (runHandle.abortRequested) {
      this.agent.state.messages = structuredClone(preRunSnapshot.messages);
      return this.commitFinalSnapshot(preRunSnapshot, preRunSnapshot.messages, "aborted", undefined);
    }

    const maxRetries = this.retry ? (this.retry.maxRetries ?? DEFAULT_RETRY_MAX_RETRIES) : 0;
    const baseDelayMs = this.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxDelayMs = this.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const sleep = this.retry?.sleep ?? defaultSleepWithAbort;

    let retryAttempt = 0;
    let overflowRecoveryAttempted = false;
    let lastAssistant: AssistantMessage | undefined;
    let firstInvocation = true;

    while (true) {
      const attemptBaseline = this.agent.state.messages.length;
      this.completedTurnsInRun = 0;
      this.maxTurnsReachedInRun = false;

      if (firstInvocation && activePlan.kind === "prompt") {
        firstInvocation = false;
        await this.agent.prompt(activePlan.pendingMessages);
      } else {
        if (firstInvocation) {
          firstInvocation = false;
          this.agent.state.messages = structuredClone(activePlan.preRunMessages);
        }
        await this.agent.continue();
      }

      const producedMessages = this.agent.state.messages.slice(attemptBaseline);
      lastAssistant = findLastAssistantMessage(producedMessages);

      if (runHandle.abortRequested || this.maxTurnsReachedInRun || lastAssistant?.stopReason !== "error") {
        break;
      }

      // Overflow recovery via compaction (at most once per run).
      if (
        this.compaction?.enabled === true &&
        !overflowRecoveryAttempted &&
        isContextOverflow(lastAssistant, this.effectiveContextWindow() || undefined)
      ) {
        overflowRecoveryAttempted = true;
        const stripped = stripTrailingFailedAssistants(this.agent.state.messages);
        const keepRecentTokens = this.compaction.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;
        const compacted = await this.runCompactionOnMessages(
          stripped,
          keepRecentTokens,
          undefined,
          runHandle.abortController.signal,
        );
        if (compacted.compacted && !runHandle.abortRequested) {
          this.agent.state.messages = structuredClone(compacted.nextMessages);
          this.customEntries.push({
            id: generateRandomId(),
            customType: "harness.compaction",
            data: {
              trigger: "overflow",
              summary: compacted.result.summary,
              compactedMessages: compacted.result.compactedMessages,
              keptMessages: compacted.result.keptMessages,
              tokensBefore: compacted.result.tokensBefore,
              tokensAfter: compacted.result.tokensAfter,
            },
            timestamp: this.now(),
          });
          continue;
        }
      }

      // Transient provider error auto-retry.
      if (retryAttempt < maxRetries && isRetryableAssistantError(lastAssistant)) {
        retryAttempt += 1;
        const delayMs = retryDelayMs({ baseDelayMs, maxAgentDelayMs: maxDelayMs }, retryAttempt);
        this.retry?.onRetry?.({
          attempt: retryAttempt,
          maxRetries,
          delayMs,
          errorMessage: lastAssistant.errorMessage || "Model request failed",
        });
        await sleep(delayMs, runHandle.abortController.signal);
        if (runHandle.abortRequested) {
          break;
        }
        this.agent.state.messages = stripTrailingFailedAssistants(this.agent.state.messages);
        continue;
      }

      break;
    }

    const wasAborted = runHandle.abortRequested || lastAssistant?.stopReason === "aborted";

    let finalStatus: SessionTerminalStatus;
    let lastError: string | undefined;
    if (wasAborted) {
      finalStatus = "aborted";
    } else if (this.maxTurnsReachedInRun) {
      finalStatus = "error";
      lastError = `Reached maxTurns limit (${this.maxTurns})`;
    } else if (lastAssistant?.stopReason === "error") {
      finalStatus = "error";
      lastError = lastAssistant.errorMessage || "Model request failed";
    } else {
      finalStatus = "idle";
    }

    const finalMessages = structuredClone(this.agent.state.messages);
    const tail = finalMessages[finalMessages.length - 1];
    if (tail && isEmptyAbortedAssistantMessage(tail)) {
      finalMessages.pop();
      this.agent.state.messages = structuredClone(finalMessages);
    }

    return this.commitFinalSnapshot(preRunSnapshot, finalMessages, finalStatus, lastError);
  }

  private async commitFinalSnapshot(
    rollbackSnapshot: SessionSnapshot,
    finalMessages: AgentMessage[],
    status: SessionTerminalStatus,
    lastError: string | undefined,
  ): Promise<SessionRunResult> {
    const finalSnapshot = this.buildSnapshot({
      messages: finalMessages,
      status,
      lastError,
    });

    try {
      await this.store.save(this.sessionId, finalSnapshot);
    } catch (error) {
      // Keep memory aligned with the last committed snapshot and force reopen.
      this.agent.state.messages = structuredClone(rollbackSnapshot.messages);
      this.customEntries = structuredClone(rollbackSnapshot.customEntries ?? []);
      this.committedSnapshot = structuredClone(rollbackSnapshot);
      this.invalidated = true;
      throw error;
    }

    this.committedSnapshot = structuredClone(finalSnapshot);
    return {
      status,
      ...(lastError !== undefined ? { lastError } : {}),
      snapshot: this.getSnapshot(),
    };
  }
}

export async function createSession(options: CreateSessionOptions): Promise<HarnessSession> {
  return HarnessSession.create(options);
}

export async function openSession(options: OpenSessionOptions): Promise<HarnessSession> {
  return HarnessSession.open(options);
}
