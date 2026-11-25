# 会话存储与多端后端

> 源码单一信息源：[src/types.ts](../src/types.ts)、[src/store/query.ts](../src/store/query.ts)、[src/store/contract.ts](../src/store/contract.ts) 及各后端目录。

## `SessionStore` 契约

`SessionStore` 面向快照而非事件流，包含：

- `load(sessionId)`：返回快照防御拷贝，不存在返回 `null`。
- `save(sessionId, snapshot)`：原子替换整份快照（含 `version`、`model`、`thinkingLevel`、`title`、`parentSessionId`、`messages`、`customEntries`、`status`、`lastError`、`createdAt`、`updatedAt`）。
- `delete(sessionId)`：删除会话并返回是否存在。
- `list(query?)`：返回 `SessionSummary` 分页 `{ items, nextCursor? }`，按 `updatedAt DESC, sessionId ASC` 稳定排序，支持 `parentSessionId` / `status` 过滤与基于纯 Web API base64url 的 keyset 游标分页（`limit` / `cursor`）。
- `close?()`：可选资源释放。

## 内置后端

所有后端通过独立 subpath 导出，避免将运行时特定依赖（如 `node:fs`、`bun:sqlite`）带入不相关环境，并全部通过 [src/store/contract.ts](../src/store/contract.ts) 共享契约测试：

| 后端 | Export 路径 | 实现要点 | 源码 |
| --- | --- | --- | --- |
| Memory | `pi-harness/storage/memory` | 内存 Map + 深拷贝隔离，适合测试与短生命周期场景 | [src/store/memory.ts](../src/store/memory.ts) |
| SQLite | `pi-harness/storage/sqlite` + `/node` + `/bun` | 极薄 `SqliteDatabase` 抽象隔离 `node:sqlite` 与 `bun:sqlite`，支持版本迁移、表前缀隔离与原生 SQL 游标分页，零原生 C++ addon | [src/store/sqlite/](../src/store/sqlite/) |
| JSONL | `pi-harness/storage/jsonl` + `/node` | 抽象 `JsonlFileSystem` + `node:fs` 适配，追加写快照、崩溃半截尾行自动恢复与压缩 | [src/store/jsonl/](../src/store/jsonl/) |
| IndexedDB | `pi-harness/storage/indexeddb` | 纯浏览器/Web Worker 持久化，不依赖 Node API | [src/store/indexeddb.ts](../src/store/indexeddb.ts) |
