import type {
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolCallOutcome,
  BeforeToolCallResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, Models, ProviderHeaders, TextContent } from "@earendil-works/pi-ai";
import type { CustomSessionEntry, ModelRef, SessionSnapshot } from "../types.js";
import { BUILTIN_COMPACTION_EXTENSION_NAME } from "./default-compaction.js";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  ContextExtensionResult,
  ContextUsage,
  ExecuteToolOptions,
  ExtensionAPI,
  ExtensionCompactOptions,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionEventBus,
  ExtensionEventName,
  ExtensionExecFn,
  ExtensionExecOptions,
  ExtensionExecResult,
  ExtensionRegistration,
  ExtensionToolDefinition,
  ExtensionToolInfo,
  ExtensionUIAdapter,
  ExtensionUIContext,
  InputEvent,
  InputEventResult,
  InputSource,
  ModelSelectEvent,
  SendUserMessageOptions,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  ThinkingLevelSelectEvent,
  ToolCallExtensionEvent,
  ToolCallExtensionResult,
  ToolResultExtensionEvent,
  ToolResultExtensionResult,
} from "./types.js";

const SUPPORTED_EVENTS = new Set<string>([
  "session_start",
  "session_shutdown",
  "agent_settled",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "input",
  "before_agent_start",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "model_select",
  "thinking_level_select",
  "tool_call",
  "tool_result",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

type RegisteredHandler = {
  readonly extensionName: string;
  readonly fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
};

export interface ExtensionHostBindings {
  readonly sessionId: string;
  getModel(): Model<Api> | undefined;
  getModels(): Models;
  setModel(model: ModelRef | Model<Api>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getSessionName(): string | undefined;
  setSessionName(name: string | undefined): Promise<void>;
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: SendUserMessageOptions,
  ): void | Promise<void>;
  readonly ui?: ExtensionUIAdapter;
  readonly exec?: ExtensionExecFn;
  readonly onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  getSystemPrompt(): string;
  getSnapshot(): SessionSnapshot;
  getCustomEntries<T = unknown>(customType?: string): readonly CustomSessionEntry<T>[];
  appendCustomEntry<T = unknown>(customType: string, data?: T): CustomSessionEntry<T>;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): ContextUsage | undefined;
  compact(options?: ExtensionCompactOptions): void;
  getSignal(): AbortSignal | undefined;
  abort(): void;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    options: ExecuteToolOptions | undefined,
    parentToolCallId: string | undefined,
  ): Promise<AgentToolCallOutcome>;
  onActiveToolsChanged(tools: AgentTool<any>[]): void;
}

function createUIContext(adapter: ExtensionUIAdapter | undefined): {
  readonly hasUI: boolean;
  readonly ui: ExtensionUIContext;
} {
  const hasUI = Boolean(adapter && (adapter.select || adapter.confirm || adapter.input || adapter.notify));
  return {
    hasUI,
    ui: {
      select: (title, options, opts) =>
        adapter?.select ? adapter.select(title, options, opts) : Promise.resolve(undefined),
      confirm: (title, message, opts) =>
        adapter?.confirm ? adapter.confirm(title, message, opts) : Promise.resolve(false),
      input: (title, placeholder, opts) =>
        adapter?.input ? adapter.input(title, placeholder, opts) : Promise.resolve(undefined),
      notify: (message, type) => {
        adapter?.notify?.(message, type);
      },
    },
  };
}

function createEventBus(
  onDiagnostic: ((diagnostic: ExtensionDiagnostic) => void) | undefined,
): ExtensionEventBus {
  const channels = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel, handler) {
      let listeners = channels.get(channel);
      if (!listeners) {
        listeners = new Set();
        channels.set(channel, listeners);
      }
      listeners.add(handler);
      return () => {
        listeners?.delete(handler);
      };
    },
    emit(channel, data) {
      const listeners = channels.get(channel);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(data);
        } catch (error) {
          onDiagnostic?.({
            kind: "handler_error",
            extensionName: "event-bus",
            event: channel,
            message: error instanceof Error ? error.message : String(error),
            error,
          });
        }
      }
    },
  };
}

/**
 * Runs headless extensions registered via `ExtensionFactory` functions.
 *
 * Aligns with `pi-coding-agent`'s `ExtensionAPI` surface for tools, lifecycle
 * hooks, custom entries, and optional host bridges (`ui`, `exec`) without
 * requiring TUI primitives or dynamic file loading.
 */
