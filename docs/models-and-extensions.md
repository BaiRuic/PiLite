# Models & Headless Extensions

> Single source of truth: [src/models/](../src/models/) and [src/extensions/](../src/extensions/).

## Model Integration

### Core Session Layer
- Sessions persist only `ModelRef = { provider, modelId }` — never credentials or provider implementations.
- Auth resolution, OAuth token refresh, and provider dispatch live in `pi-ai`'s `Models`. The session accepts `Models | (() => Models)` (`ModelsProvider`) so registries can be hot-swapped between runs; missing models raise `MODEL_NOT_FOUND` rather than falling back silently.

### Optional Model Hub (`pilite/models*`)
A thin, opt-in assembly layer that produces a standard `pi-ai` `Models` registry without coupling `HarnessSession` to auth or config I/O:

- **`pilite/models` (portable core)**:
  - `createModelHub()` — combines built-in/OAuth providers, custom API backends, abstract local sources, and persistent stores; exposes `hub.asModelsProvider()` for live hot-swapping.
  - `createApiBackendProvider()` — wraps self-hosted HTTP/JWT backends with dynamic `getAuth()`, lazy wire-API dispatch (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`), default OpenAI `/models` parsing, and custom `parseModels` / `fetchModels`.
  - `LocalModelSource` & overlays — abstract config loader supporting keyless local servers (e.g. Ollama/vLLM) with optional `/models` discovery and local `compat` defaults, plus `baseUrl` / `headers` / `modelOverrides` overlays onto existing providers. Supports `$VAR` / `${VAR}` interpolation; `!command` is disabled unless `execCommand` is explicitly provided.
  - `EmbeddingProvider` & `createOpenAIEmbeddingProvider()` — peer abstraction for OpenAI-compatible `POST /embeddings` endpoints (standalone or reusing `ModelHub` auth), returning `{ embeddings, usage? }` with optional `onUsage` callback, `hub.getEmbeddingModels()`, `hub.getAvailableEmbeddingModels()`, `hub.createEmbeddingProvider()`, response/dimension validation, L2 normalization, and non-secret `fingerprint()` for index invalidation.
- **`pilite/models/sqlite`**: Portable `SqliteCredentialStore` (transaction-serialized `modify()` preventing concurrent OAuth refresh races) and `SqliteModelsStore` (offline catalog cache), safe to share one SQLite DB with `SqliteSessionStore`.
- **`pilite/models/indexeddb`**: Browser/Gecko `IndexedDbCredentialStore` (per-provider serialized `modify()`, optional async `codec: { encrypt, decrypt }` executed outside IDB transactions, zero-decrypt `list()`) and `IndexedDbModelsStore`, plus `openIndexedDbModelStores()` for sharing one IndexedDB connection.
- **`pilite/models/node`**: Atomic JSON `FileCredentialStore` / `FileModelsStore`, JSON/JSONC `createJsonFileModelSource()`, and `node:readline`-based `createCliAuthInteraction()` for interactive OAuth CLI login.

## Headless Extensions (`pilite/extensions`)

Modeled after `pi-coding-agent`'s `ExtensionAPI` for explicit code registration (`ExtensionFactory = (pi) => void | Promise<void>`) without TUI or `jiti`:

- **Tools & nested execution**: `registerTool`, `getActiveTools` / `setActiveTools`, `getAllTools(): ExtensionToolInfo[]`, and `ctx.executeTool(name, args, options?)` backed by `pi-agent-core`'s `runToolCall()` so nested calls (including tools hidden from the model) go through schema validation and `tool_call` / `tool_result` hooks (including `structuredContent` and `usage` overrides) with `parentToolCallId`.
- **Lifecycle & interception hooks**: `session_start` (`"create" | "open" | "fork"`), `session_shutdown`, `agent_settled` (emitted after commit and return to idle, deferring `pi.sendUserMessage()` calls issued during `agent_end`/`agent_settled`), `session_before_compact`, `session_compact`, `session_compact_failed`, `input` (transform or short-circuit user text prompts), `before_agent_start` (including prompt `images`), `context`, `tool_call`, `tool_result`, `before_provider_request` (returning any non-`undefined` value replaces the payload directly), `before_provider_headers` (in-place header mutation / deletion via `null`), `after_provider_response`, `model_select`, `thinking_level_select`, and all `pi-agent-core` events. Built-in compaction itself runs through `createDefaultCompactionExtension()` at the end of the `session_before_compact` chain so user extensions can cancel, adjust `customInstructions`, or supply a custom `summary` / `firstKeptIndex` / `details`. Unsupported event names emit a `deferred_event` diagnostic instead of failing.
- **State, session metadata & host bridges**: `pi.appendEntry()` persists custom entries atomically with the session snapshot (including idle lifecycle hooks); `pi.setModel()`, `pi.getSessionName()` / `pi.setSessionName()`, and `pi.getThinkingLevel()` / `pi.setThinkingLevel()` manage session state (both idle and mid-run); `pi.sendUserMessage()` lets extensions start a turn when idle or queue `steer` / `followUp` messages mid-run; `ctx` exposes live `model`, `thinkingLevel`, `signal`, `hasPendingMessages()`, `getContextUsage()` (latest post-compaction assistant usage + trailing estimate, or `null` immediately post-compaction), and fire-and-forget `compact()` (aborts any active run first, aligned with `pi-coding-agent`); `pi.events` provides an in-session event bus; optional `ui` and `exec` (`timeout` / `code` / `killed` / `truncated`) host adapters degrade safely when omitted.
