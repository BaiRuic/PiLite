# 轻量 Headless Agent Harness：动机与初步方案

## 动机

`pi-agent-core` 已经提供模型调用循环、工具调度、流式事件和取消机制。`pi-coding-agent` 在此基础上加入了面向编程场景的 CLI、交互界面、会话管理和内置工具。我们的宿主应用会自己负责交互，只需要一个可以嵌入的 agent 运行层，因此直接复用 `pi-agent-core`，不从 `pi-coding-agent` fork 后再做删减。

`pi-durable` 支持在进程重启后恢复未完成的执行，因此需要持久化任务状态、checkpoint，并定义工具重放策略。当前只要求**恢复会话，不自动恢复执行**：已保存的历史可以重新打开，崩溃时未完成的一轮标记为中断，不自动重跑模型请求或工具。目标是借鉴 `pi-durable` 对宿主能力的抽象，而不是引入它的持久化任务模型。

部署要求是**用户不需要安装 Node.js，但允许随宿主携带 JS 运行时**。优先验证 Bun 打包路径；构建机可以使用 Node/npm，源码也不必为了这个部署目标移除 Bun 支持的 `node:*` 兼容 API。

## 初步方案

| 层 | 职责 |
| --- | --- |
| `pi-agent-core` | 驱动 agent 循环、调用工具、产生流式事件和处理取消 |
| Headless harness | 创建或打开会话、恢复历史、解析模型引用、保存会话和处理运行中断 |
| 宿主应用 | 组装模型、工具和存储；决定呈现方式和部署入口 |

第一版交付为可嵌入的 TypeScript 库，不提供 CLI、TUI 或内置 coding tools。宿主直接注入工具；事件和取消沿用 core 的能力，不另建一套协议。运行入口由 harness 控制，以确保调用不会绕过会话保存边界。

- 单会话同一时刻只允许一个运行中的 run，运行期间再次调用 `prompt()`/`continue()` 直接拒绝；支持在运行期间通过 `steer()`（工具轮次后插队纠偏）与 `followUp()`（本轮结束后自动追问）排队消息（`steeringMode` / `followUpMode` 可配置，空闲态拒绝并返回 `SESSION_IDLE`，`abort()` 及 run 结束时自动清空未消费队列）。
- 透传 `sessionId` 给 `Agent` 以复用 provider 缓存；透传 `identity`（默认不附带 `pi` 归属头，由宿主按需指定）；通过 `finishTurn` 提供可选的 `maxTurns` 护栏防止 headless 场景下工具死循环。
- 会话操作与长对话支持：支持独立分叉 `fork()`（生成新 `sessionId`、禁止在 `toolCall`/`toolResult` 对中间切分）、idle 态切换 `setModel()` / `setThinkingLevel()` / `setTitle()`、`reset(handoff?)`、`getStats()` 用量汇总，以及按需开启的瞬时错误自动重试（`retry`）与手动/自动上下文压缩（`compact()` / `compaction`，包含超阈值与上下文溢出恢复）。

### 模型：沿用 `pi-durable` 的注入方式

