import type {
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolCallOutcome,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CustomSessionEntry, SessionSnapshot } from "../types.js";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeProviderRequestResult,
  ContextExtensionResult,
  ExecuteToolOptions,
  ExtensionAPI,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionEventBus,
  ExtensionEventName,
  ExtensionExecFn,
  ExtensionExecOptions,
  ExtensionExecResult,
  ExtensionRegistration,
  ExtensionToolDefinition,
  ExtensionUIAdapter,
  ExtensionUIContext,
  ToolCallExtensionEvent,
  ToolCallExtensionResult,
  ToolResultExtensionEvent,
  ToolResultExtensionResult,
} from "./types.js";

const SUPPORTED_EVENTS = new Set<string>([
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "context",
  "before_provider_request",
  "after_provider_response",
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
  readonly ui?: ExtensionUIAdapter;
  readonly exec?: ExtensionExecFn;
  readonly onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  getSystemPrompt(): string;
  getSnapshot(): SessionSnapshot;
  getCustomEntries<T = unknown>(customType?: string): readonly CustomSessionEntry<T>[];
  appendCustomEntry<T = unknown>(customType: string, data?: T): CustomSessionEntry<T>;
  isIdle(): boolean;
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

  async emitSessionStart(reason: "create" | "open"): Promise<void> {
    await this.emitNotification("session_start", { type: "session_start", reason });
  }

  async emitSessionShutdown(): Promise<void> {
    await this.emitNotification("session_shutdown", { type: "session_shutdown" });
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
          { type: "before_agent_start", prompt: event.prompt, systemPrompt: currentPrompt },
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
        const result = (await handler.fn(
          { type: "before_provider_request", payload: current, model },
          ctx,
        )) as BeforeProviderRequestResult | undefined;
        if (result && "payload" in result && result.payload !== undefined) {
          current = result.payload;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "before_provider_request", error);
      }
    }
    return current;
  }

  async emitAfterProviderResponse(response: unknown, model: Model<Api>): Promise<void> {
    await this.emitNotification("after_provider_response", {
      type: "after_provider_response",
      response,
      model,
    });
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
    let isError = event.isError;
    let terminate: boolean | undefined;
    let modified = false;

    for (const handler of [...list]) {
      try {
        const result = (await handler.fn({ ...event, content, details, isError }, ctx)) as
          | ToolResultExtensionResult
          | undefined;
        if (!result) continue;
        if (result.content !== undefined) {
          content = result.content;
          modified = true;
        }
        if (result.details !== undefined) {
          details = result.details;
          modified = true;
        }
        if (result.isError !== undefined) {
          isError = result.isError;
          modified = true;
        }
        if (result.terminate !== undefined) {
          terminate = result.terminate;
          modified = true;
        }
      } catch (error) {
        this.reportHandlerError(handler.extensionName, "tool_result", error);
      }
    }

    if (!modified) return undefined;
    return {
      content,
      details,
      isError,
      ...(terminate !== undefined ? { terminate } : {}),
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
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
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
      },
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
      getAllTools: () => this.getAllToolNames(),
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
      model: bindings.getModel(),
      hasUI,
      ui,
      getSystemPrompt: () => bindings.getSystemPrompt(),
      getSnapshot: () => bindings.getSnapshot(),
      getCustomEntries: <T = unknown>(customType?: string) => bindings.getCustomEntries<T>(customType),
      isIdle: () => bindings.isIdle(),
      getSignal: () => bindings.getSignal(),
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
