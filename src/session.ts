import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  getCurrentSystemMessage,
  type Api,
  type AssistantMessage,
  type ClientIdentity,
  type ImageContent,
  type Model,
  type Models,
  type SystemMessage,
  type TextContent,
} from "@earendil-works/pi-ai";
import { ExtensionRunner } from "./extensions/runner.js";
import { buildSystemPromptPatch, createInitialTranscript } from "./system-prompt.js";
import {
  HarnessError,
  SESSION_SNAPSHOT_VERSION,
  type BaseSessionOptions,
  type CreateSessionOptions,
  type CustomSessionEntry,
  type ModelRef,
  type OpenSessionOptions,
  type SessionEventListener,
  type SessionRunResult,
  type SessionSnapshot,
  type SessionStore,
  type SessionTerminalStatus,
} from "./types.js";

const DEFAULT_HARNESS_IDENTITY: ClientIdentity = { attribution: null };

interface ActiveRun {
  promise: Promise<SessionRunResult>;
  abortRequested: boolean;
}

function validateMaxTurns(maxTurns: number | undefined): void {
  if (maxTurns === undefined) return;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new HarnessError("INVALID_OPTIONS", `maxTurns must be a positive safe integer, got: ${String(maxTurns)}`);
  }
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

function insertBeforeTrailingNonSystem(messages: readonly AgentMessage[], patch: AgentMessage): AgentMessage[] {
  let insertIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "system") {
      insertIndex = i;
      break;
    }
  }
  return [...messages.slice(0, insertIndex), patch, ...messages.slice(insertIndex)];
}

export class HarnessSession {
  readonly sessionId: string;