1. 宿主通过 `pi-ai` 的 `createModels()` 创建模型注册表、注册 provider（动态目录 provider 由宿主在注入前完成 `models.refresh()`）；认证完全在 `Models`/provider 一侧处理，harness 不额外注入 `getApiKey` 以免覆盖 OAuth 等凭据解析。
2. 会话只保存 `ModelRef = { provider: string; modelId: string }`，不保存凭证或 provider 实现。
3. harness 支持传入固定 `Models` 实例或热替换工厂 `() => Models`（`ModelsProvider`），每次 run 与模型请求前按 `ModelRef` 重新解析最新模型配置；模型不可用时显式报错（`MODEL_NOT_FOUND`），不静默切换到其他模型。
4. 可选模型管理子模块（保持核心会话层零侵入，最终统一产出 `pi-ai` `Models`）：
   - `pi-harness/models`（可移植核心）：提供总装入口 `createModelHub()`（输出热替换 `asModelsProvider()`）、自建后端工厂 `createApiBackendProvider()`（支持 JWT/动态请求头、OpenAI `/models` 自动发现或自定义 `parseModels`/`fetchModels`、混合协议懒加载）、本地抽象加载源 `LocalModelSource` 与配置合并器（支持本地无密钥服务自动探测、内置厂商 `baseUrl`/`headers`/`modelOverrides` 局部覆写，默认仅启用 `$ENV` 插值，`!command` 需显式 opt-in），以及平级 `EmbeddingProvider` / `createOpenAIEmbeddingProvider()`（支持通过 `ModelHub` 统一查看、按鉴权筛选、选择并复用 provider 鉴权调用 OpenAI 兼容 `/embeddings` 接口）。
   - `pi-harness/models/sqlite`：复用可移植 `SqliteDatabase` 提供 `SqliteCredentialStore`（事务串行防并发双刷 OAuth token）与 `SqliteModelsStore`（动态目录离线缓存，可与 `SqliteSessionStore` 共用同一数据库文件）。
   - `pi-harness/models/node`：提供原子 JSON 文件版 `FileCredentialStore` / `FileModelsStore`、JSON/JSONC 本地源 `createJsonFileModelSource()` 以及纯 `node:readline` 的 OAuth CLI 交互桥接 `createCliAuthInteraction()`。

### 会话存储与恢复

定义面向会话的 `SessionStore`，提供 `load(sessionId)`（不存在返回 `null`）、原子替换快照的 `save(sessionId, snapshot)`、`delete(sessionId)`、`list(query?)`（支持按 `parentSessionId` / `status` 过滤与基于 `updatedAt DESC, sessionId ASC` 的游标分页 `{ items, nextCursor? }`）及可选 `close?()`。快照包含格式版本、模型引用、思考等级、可选标题与父会话引用、消息历史、可选扩展自定义条目（`customEntries`）和运行状态（`idle | running | aborted | interrupted | error`）。参考 `pi-durable` 的多后端 + 运行时隔离抽象，通过独立 subpath 提供内存、SQLite（可移植核心 + `node:sqlite` / `bun:sqlite` 适配器）、JSONL（可移植 `JsonlFileSystem` 核心 + `node:fs` 适配，支持崩溃半截尾行恢复与压缩）和 IndexedDB 后端，所有后端共用同一套契约测试。当前不支持多个进程并发写同一会话。

- **提交粒度（Run 级）**：开始运行前，保存用户输入和 `running` 状态，保存失败就不启动运行；运行结束后，将完整消息和最终状态一次提交。流式事件可提前展示，但不代表已经持久化。这是第一版为简化原子边界的有意取舍——崩溃时不会产生半截工具调用，代价是同一次 run 中已完成的中间工具轮次也会回退。
- **终态判定与取消**：`pi-agent-core` 会把模型错误和取消编码在末尾 `AssistantMessage.stopReason`（`"error" | "aborted"`）中，而不会让 `prompt()` reject。harness 根据取消状态与末尾 `stopReason` 写入最终状态（`idle` / `aborted` / `error`），过滤无内容且无错误信息的空 `aborted` 尾消息；保留的非空 `aborted` / `error` 消息可供宿主展示，后续请求依赖 `pi-ai` 的 `transformMessages` 自动跳过它们。`abort()` 记录启动前取消意图并等待本轮 settle 与最终保存完成后返回。
- **保存失败一致性**：如果最终 `save()` 失败，将内存中的会话状态回滚到上次已提交快照（或将当前会话句柄标记失效要求重开），并向宿主报错，避免内存与存储分叉。
- **崩溃重开与后续动作**：重开会话时，如果上次仍是 `running`，将其标记为 `interrupted`，保留用户输入和之前已提交的历史；不把不完整的工具调用记录送回模型，也不自动重放（工具已造成的外部副作用不会撤销）。重开后会话恢复可交互，宿主可直接发起新 `prompt()`，或显式调用 `continue()` 由用户决定是否重试末尾未回复的输入。
- **`systemPrompt` 归属**：`pi-agent-core` 将 system prompt 与工具声明作为 `role: "system"` 消息保存在 `messages` 中，恢复历史时若首条已是 `system` 消息会忽略 `initialState.systemPrompt`。因此重开会话时保留原 transcript，仅当宿主传入的 `systemPrompt` 与当前状态不同时，按 `pi-agent-core` 约定追加一条 `system` 更新消息，以兼顾更新生效与 prompt cache 复用。
- **持久化后端与 Bun 兼容**：若持久化后端选 SQLite，通过极薄的数据库适配器隔离运行时驱动（Node 接 `node:sqlite`，Bun 接 `bun:sqlite`），避免引入无法随 `bun build --compile` 单文件打包的原生 C++ addon；也可先用原子文件快照（写临时文件 + rename）验证契约与打包链路。

