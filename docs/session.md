# Session Lifecycle & Consistency Semantics

> Single source of truth: [src/session.ts](../src/session.ts), [src/types.ts](../src/types.ts), [src/system-prompt.ts](../src/system-prompt.ts), [src/compaction.ts](../src/compaction.ts).

## Persistence Granularity & Consistency

- **Run-level atomic commits**: Before executing `prompt()` or `continue()`, the harness persists the user input with `status: "running"`; if pre-run persistence fails, execution does not start. When the run settles, the complete message transcript and terminal status are committed atomically. Streaming events are live previews, not durability guarantees.
- **Terminal status & cancellation**: `pi-agent-core` encodes model errors and cancellation in the final `AssistantMessage.stopReason` (`"error" | "aborted"`) rather than rejecting `prompt()`. The harness derives `idle` / `aborted` / `error` from abort intent and `stopReason`, drops empty `aborted` trailing messages, and keeps non-empty partial `aborted`/`error` messages for host display (skipped on subsequent turns by `pi-ai`).
- **Save-failure rollback**: If final `save()` fails, in-memory messages and `customEntries` roll back to the last committed snapshot and the handle is marked `SESSION_INVALIDATED` so memory and storage never diverge.
- **Crash recovery**: Opening a session whose persisted status is `"running"` immediately transitions it to `"interrupted"`, preserving committed history without replaying unfinished model or tool calls. Hosts may then call `prompt()` or explicitly `continue()`.

## System Prompt Ownership

`pi-agent-core` persists system prompts and tool declarations as `role: "system"` messages in the transcript and ignores `initialState.systemPrompt` when reopening a transcript that already starts with a system message. On reopen, the harness preserves the transcript and appends a `system` patch message only when the host's `systemPrompt` differs from the active baseline, preserving prompt-cache prefixes ([src/system-prompt.ts](../src/system-prompt.ts)).

## Run Controls & Session Operations

- **Concurrency & live queues**: Concurrent `prompt()` / `continue()` calls reject with `SESSION_BUSY`. During an active run, `steer()` (injected after the current tool round) and `followUp()` (executed after the run would finish) queue messages; calling them while idle throws `SESSION_IDLE`, and `abort()` / run exit clears any unconsumed queue items.
- **Guardrails & long conversations**: Forwards `sessionId` (provider prompt-cache affinity) and `identity` (defaults to `{ attribution: null }`). Supports optional `maxTurns` tool-turn limits, exponential-backoff `retry` on transient provider errors, and manual / threshold / overflow `compact()` that never splits `toolCall`/`toolResult` pairs.
- **Management operations**: `fork()` (new `sessionId` + `parentSessionId`, rejects unsafe tool boundaries), idle-time `setModel()` / `setThinkingLevel()` / `setTitle()`, `reset(handoff?)`, and `getStats()`.