export class ExtensionRunner {
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private readonly tools = new Map<string, AgentTool<any>>();
  private activeToolNames: string[] = [];
  private readonly events: ExtensionEventBus;
  private bindings: ExtensionHostBindings | undefined;
  private onDiagnostic: ((diagnostic: ExtensionDiagnostic) => void) | undefined;

  private constructor(
    baseTools: readonly AgentTool<any>[],
    onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
  ) {
    this.onDiagnostic = onDiagnostic;
    this.events = createEventBus(onDiagnostic);
    for (const tool of baseTools) {
      this.tools.set(tool.name, tool);
      if (!this.activeToolNames.includes(tool.name)) {
        this.activeToolNames.push(tool.name);
      }
    }
  }

  static async load(params: {
    readonly extensions: readonly ExtensionRegistration[];
    readonly baseTools: readonly AgentTool<any>[];
    readonly onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  }): Promise<ExtensionRunner> {
    const runner = new ExtensionRunner(params.baseTools, params.onDiagnostic);

    for (let index = 0; index < params.extensions.length; index += 1) {
      const entry = params.extensions[index]!;
      const name = typeof entry === "function" ? entry.name || `extension-${index + 1}` : entry.name;
      const factory = typeof entry === "function" ? entry : entry.factory;
      const api = runner.createAPI(name);
      await factory(api);
    }

    return runner;
  }

  bind(bindings: ExtensionHostBindings): void {
    this.bindings = bindings;
    this.onDiagnostic = bindings.onDiagnostic ?? this.onDiagnostic;
  }

  getActiveToolNames(): string[] {
    return this.activeToolNames.slice();
  }

  getAllToolNames(): string[] {
    return [...this.tools.keys()];
  }

  getAllTools(): ExtensionToolInfo[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  getAllAgentTools(): AgentTool<any>[] {
    return [...this.tools.values()];
  }

  getActiveAgentTools(): AgentTool<any>[] {
    const result: AgentTool<any>[] = [];
    for (const name of this.activeToolNames) {
      const tool = this.tools.get(name);
      if (tool) result.push(tool);
    }
    return result;
  }

  setActiveToolNames(toolNames: readonly string[]): void {
    const next: string[] = [];
    for (const name of toolNames) {
      if (this.tools.has(name) && !next.includes(name)) {
        next.push(name);
      }
    }
    this.activeToolNames = next;
    this.bindings?.onActiveToolsChanged(this.getActiveAgentTools());
  }

  hasHandlers(event: ExtensionEventName): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0;
  }

  async emitSessionStart(reason: "create" | "open" | "fork"): Promise<void> {
    await this.emitNotification("session_start", { type: "session_start", reason });
  }

  async emitSessionShutdown(): Promise<void> {
    await this.emitNotification("session_shutdown", { type: "session_shutdown" });
  }

  async emitAgentSettled(aborted: boolean): Promise<void> {
    await this.emitNotification("agent_settled", { type: "agent_settled", aborted });
  }

  async emitSessionBeforeCompact(event: SessionBeforeCompactEvent): Promise<
    | { readonly outcome: "cancelled"; readonly fromExtension: boolean }
    | {
        readonly outcome: "compacted";
        readonly compaction: NonNullable<SessionBeforeCompactResult["compaction"]>;
        readonly fromExtension: boolean;
      }
    | {
        readonly outcome: "failed";
        readonly error: unknown;
        readonly fromExtension: boolean;
      }
    | { readonly outcome: "none"; readonly customInstructions?: string }
  > {
    const list = this.handlers.get("session_before_compact");
    if (!list || list.length === 0) {
      return {
        outcome: "none",
        ...(event.customInstructions !== undefined ? { customInstructions: event.customInstructions } : {}),
      };
    }

    const ctx = this.createContext();
    let currentInstructions = event.customInstructions;

    for (const handler of [...list]) {
      const fromExtension = handler.extensionName !== BUILTIN_COMPACTION_EXTENSION_NAME;
      try {
        const result = (await handler.fn(
          {
            ...event,
            ...(currentInstructions !== undefined ? { customInstructions: currentInstructions } : {}),
          },
          ctx,
        )) as SessionBeforeCompactResult | undefined;

        if (!result) continue;
        if (result.cancel) {
          return { outcome: "cancelled", fromExtension };
        }
        if (result.compaction !== undefined) {
          return { outcome: "compacted", compaction: result.compaction, fromExtension };
        }
        if (result.customInstructions !== undefined) {
          currentInstructions = result.customInstructions;
        }
      } catch (error) {
        if (fromExtension) {
          this.reportHandlerError(handler.extensionName, "session_before_compact", error);
        }
        return { outcome: "failed", error, fromExtension };
      }
    }

    return {
      outcome: "none",
      ...(currentInstructions !== undefined ? { customInstructions: currentInstructions } : {}),
    };
  }