### 工具与 `ExecutionEnv`

不内置 `read`、`write`、`edit`、`bash` 等 coding tools。自定义工具先直接注入需要的业务客户端或资源。仅当同一工具确实要跨本地工作区和远程容器运行时，再参考 `pi-durable` 的 `ExecutionEnv` 提取所需的文件或进程能力。工具运行在哪里与会话历史存在哪里是两个独立的决定。

### 扩展接口（Headless）

参考 `pi-coding-agent` 的扩展模型提供轻量 headless 扩展层（`ExtensionFactory = (pi) => void | Promise<void>`），由宿主以代码方式显式注册，不引入磁盘动态 `.ts` 加载（`jiti`）和 TUI 依赖：

- 支持注册与动态启停工具（`registerTool`、`getActiveTools` / `setActiveTools`）、嵌套工具调用（`ctx.executeTool()` 基于 `pi-agent-core` 的 `runToolCall()` 执行并透传 `parentToolCallId` 经过校验与 `tool_call`/`tool_result` 钩子）、拦截与生命周期钩子（`session_start` / `session_shutdown`、`before_agent_start`、`context`、`tool_call`、`tool_result`、`before_provider_request` / `after_provider_response` 及全部 core 事件）。
- 支持 `appendEntry` 持久化扩展自定义条目（随快照原子提交与回滚）、共享 `events` 总线，以及宿主按需注入的 `ui` / `exec` 桥接适配器；未支持的事件名接受注册并输出 `deferred_event` 诊断，不阻塞运行。

## 第一阶段验收

- 用一个真实 provider 和一个宿主注入的只读工具，跑通流式回复、工具调用、取消（含取消后终态与历史一致性）以及 `maxTurns` 护栏。
- 使用持久化后端，验证正常退出后可打开同一会话（含重开时变更 `systemPrompt` 生效）；在流式输出或工具调用期间强制结束进程后，重开可识别 `interrupted` 且不自动重跑，并验证最终保存失败时内存状态不与存储分叉。
- 用最小宿主入口验证 Bun 打包产物（加 `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`）在未安装 Node.js 的目标机器上可运行（验证入口不是面向用户的 CLI）。

## 本地参考

- [`pi-agent-core`：Agent、流式事件与工具](tmp_refs/pi/packages/agent/README.md)
- [`pi-coding-agent`：会话层与保存失败回滚参考](tmp_refs/pi/packages/coding-agent/src/core/agent-session.ts)、[SessionManager](tmp_refs/pi/packages/coding-agent/src/core/session-manager.ts)
- [`pi-durable`：模型接入与会话配置](tmp_refs/pi/packages/durable/README.md#quick-start)、[执行环境](tmp_refs/pi/packages/durable/README.md#environment)、[存储](tmp_refs/pi/packages/durable/README.md#storage)
- [`PI-Desktop`：system transcript 更新](tmp_refs/PI-Desktop/packages/agent-runtime/src/system-transcript.ts)、[默认 identity](tmp_refs/PI-Desktop/packages/agent-runtime/src/agent-identity.ts)、[中断恢复](tmp_refs/PI-Desktop/crates/host-core/src/db/migrations.rs)
