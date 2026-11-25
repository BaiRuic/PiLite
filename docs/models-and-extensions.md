# Models & Headless Extensions

> Single source of truth: [src/models/](../src/models/) and [src/extensions/](../src/extensions/).

## Model Integration

### Core Session Layer
- Sessions persist only `ModelRef = { provider, modelId }` — never credentials or provider implementations.
- Auth resolution, OAuth token refresh, and provider dispatch live in `pi-ai`'s `Models`. The session accepts `Models | (() => Models)` (`ModelsProvider`) so registries can be hot-swapped between runs; missing models raise `MODEL_NOT_FOUND` rather than falling back silently.

### Optional Model Hub (`pi-harness/models*`)
A thin, opt-in assembly layer that produces a standard `pi-ai` `Models` registry without coupling `HarnessSession` to auth or config I/O:

- **`pi-harness/models` (portable core)**:
  - `createModelHub()` — combines built-in/OAuth providers, custom API backends, abstract local sources, and persistent stores; exposes `hub.asModelsProvider()` for live hot-swapping.
  - `createApiBackendProvider()` — wraps self-hosted HTTP/JWT backends with dynamic `getAuth()`, lazy wire-API dispatch (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`), default OpenAI `/models` parsing, and custom `parseModels` / `fetchModels`.
  - `LocalModelSource` & overlays — abstract config loader supporting keyless local servers (e.g. Ollama/vLLM) with optional `/models` discovery and local `compat` defaults, plus `baseUrl` / `headers` / `modelOverrides` overlays onto existing providers. Supports `$VAR` / `${VAR}` interpolation; `!command` is disabled unless `execCommand` is explicitly provided.
  - `EmbeddingProvider` & `createOpenAIEmbeddingProvider()` — peer abstraction for OpenAI-compatible `POST /embeddings` endpoints (standalone or reusing `ModelHub` auth), with `hub.getEmbeddingModels()`, `hub.getAvailableEmbeddingModels()`, `hub.createEmbeddingProvider()`, response/dimension validation, L2 normalization, and non-secret `fingerprint()` for index invalidation.
- **`pi-harness/models/sqlite`**: Portable `SqliteCredentialStore` (transaction-serialized `modify()` preventing concurrent OAuth refresh races) and `SqliteModelsStore` (offline catalog cache), safe to share one SQLite DB with `SqliteSessionStore`.
- **`pi-harness/models/node`**: Atomic JSON `FileCredentialStore` / `FileModelsStore`, JSON/JSONC `createJsonFileModelSource()`, and `node:readline`-based `createCliAuthInteraction()` for interactive OAuth CLI login.

## Headless Extensions (`pi-harness/extensions`)

Modeled after `pi-coding-agent`'s `ExtensionAPI` for explicit code registration (`ExtensionFactory = (pi) => void | Promise<void>`) without TUI or `jiti`:

- **Tools & nested execution**: `registerTool`, `getActiveTools` / `setActiveTools`, and `ctx.executeTool(name, args, options?)` backed by `pi-agent-core`'s `runToolCall()` so nested calls (including tools hidden from the model) go through schema validation and `tool_call` / `tool_result` hooks with `parentToolCallId`.
- **Lifecycle & interception hooks**: `session_start`, `session_shutdown`, `before_agent_start`, `context`, `tool_call`, `tool_result`, `before_provider_request`, `after_provider_response`, and all `pi-agent-core` events. Unsupported event names emit a `deferred_event` diagnostic instead of failing.
- **State & host bridges**: `pi.appendEntry()` persists custom entries atomically with the session snapshot; `pi.events` provides an in-session event bus; optional `ui` and `exec` host adapters degrade safely when omitted.
