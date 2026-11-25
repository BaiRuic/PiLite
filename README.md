# pi-harness

A lightweight, embeddable, headless TypeScript agent harness built on [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

Designed for desktop apps, servers, CLIs, and edge hosts that need an embedded agent session and model-management runtime without inheriting a UI, built-in coding tools, or a heavyweight durable workflow engine — and verified to compile into standalone Bun binaries for environments without Node.js.

## Highlights

- **Headless Session Engine**: Run-level atomic persistence with rollback on save failure, crash recovery marking unfinished runs as `interrupted` without auto-replaying side effects, `abort()` settling, and live-run `steer()` / `followUp()` queues.
- **Long-Conversation & Session Operations**: Independent `fork()` (guarding `toolCall`/`toolResult` boundaries), idle-time `setModel()` / `setThinkingLevel()` / `setTitle()`, `reset(handoff?)`, `getStats()`, transient error auto-`retry`, and manual / threshold / overflow `compact()`.
- **Portable Multi-Backend Storage**: `SessionStore` with `parentSessionId` / `status` filtering and keyset cursor pagination across Memory, SQLite (`node:sqlite` + `bun:sqlite`, zero native C++ addons), JSONL (with truncated tail recovery & compaction), and IndexedDB — all validated by one shared contract suite.
- **Unified Model Management (Optional `pi-harness/models`)**: Hot-swappable `Models | (() => Models)` injection; `ModelHub` composing built-in OAuth subscription flows (with a CLI interaction bridge), self-hosted JWT/API backends, abstract `LocalModelSource` configs (JSON/JSONC + overlays + `/models` discovery), SQLite/file credential & catalog stores, and a peer OpenAI-compatible `EmbeddingProvider`.
- **Headless Extensions (`pi-harness/extensions`)**: Code-registered `ExtensionFactory` supporting dynamic tool activation, nested `ctx.executeTool()` (via `runToolCall()`), lifecycle & interception hooks, atomically persisted `appendEntry`, a shared event bus, and optional `ui` / `exec` adapters.
- **Single-Binary Deployment Friendly**: Zero native C++ addons; verified end-to-end with `bun build --compile` in a clean `PATH` without Node.js.

## Comparison with `pi-durable` and `pi-coding-agent`

| Dimension | `pi-coding-agent` | `pi-durable` | `pi-harness` |
| --- | --- | --- | --- |
| **Role** | Full coding CLI / TUI application | Durable execution & workflow state machine | **Embeddable headless agent runtime library** |
| **UI & Built-in Tools** | Built-in TUI, CLI, and coding tools (`read`/`write`/`edit`/`bash`) | Headless; optional coding tools + `ExecutionEnv` | **No UI or built-in coding tools** — host injects tools directly |
| **Crash Recovery** | Restores local session history | Checkpointed tasks; **automatically resumes & replays** unfinished runs on restart | **Restores history only, never auto-replays**: interrupted runs become `interrupted`; host chooses `continue()` or new `prompt()` |
| **Storage & Footprint** | Local JSONL files | Document store, task graph, signals, scheduler (built for servers / Durable Objects) | Lightweight run-level snapshot `SessionStore` (Memory / SQLite / JSONL / IndexedDB), Bun single-binary ready |
| **Extensions & Models** | Dynamic `.ts` disk plugins (`jiti`) + full `ModelRuntime` | Code-registered extensions + injected `Models` | Code-registered headless extensions (no `jiti`/TUI); core takes `Models \| (() => Models)`, plus optional `pi-harness/models` for OAuth / JWT backends / local configs / embeddings |

**When to choose which:**
- Want a turnkey terminal coding assistant → `pi-coding-agent`.
- Need durable multi-step workflows that automatically resume across crashes, timers, and external signals → `pi-durable`.
- Want a lean, predictable agent session & model layer embedded inside your own desktop app, backend, or custom CLI → `pi-harness`.

## Quick Start

```ts
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createSession } from "pi-harness";
import { createModelHub } from "pi-harness/models";
import { createSqliteCredentialStore, createSqliteModelsStore } from "pi-harness/models/sqlite";
import { SqliteSessionStore } from "pi-harness/storage/sqlite";
import { openNodeSqliteDatabase } from "pi-harness/storage/sqlite/node";

const db = await openNodeSqliteDatabase("./app.sqlite");
const store = await SqliteSessionStore.open(db);

const hub = createModelHub({
  credentials: createSqliteCredentialStore(db),
  modelsStore: createSqliteModelsStore(db),
  providers: [openaiProvider()],
});
await hub.init();

const session = await createSession({
  models: hub.asModelsProvider(),
  store,
  model: { provider: "openai", modelId: "gpt-4.1-mini" },
  systemPrompt: "You are a helpful assistant.",
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const result = await session.prompt("Hello!");
console.log("\nstatus:", result.status);
```

## Package Exports

| Import Path | Description | Source Entry |
| --- | --- | --- |
| `pi-harness` | Core session API (`createSession`, `openSession`, `HarnessSession`, `InMemorySessionStore`) | [src/index.ts](src/index.ts) |
| `pi-harness/extensions` | Headless extension API (`defineTool`, `ExtensionRunner`, hook types) | [src/extensions/index.ts](src/extensions/index.ts) |
| `pi-harness/models` | Portable model hub, API backend factory, `LocalModelSource`, `EmbeddingProvider` | [src/models/index.ts](src/models/index.ts) |
| `pi-harness/models/sqlite` | Portable SQLite `CredentialStore` & `ModelsStore` | [src/models/sqlite/index.ts](src/models/sqlite/index.ts) |
| `pi-harness/models/node` | Atomic JSON file stores, JSONC model source, CLI OAuth interaction bridge | [src/models/node/index.ts](src/models/node/index.ts) |
| `pi-harness/storage/*` | `memory` / `sqlite` (`node`, `bun`) / `jsonl` (`node`) / `indexeddb` | [src/store/](src/store/) |
| `pi-harness/testing` | Shared contract test suites for `SessionStore`, `CredentialStore`, and `ModelsStore` | [src/testing.ts](src/testing.ts) |

## Documentation

Source code is the single source of truth; the docs below focus strictly on architectural boundaries, invariants, and pointers to code:

- [docs/architecture.md](docs/architecture.md) — Motivation, layering, explicit non-goals, and Bun packaging verification
- [docs/session.md](docs/session.md) — Session lifecycle, atomic commits, crash recovery, queues, retry, and compaction
- [docs/storage.md](docs/storage.md) — `SessionStore` contract, filtered cursor pagination, and portable backends
- [docs/models-and-extensions.md](docs/models-and-extensions.md) — Model hot-swapping, `ModelHub`, embeddings, and headless extensions

## Development & Verification

```bash
pnpm check            # Biome format/lint check + strict TypeScript typecheck
pnpm check:fix        # Auto-format/fix + typecheck
pnpm test             # Build and run all Vitest suites
pnpm test:bun         # Run Bun SQLite contract suites
pnpm build:bun-verify # Compile standalone Bun verification binary (dist/verify-bun-host)
```
