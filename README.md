# pi-harness

轻量、可嵌入、无头（Headless）的 TypeScript Agent Harness，基于 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 与 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 构建。

为桌面端、服务端、CLI 或边缘宿主提供一个**开箱即用但不绑死 UI / 工具 / 运行时**的 Agent 会话与模型管理层，并支持通过 Bun 单文件编译交付到无 Node.js 环境。

## 亮点与核心能力

- **轻量无头会话引擎**：Run 级原子持久化与失败回滚、崩溃重开识别 `interrupted`（不自动重放副作用）、`abort()` 取消收敛、运行中 `steer()` 插队纠偏与 `followUp()` 追问排队。
- **长对话与会话运维**：独立分叉 `fork()`（禁止在 `toolCall`/`toolResult` 中间切分）、空闲态切换模型/思考等级/标题、`reset(handoff?)`、`getStats()` 用量汇总、瞬时错误自动重试（`retry`）、手动/超阈值/溢出自动上下文压缩（`compact`）。
- **多端可移植存储**：`SessionStore` 支持按 `parentSessionId`/`status` 过滤与游标分页，内置 Memory、SQLite（Node `node:sqlite` + Bun `bun:sqlite`，零原生 C++ addon）、JSONL（崩溃半截尾行修复）、IndexedDB 四套后端并共用同一套契约测试。
- **统一模型管理（可选 `pi-harness/models`）**：支持 `Models | (() => Models)` 热替换；通过 `ModelHub` 统一组装内置 OAuth 订阅登录（CLI 桥接）、自建 JWT/API 后端动态拉取、本地抽象配置源（JSON/JSONC + 覆盖 + `/models` 探测）、SQLite/文件凭据与目录缓存，以及平级 OpenAI 兼容 `EmbeddingProvider`。
- **Headless 扩展层（`pi-harness/extensions`）**：代码注册 `ExtensionFactory`，支持动态启停工具、嵌套 `ctx.executeTool()`、全生命周期拦截钩子、随快照原子持久化的 `appendEntry`，以及可选 `ui`/`exec` 桥接。
- **单文件部署友好**：零原生 C++ 依赖，完整验证 `bun build --compile` 单文件可执行产物在无 Node.js 环境中运行。

## 与 `pi-durable` / `pi-coding-agent` 的区别

| 维度 | `pi-coding-agent` | `pi-durable` | `pi-harness`（本项目） |
| --- | --- | --- | --- |
| **定位** | 面向编程场景的完整 CLI / TUI 应用 | 持久化任务状态机（Workflow / Durable Execution） | **可嵌入的无头 Agent 运行层库** |
| **交互界面与内置工具** | 自带 TUI、CLI 与 `read`/`write`/`edit`/`bash` 等 coding tools | 无 UI；可选内置 coding tools + `ExecutionEnv` | **不内置 UI 与 coding tools**，全部由宿主按需注入 |
| **崩溃恢复策略** | 恢复本地会话历史 | 持久化任务 checkpoint，重启后**自动恢复并重放未完成执行** | **只恢复会话历史，不自动重放**：崩溃轮次标为 `interrupted`，由宿主显式决定 `continue()` 或新 `prompt()` |
| **存储与部署复杂度** | 面向本地文件系统（JSONL） | 需维护文档/任务图/信号/调度器（适配云端/DO） | 轻量 Run 级快照 `SessionStore`（Memory / SQLite / JSONL / IndexedDB），零原生 addon，适配 Bun 单文件分发 |
| **扩展与模型接入** | 支持磁盘动态 `.ts` 插件（`jiti`）与完整 `ModelRuntime` | 纯代码注册扩展，纯注入 `Models` | 代码注册 headless 扩展（无 `jiti`/TUI 依赖）；核心纯注入 `Models \| (() => Models)`，同时提供轻量可选 `pi-harness/models` 组装 OAuth / JWT 后端 / 本地配置 / Embedding |

**选型直觉**：
- 需要开箱即用的终端编程助手 → 用 `pi-coding-agent`。
- 需要跨进程/云端宕机自动断点续跑长任务与定时/信号工作流 → 用 `pi-durable`。
- 需要在自己的桌面端/服务端/产品里嵌入一个**可控、轻量、不强绑定 UI 和重任务引擎**的 Agent 会话层 → 用 `pi-harness`。

## 快速上手

```ts
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createSession } from "pi-harness";
import { createModelHub } from "pi-harness/models";
import { createSqliteCredentialStore, createSqliteModelsStore } from "pi-harness/models/sqlite";
import { openNodeSqliteDatabase, SqliteSessionStore } from "pi-harness/storage/sqlite/node";

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

## 包导出入口

| Import Path | 说明 | 源码入口 |
| --- | --- | --- |
| `pi-harness` | 核心会话 API（`createSession`、`openSession`、`HarnessSession`、`InMemorySessionStore` 等） | [src/index.ts](src/index.ts) |
| `pi-harness/extensions` | Headless 扩展 API（`defineTool`、`ExtensionRunner` 及类型） | [src/extensions/index.ts](src/extensions/index.ts) |
| `pi-harness/models` | 可移植模型管理核心（`createModelHub`、`createApiBackendProvider`、`LocalModelSource`、`createOpenAIEmbeddingProvider`） | [src/models/index.ts](src/models/index.ts) |
| `pi-harness/models/sqlite` | 可移植 SQLite `CredentialStore` & `ModelsStore` | [src/models/sqlite/index.ts](src/models/sqlite/index.ts) |
| `pi-harness/models/node` | Node/Bun 文件存储、JSONC 本地源、CLI OAuth 交互桥接 | [src/models/node/index.ts](src/models/node/index.ts) |
| `pi-harness/storage/*` | `memory` / `sqlite` (`node`, `bun`) / `jsonl` (`node`) / `indexeddb` | [src/store/](src/store/) |
| `pi-harness/testing` | `SessionStore` / `CredentialStore` / `ModelsStore` 公共契约测试 | [src/testing.ts](src/testing.ts) |

## 设计文档

文档以源码为单一信息源，仅记录架构边界、关键取舍与索引路径：

- [docs/architecture.md](docs/architecture.md) — 动机、分层边界、非目标与 Bun 部署策略
- [docs/session.md](docs/session.md) — 会话生命周期、原子提交、崩溃恢复、队列与压缩重试
- [docs/storage.md](docs/storage.md) — `SessionStore` 契约、过滤分页与多端存储后端
- [docs/models-and-extensions.md](docs/models-and-extensions.md) — 模型注入/热替换、`ModelHub`、Embedding 与 Headless 扩展层

## 开发与验证

```bash
pnpm check            # Biome 格式/Lint 检查 + 严格 TypeScript 类型检查
pnpm check:fix        # 自动格式化/修复 + 类型检查
pnpm test             # 构建并运行全部 Vitest 测试
pnpm test:bun         # 运行 Bun SQLite 契约测试
pnpm build:bun-verify # 编译单文件 Bun 验证产物 dist/verify-bun-host
```