  async emitSessionCompact(event: SessionCompactEvent): Promise<void> {
    await this.emitNotification("session_compact", event);
  }

  async emitSessionCompactFailed(event: SessionCompactFailedEvent): Promise<void> {
    await this.emitNotification("session_compact_failed", event);
  }

  async emitAgentEvent(event: AgentEvent): Promise<void> {
    await this.emitNotification(event.type, event);
  }

  async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<BeforeAgentStartResult | undefined> {
    const list = this.handlers.get("before_agent_start");
    if (!list || list.length === 0) return undefined;

    const ctx = this.createContext();
    let currentPrompt = event.systemPrompt;
    let changed = false;

    for (const handler of [...list]) {
      try {
        const result = (await handler.fn(
          {
            type: "before_agent_start",
            prompt: event.prompt,
            ...(event.images !== undefined ? { images: event.images } : {}),
            systemPrompt: currentPrompt,
          },
          ctx,
        )) as BeforeAgentStartResult | undefined;
        if (result?.systemPrompt !== undefined) {
          currentPrompt = result.systemPrompt;
          changed = true;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "before_agent_start", error);
      }
    }

    return changed ? { systemPrompt: currentPrompt } : undefined;
  }

  async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const list = this.handlers.get("context");
    if (!list || list.length === 0) return messages;

