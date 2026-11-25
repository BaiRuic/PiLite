# Architecture & Boundaries

> Source code under `src/` is the single source of truth. This document captures motivation, layering, and explicit non-goals.

## Motivation

- **Build directly on `pi-agent-core`, not a stripped fork of `pi-coding-agent`**: `pi-agent-core` already handles the agent loop, tool dispatch, streaming events, and cancellation. Host applications own their UI and domain tools, so there is no need to carry CLI, TUI, or built-in coding tools.
- **Recover sessions, not execution**: Draws inspiration from `pi-durable`'s host abstractions (`Models` injection, portable storage, runtime isolation) without adopting a durable task graph or automatic replay semantics. After an unclean shutdown, an in-flight run is marked `interrupted` and never re-executed automatically; the host explicitly decides whether to call `continue()` or start a new `prompt()`.
- **No Node.js installation required for end users**: Designed to ship with an embedded JS runtime, prioritizing `bun build --compile` standalone executables (zero native C++ addons while allowing Bun-supported `node:*` APIs).

## Layering

| Layer | Responsibilities | Source |
| --- | --- | --- |
| `pi-agent-core` / `pi-ai` | Agent loop, tool execution, streaming events, wire protocols, OAuth/auth primitives | External deps |
| Core harness | Session lifecycle, run-level atomic persistence, crash recovery, retry/compaction, headless extensions | [src/session.ts](../src/session.ts), [src/extensions/](../src/extensions/) |
| Storage & model modules | Portable multi-backend persistence and unified model/credential/embedding assembly | [src/store/](../src/store/), [src/models/](../src/models/) |
| Host application | Injects domain tools, selects storage & model sources, owns UI/API and distribution | Caller |

## Explicit Non-Goals

- **No CLI, TUI, or dynamic disk plugin loading**: No `pi-tui` dependency and no runtime `.ts` loading via `jiti`.
- **No built-in coding tools or `ExecutionEnv`**: Host tools inject whatever clients or resources they need directly.
- **No multi-process concurrent writes to the same session**: A single session allows at most one active run at a time.

## Runtime Portability & Verification

- **Browser smoke check**: [scripts/check-browser-smoke.mjs](../scripts/check-browser-smoke.mjs) bundles all runtime-neutral public entry points ([scripts/browser-smoke-entry.ts](../scripts/browser-smoke-entry.ts)) via `esbuild` (`platform: "browser"`) and fails if any `node:*` built-in or Node/Bun-only adapter leaks into portable modules. Run via `pnpm check:browser-smoke` (included in `pnpm check`).
- **Standalone binary verification**: [scripts/verify-bun-host.ts](../scripts/verify-bun-host.ts) is a minimal host harness compiled via `pnpm build:bun-verify` (with `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`) and executed under a clean `PATH` without Node.js to verify streaming, tool calls, mid-stream abort, crash recovery, and `bun:sqlite` persistence.
