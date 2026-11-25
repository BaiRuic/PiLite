# 模型接入与 Headless 扩展

> 源码单一信息源：[src/models/](../src/models/)、[src/extensions/](../src/extensions/)。

## 模型接入

### 核心会话层（零侵入）
- 会话只持久化 `ModelRef = { provider, modelId }`，不存密钥或 provider 实现。
- 认证、OAuth 刷新与目录管理完全交由 `pi-ai` `Models` 处理；核心支持传入固定 `Models` 或热替换工厂 `() => Models`（`ModelsProvider`），每次 run 与模型请求前重新解析，模型缺失时显式抛 `MODEL_NOT_FOUND`。

### 可选模型管理模块（`pi-harness/models*`）
在不侵入 `HarnessSession` 的前提下，把常见宿主需求封装为薄组装层，最终统一输出标准 `Models`：

- **`pi-harness/models`（可移植核心）**：
  - `createModelHub()`：统一组装内置/OAuth provider、自建后端、本地配置源及持久化存储，通过 `hub.asModelsProvider()` 热接入会话。
  - `createApiBackendProvider()`：面向自建 HTTP/JWT 后端，支持动态 `getAuth()`、混合 wire 协议懒加载、默认兼容 OpenAI `/models` 解析或自定义 `parseModels`/`fetchModels`。
  - `LocalModelSource` 与覆写合并器：抽象本地配置来源，支持无密钥本地服务（Ollama/vLLM）自动探测与 `compat` 默认值、对内置厂商做 `baseUrl`/`headers`/`modelOverrides` 局部覆写；默认仅开启 `$ENV`/`${ENV}` 插值，`!command` 需显式传入 `execCommand` 才启用。
  - `EmbeddingProvider` / `createOpenAIEmbeddingProvider()`：与 `pi-ai` 对话/分类模型平级，支持在 `ModelHub` 中声明、按鉴权状态筛选（`getAvailableEmbeddingModels()`）、选择并复用 `ModelHub` 鉴权调用 OpenAI 兼容 `/embeddings`，附带稳定 `fingerprint()` 供向量索引重建判断。
- **`pi-harness/models/sqlite`**：复用 `SqliteDatabase` 提供 `SqliteCredentialStore`（事务串行防并发双刷 OAuth token）与 `SqliteModelsStore`（目录离线缓存），可与 `SqliteSessionStore` 共用同一 DB。
- **`pi-harness/models/node`**：提供原子 JSON 文件存储（`FileCredentialStore`/`FileModelsStore`）、JSON/JSONC 本地源（`createJsonFileModelSource()`）与纯 `node:readline` 的 OAuth CLI 交互桥接（`createCliAuthInteraction()`）。

## Headless 扩展层（`pi-harness/extensions`）

参考 `pi-coding-agent` 的扩展接口，由宿主以代码形式注册 `ExtensionFactory = (pi) => void | Promise<void>`，不含磁盘加载与 TUI 依赖：

- **工具管理与嵌套执行**：支持 `registerTool`、`getActiveTools`/`setActiveTools` 动态启停；工具内可通过 `ctx.executeTool(name, args, options?)` 基于 `pi-agent-core` 的 `runToolCall()` 调用其他已注册工具（含对模型隐藏的内部工具），统一经过 schema 校验与 `tool_call`/`tool_result` 钩子并透传 `parentToolCallId`。
- **生命周期与拦截钩子**：支持 `session_start`/`session_shutdown`、`before_agent_start`、`context`、`tool_call`、`tool_result`、`before_provider_request`/`after_provider_response` 及全部 core 事件；未支持事件输出 `deferred_event` 诊断而不阻塞运行。
- **状态与宿主桥接**：`pi.appendEntry()` 写入的自定义条目随会话快照原子提交与回滚；提供共享 `pi.events` 总线与可选 `ui`/`exec` 适配器。
