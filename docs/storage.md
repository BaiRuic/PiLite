# Session Storage & Portable Backends

> Single source of truth: [src/types.ts](../src/types.ts), [src/store/query.ts](../src/store/query.ts), [src/store/contract.ts](../src/store/contract.ts), and [src/store/](../src/store/).

## `SessionStore` Contract

`SessionStore` operates on atomic session snapshots:

- `load(sessionId)` — returns a defensive copy of the snapshot, or `null` if missing.
- `save(sessionId, snapshot)` — atomically replaces the snapshot (`version`, `model`, `thinkingLevel`, `title`, `parentSessionId`, `messages`, `customEntries`, `status`, `lastError`, `createdAt`, `updatedAt`).
- `delete(sessionId)` — deletes the session and returns whether it existed.
- `list(query?)` — returns `{ items, nextCursor? }` of `SessionSummary` sorted by `updatedAt DESC, sessionId ASC`, supporting `parentSessionId` / `status` filters and portable Web-API base64url keyset cursor pagination (`limit`, `cursor`).
- `close?()` — optional resource cleanup.

## Built-in Backends

Each backend is exported on its own subpath to isolate runtime-specific imports (`node:fs`, `node:sqlite`, `bun:sqlite`, `indexedDB`), and all backends share [src/store/contract.ts](../src/store/contract.ts):

| Backend | Subpath | Notes | Source |
| --- | --- | --- | --- |
| Memory | `pi-harness/storage/memory` | In-memory `Map` with defensive cloning; ideal for tests and ephemeral hosts | [src/store/memory.ts](../src/store/memory.ts) |
| SQLite | `pi-harness/storage/sqlite` (+ `/node`, `/bun`) | Thin `SqliteDatabase` adapter isolating `node:sqlite` and `bun:sqlite`, schema migrations, table prefixes, native SQL pagination, zero native C++ addons | [src/store/sqlite/](../src/store/sqlite/) |
| JSONL | `pi-harness/storage/jsonl` (+ `/node`) | Portable `JsonlFileSystem` core + `node:fs` adapter; append-only snapshots with truncated-tail recovery and log compaction | [src/store/jsonl/](../src/store/jsonl/) |
| IndexedDB | `pi-harness/storage/indexeddb` | Browser / Web Worker persistence with zero Node globals | [src/store/indexeddb.ts](../src/store/indexeddb.ts) |
