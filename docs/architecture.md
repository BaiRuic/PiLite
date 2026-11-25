# 架构与设计边界

> 本文档只记录动机、分层与关键取舍；具体类型定义与实现以 `src/` 源码为准。

## 动机

- **复用 `pi-agent-core`，不 fork `pi-coding-agent`**：`pi-agent-core` 已提供模型循环、工具调度、流式事件与取消机制。宿主应用负责自己的交互与工具，不需要从 `pi-coding-agent` 裁剪 CLI / TUI / 内置 coding tools。
- **恢复会话，不自动恢复执行**：借鉴 `pi-durable` 的宿主能力抽象（`Models` 注入、可移植存储、运行时隔离），但不引入持久化任务状态机与工具重放语义。进程崩溃后仅将未完成轮次标为 `interrupted`，交由宿主或用户显式决定是否 `continue()`。
- **零 Node.js 安装部署**：允许随宿主分发运行时，优先保障 `bun build --compile` 单文件打包链路（避免原生 C++ addon，同时保留 Bun 支持的 `node:*` 兼容 API）。

## 分层职责

| 层 | 职责 | 代码入口 |
| --- | --- | --- |
| `pi-agent-core` / `pi-ai` | Agent 循环、工具执行、流式事件、模型协议与 OAuth 鉴权 | 外部依赖 |
| `pi-harness` 核心 | 会话创建/重开、Run 级原子持久化、中断恢复、重试/压缩、Headless 扩展 | [src/session.ts](../src/session.ts)、[src/extensions/](../src/extensions/) |
| `pi-harness/storage/*` & `models/*` | 可选多端存储后端与统一模型/凭据/Embedding 组装 | [src/store/](../src/store/)、[src/models/](../src/models/) |
| 宿主应用 | 注入具体工具、选择存储与模型来源、实现 UI/API 与部署入口 | 调用方 |

## 明确的非目标

- **不内置 CLI / TUI**，不引入 `pi-tui` 或磁盘动态 `.ts` 插件加载（`jiti`）。
- **不内置 coding tools 与 `ExecutionEnv`**：自定义工具直接注入所需资源；仅当同一工具需跨本地与远程容器运行时，再考虑抽象执行环境。
- **不做多进程并发写同一会话**：单会话同一时刻只允许一个 active run。

## 单文件打包验证

最小宿主验证入口位于 [scripts/verify-bun-host.ts](../scripts/verify-bun-host.ts)，通过 `pnpm build:bun-verify`（附带 `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`）产出独立可执行文件并在无 Node.js 的纯净 `PATH` 中验证流式回复、工具调用、中断取消、崩溃重开与 `bun:sqlite` 持久化。