  private readonly store: SessionStore;
  private readonly agent: Agent;
  private readonly extensions: ExtensionRunner;
  private readonly now: () => number;
  private readonly maxTurns: number | undefined;
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
    model: Model<Api>;
    extensions: ExtensionRunner;
    options: BaseSessionOptions;
  }) {
    const { snapshot, model, extensions, options } = params;
    this.sessionId = snapshot.sessionId;
    this.store = options.store;
    this.extensions = extensions;
    this.now = options.now ?? (() => Date.now());
    this.maxTurns = options.maxTurns;
    this.desiredSystemPrompt = options.systemPrompt;
    this.committedSnapshot = structuredClone(snapshot);
    this.customEntries = structuredClone(snapshot.customEntries ?? []);

    this.agent = new Agent({
      initialState: {
        systemPrompt: "",
        model,
        thinkingLevel: options.thinkingLevel ?? "off",
        tools: extensions.getActiveAgentTools(),
        messages: structuredClone(snapshot.messages),
      },
      streamFn: options.models.streamSimple.bind(options.models),
      sessionId: snapshot.sessionId,
      identity: options.identity ?? DEFAULT_HARNESS_IDENTITY,
      thinkingBudgets: options.thinkingBudgets,
      toolExecution: options.toolExecution,
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
      onPayload: async (payload, reqModel) =>
        this.extensions.emitBeforeProviderRequest(payload, reqModel),
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
      model,
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
          id: randomUUID(),
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
    const resolvedModel = resolveModelOrThrow(options.models, options.model);
    const now = options.now ?? (() => Date.now());
    const sessionId = options.sessionId ?? options.generateId?.() ?? randomUUID();

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

    const initialMessages = createInitialTranscript(
      options.systemPrompt,
      extensions.getActiveAgentTools(),
      now,
    );
    const snapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId,
      model: { provider: options.model.provider, modelId: options.model.modelId },
      messages: initialMessages,
      status: "idle",
      updatedAt: now(),
    };

    await options.store.save(sessionId, snapshot);

    const session = new HarnessSession({
      snapshot,
      model: resolvedModel,
      extensions,
      options,
    });
    await session.finalizeStartup("create");
    return session;
  }

  /** @internal */
  static async open(options: OpenSessionOptions): Promise<HarnessSession> {
    validateMaxTurns(options.maxTurns);
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

    const resolvedModel = resolveModelOrThrow(options.models, loaded.model);

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
        messages: structuredClone(loaded.messages),
        ...(loaded.customEntries && loaded.customEntries.length > 0
          ? { customEntries: structuredClone(loaded.customEntries) }
          : {}),
        status: "interrupted",
        updatedAt: now(),
      };
      await options.store.save(loaded.sessionId, recovered);
      snapshot = recovered;
    }

    const session = new HarnessSession({
      snapshot,
      model: resolvedModel,
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

  /** Subscribe to `pi-agent-core` events for runs driven by this session. */
  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Abort the active run and wait until both `pi-agent-core` and final snapshot
   * persistence have settled.
   */
  async abort(): Promise<void> {
    const current = this.activeRun;
    if (!current) {
      return;
    }
    current.abortRequested = true;
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

  private async finalizeStartup(reason: "create" | "open"): Promise<void> {
    const entriesBefore = this.customEntries.length;
    await this.extensions.emitSessionStart(reason);
    if (this.customEntries.length > entriesBefore) {
      const updated: SessionSnapshot = {
        ...this.committedSnapshot,
        customEntries: structuredClone(this.customEntries),
        updatedAt: this.now(),
      };
      await this.store.save(this.sessionId, updated);
      this.committedSnapshot = structuredClone(updated);
    }
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

  private startRun(
    plan:
      | { kind: "prompt"; promptText: string; pendingMessages: AgentMessage[]; preRunMessages: AgentMessage[] }
      | { kind: "continue"; promptText: string; preRunMessages: AgentMessage[] },
  ): Promise<SessionRunResult> {
    const runHandle: ActiveRun = {
      promise: Promise.resolve() as unknown as Promise<SessionRunResult>,
      abortRequested: false,
    };
    this.activeRun = runHandle;

    const promise = (async (): Promise<SessionRunResult> => {
      try {
        return await this.executeRun(plan, runHandle);
      } finally {
        this.activeRunSystemPromptOverride = undefined;
        if (this.activeRun === runHandle) {
          this.activeRun = undefined;
        }
      }
    })();

    runHandle.promise = promise;
    return promise;
  }

  private async executeRun(
    plan:
      | { kind: "prompt"; promptText: string; pendingMessages: AgentMessage[]; preRunMessages: AgentMessage[] }
      | { kind: "continue"; promptText: string; preRunMessages: AgentMessage[] },
    runHandle: ActiveRun,
  ): Promise<SessionRunResult> {
    const beforeCustomEntries = structuredClone(this.customEntries);
    const beforeStart = await this.extensions.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: plan.promptText,
      systemPrompt: this.systemPrompt,
    });
    if (beforeStart?.systemPrompt !== undefined) {
      this.activeRunSystemPromptOverride = beforeStart.systemPrompt;
    }

    const preRunSnapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: this.sessionId,
      model: { provider: this.committedSnapshot.model.provider, modelId: this.committedSnapshot.model.modelId },
      messages: structuredClone(plan.preRunMessages),
      ...(this.customEntries.length > 0 ? { customEntries: structuredClone(this.customEntries) } : {}),
      status: "running",
      updatedAt: this.now(),
    };

    // Persist user input + running state before starting execution;
    // if pre-run persistence fails, do not start the run or mutate agent state.
    try {
      await this.store.save(this.sessionId, preRunSnapshot);
    } catch (error) {
      this.customEntries = beforeCustomEntries;
      throw error;
    }
    this.committedSnapshot = structuredClone(preRunSnapshot);

    const baselineMessageCount = this.agent.state.messages.length;
    this.completedTurnsInRun = 0;
    this.maxTurnsReachedInRun = false;

    if (runHandle.abortRequested) {
      this.agent.state.messages = structuredClone(preRunSnapshot.messages);
      return this.commitFinalSnapshot(preRunSnapshot, preRunSnapshot.messages, "aborted", undefined);
    }

    if (plan.kind === "prompt") {
      await this.agent.prompt(plan.pendingMessages);
    } else {
      this.agent.state.messages = structuredClone(plan.preRunMessages);
      await this.agent.continue();
    }

    const producedMessages = this.agent.state.messages.slice(baselineMessageCount);
    const lastAssistant = findLastAssistantMessage(producedMessages);
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
    const finalSnapshot: SessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      sessionId: this.sessionId,
      model: { provider: this.committedSnapshot.model.provider, modelId: this.committedSnapshot.model.modelId },
      messages: structuredClone(finalMessages),
      ...(this.customEntries.length > 0 ? { customEntries: structuredClone(this.customEntries) } : {}),
      status,
      ...(lastError !== undefined ? { lastError } : {}),
      updatedAt: this.now(),
    };

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