    const ctx = this.createContext();
    let current = messages;
    for (const handler of [...list]) {
      try {
        const result = (await handler.fn({ type: "context", messages: current }, ctx)) as
          | ContextExtensionResult
          | undefined;
        if (result?.messages !== undefined) {
          current = result.messages;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "context", error);
      }
    }
    return current;
  }

  async emitBeforeProviderRequest(payload: unknown, model: Model<Api>): Promise<unknown> {
    const list = this.handlers.get("before_provider_request");
    if (!list || list.length === 0) return payload;

    const ctx = this.createContext();
    let current = payload;
    for (const handler of [...list]) {
      try {
        const result = await handler.fn({ type: "before_provider_request", payload: current, model }, ctx);
        if (result !== undefined) {
          current = result;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "before_provider_request", error);
      }
    }
    return current;
  }

  async emitBeforeProviderHeaders(headers: ProviderHeaders, model: Model<Api>): Promise<ProviderHeaders> {
    const list = this.handlers.get("before_provider_headers");
    if (!list || list.length === 0) return headers;

    const ctx = this.createContext();
    for (const handler of [...list]) {
      try {
        await handler.fn({ type: "before_provider_headers", headers, model }, ctx);
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "before_provider_headers", error);
      }
    }
    return headers;
  }

  async emitAfterProviderResponse(response: unknown, model: Model<Api>): Promise<void> {
    await this.emitNotification("after_provider_response", {
      type: "after_provider_response",
      response,
      model,
    });
  }

  async emitModelSelect(event: ModelSelectEvent): Promise<void> {
    await this.emitNotification("model_select", event);
  }

  async emitThinkingLevelSelect(event: ThinkingLevelSelectEvent): Promise<void> {
    await this.emitNotification("thinking_level_select", event);
  }

  /** Emit `input` event. Transforms chain in registration order; `"handled"` short-circuits. */
  async emitInput(
    text: string,
    images: ImageContent[] | undefined,
    source: InputSource,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<InputEventResult> {
    const list = this.handlers.get("input");
    if (!list || list.length === 0) {
      return { action: "continue" };
    }

    const ctx = this.createContext();
    let currentText = text;
    let currentImages = images;

    for (const handler of [...list]) {
      try {
        const event: InputEvent = {
          type: "input",
          text: currentText,
          ...(currentImages !== undefined ? { images: currentImages } : {}),
          source,
          ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
        };
        const result = (await handler.fn(event, ctx)) as InputEventResult | undefined;
        if (result?.action === "handled") {
          return result;
        }
        if (result?.action === "transform") {
          currentText = result.text;
          currentImages = result.images ?? currentImages;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "input", error);
      }
    }

    if (currentText !== text || currentImages !== images) {
      return {
        action: "transform",
        text: currentText,
        ...(currentImages !== undefined ? { images: currentImages } : {}),
      };
    }
    return { action: "continue" };
  }

  async emitToolCall(event: ToolCallExtensionEvent): Promise<BeforeToolCallResult | undefined> {
    const list = this.handlers.get("tool_call");
    if (!list || list.length === 0) return undefined;

    const ctx = this.createContext();
    for (const handler of [...list]) {
      try {
        const result = (await handler.fn(event, ctx)) as ToolCallExtensionResult | undefined;
        if (result?.block) {
          return {
            block: true,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
            ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
          };
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "tool_call", error);
        return {
          block: true,
          reason: `Extension "${handler.extensionName}" failed during tool_call: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    return undefined;
  }

  async emitToolResult(event: ToolResultExtensionEvent): Promise<AfterToolCallResult | undefined> {
    const list = this.handlers.get("tool_result");
    if (!list || list.length === 0) return undefined;

    const ctx = this.createContext();
    let content = event.content;
    let details = event.details;
    let structuredContent = event.structuredContent;
    let usage = event.usage;
    let isError = event.isError;
    let terminate: boolean | undefined;

    let contentModified = false;
    let detailsModified = false;
    let structuredContentModified = false;
    let usageModified = false;
    let isErrorModified = false;
    let terminateModified = false;

    for (const handler of [...list]) {
      try {
        const nextEvent: ToolResultExtensionEvent = {
          ...event,
          content,
          details,
          isError,
          ...(structuredContent !== undefined ? { structuredContent } : {}),
          ...(usage !== undefined ? { usage } : {}),
        };
        const result = (await handler.fn(nextEvent, ctx)) as ToolResultExtensionResult | undefined;
        if (!result) continue;
        if (result.content !== undefined) {
          content = result.content;
          contentModified = true;
          if (result.structuredContent === undefined) {
            structuredContent = undefined;
            structuredContentModified = false;
          }
        }
        if (result.details !== undefined) {
          details = result.details;
          detailsModified = true;
        }
        if (result.structuredContent !== undefined) {
          structuredContent = result.structuredContent;
          structuredContentModified = true;
        }
        if (result.usage !== undefined) {
          usage = result.usage;
          usageModified = true;
        }
        if (result.isError !== undefined) {
          isError = result.isError;
          isErrorModified = true;
        }
        if (result.terminate !== undefined) {
          terminate = result.terminate;
          terminateModified = true;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "tool_result", error);
      }
    }

    if (
      !contentModified &&
      !detailsModified &&
      !structuredContentModified &&
      !usageModified &&
      !isErrorModified &&
      !terminateModified
    ) {
      return undefined;
    }

    return {
      ...(contentModified ? { content } : {}),
      ...(detailsModified ? { details } : {}),
      ...(structuredContentModified ? { structuredContent } : {}),
      ...(usageModified ? { usage } : {}),
      ...(isErrorModified ? { isError } : {}),
      ...(terminateModified ? { terminate } : {}),
    };
  }

  private async emitNotification(eventName: string, payload: unknown): Promise<void> {
    const list = this.handlers.get(eventName);
    if (!list || list.length === 0) return;

    const ctx = this.createContext();
    for (const handler of [...list]) {
      try {
        await handler.fn(payload, ctx);
      } catch (error) {
        this.reportHandlerError(handler.extensionName, eventName, error);
      }
    }
  }

  private createAPI(extensionName: string): ExtensionAPI {
    return {
      on: ((
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown,
      ) => {
        if (!SUPPORTED_EVENTS.has(event)) {
          this.onDiagnostic?.({
            kind: "deferred_event",
            extensionName,
            event,
            message: `Event "${event}" is not supported in headless harness and will not be emitted.`,
          });
        }
        let list = this.handlers.get(event);
        if (!list) {
          list = [];
          this.handlers.set(event, list);
        }
        const entry: RegisteredHandler = { extensionName, fn: handler };
        list.push(entry);
        return () => {
          const current = this.handlers.get(event);
          if (!current) return;
          const idx = current.indexOf(entry);
          if (idx !== -1) current.splice(idx, 1);
        };
      }) as ExtensionAPI["on"],
      registerTool: <TParameters extends Record<string, any>, TDetails>(
        definition: ExtensionToolDefinition<TParameters, TDetails>,
      ) => {
        const wrapped: AgentTool<TParameters, TDetails> = {
          name: definition.name,
          label: definition.label ?? definition.name,
          description: definition.description,
          parameters: definition.parameters,
          ...(definition.executionMode !== undefined ? { executionMode: definition.executionMode } : {}),
          execute: (toolCallId, params, signal, onUpdate) =>
            definition.execute(toolCallId, params, signal, onUpdate, this.createContext(toolCallId)),
        };
        const existed = this.tools.has(definition.name);
        this.tools.set(definition.name, wrapped);
        if (!existed && !this.activeToolNames.includes(definition.name)) {
          this.activeToolNames.push(definition.name);
        }
        this.bindings?.onActiveToolsChanged(this.getActiveAgentTools());
      },
      getActiveTools: () => this.getActiveToolNames(),
      setActiveTools: (toolNames: string[]) => this.setActiveToolNames(toolNames),
      getAllTools: () => this.getAllTools(),
      setModel: (model: ModelRef | Model<Api>) => this.requireBindings().setModel(model),
      getThinkingLevel: () => this.requireBindings().getThinkingLevel(),
      setThinkingLevel: (level: ThinkingLevel) => this.requireBindings().setThinkingLevel(level),
      getSessionName: () => this.requireBindings().getSessionName(),
      setSessionName: (name: string | undefined) => this.requireBindings().setSessionName(name),
      sendUserMessage: (content, options) => {
        const bindings = this.requireBindings();
        try {
          const result = bindings.sendUserMessage(content, options);
          if (result && typeof result.then === "function") {
            void result.catch((error) => {
              this.reportHandlerError(extensionName, "send_user_message", error);
            });
          }
        } catch (error) {
          this.reportHandlerError(extensionName, "send_user_message", error);
        }
      },
      appendEntry: <T = unknown>(customType: string, data?: T): CustomSessionEntry<T> => {
        const bindings = this.requireBindings();
        return bindings.appendCustomEntry(customType, data);
      },
      exec: async (
        command: string,
        args: string[],
        options?: ExtensionExecOptions,
      ): Promise<ExtensionExecResult> => {
        const bindings = this.requireBindings();
        if (!bindings.exec) {
          throw new Error(
            `Extension "${extensionName}" called pi.exec(), but the host did not configure an exec adapter.`,
          );
        }
        return bindings.exec(command, args, options);
      },
      events: this.events,
    };
  }

  private createContext(parentToolCallId?: string): ExtensionContext {
    const bindings = this.requireBindings();
    const { hasUI, ui } = createUIContext(bindings.ui);
    return {
      sessionId: bindings.sessionId,
      get model() {
        return bindings.getModel();
      },
      get models() {
        return bindings.getModels();
      },
      get thinkingLevel() {
        return bindings.getThinkingLevel();
      },
      get signal() {
        return bindings.getSignal();
      },
      hasUI,
      ui,
      getSystemPrompt: () => bindings.getSystemPrompt(),
      getSnapshot: () => bindings.getSnapshot(),
      getCustomEntries: <T = unknown>(customType?: string) => bindings.getCustomEntries<T>(customType),
      isIdle: () => bindings.isIdle(),
      hasPendingMessages: () => bindings.hasPendingMessages(),
      getContextUsage: () => bindings.getContextUsage(),
      compact: (options?: ExtensionCompactOptions) => bindings.compact(options),
      abort: () => bindings.abort(),
      executeTool: (name, args, options) => bindings.executeTool(name, args, options, parentToolCallId),
    };
  }

  private requireBindings(): ExtensionHostBindings {
    if (!this.bindings) {
      throw new Error("Extension runtime is not bound to a session yet.");
    }
    return this.bindings;
  }

  private reportHandlerError(extensionName: string, event: string, error: unknown): void {
    this.onDiagnostic?.({
      kind: "handler_error",
      extensionName,
      event,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
  }
}
