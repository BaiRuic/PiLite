# 会话生命周期与一致性语义

> 源码单一信息源：[src/session.ts](../src/session.ts)、[src/types.ts](../src/types.ts)、[src/system-prompt.ts](../src/system-prompt.ts)、[src/compaction.ts](../src/compaction.ts)。

## 提交粒度与一致性

- **Run 级原子提交**：发起 `prompt()` / `continue()` 前先保存用户输入与 `status: "running"`，保存失败不启动执行；run 结束后将完整消息与终态一次写回。流式事件仅用于实时展示，不代表已落盘。
- **终态判定**：`pi-agent-core` 将模型错误与取消编码在末尾 `AssistantMessage.stopReason`（`"error" | "aborted"`）而非 reject。Harness 据此写入 `idle` / `aborted` / `error`，丢弃无内容的空 `aborted` 尾消息；非空 `aborted`/`error` 消息保留供展示，后续请求由 `pi-ai` 自动跳过。
- **保存失败回滚**：最终 `save()` 失败时，将内存消息与 `customEntries` 回滚至上次已提交快照并将当前会话句柄标为失效（`SESSION_INVALIDATED`），避免内存与存储分叉。
- **崩溃重开**：`openSession()` 遇到 `status: "running"` 时立即落盘为 `interrupted`，保留用户输入与历史且**不自动重跑**；重开后可直接新 `prompt()` 或显式调用 `continue()` 重试末尾未回复输入。

## `systemPrompt` 归属

`pi-agent-core` 将 system prompt 与工具声明作为 `role: "system"` 消息存入 transcript，恢复时若首条已是 `system` 会忽略 `initialState.systemPrompt`。因此重开会话保留原 transcript，仅当宿主传入的 `systemPrompt` 与当前状态不同时追加 `system` 更新消息，以兼顾更新生效与 prompt cache 复用（见 [src/system-prompt.ts](../src/system-prompt.ts)）。

## 运行控制与会话运维

- **并发与队列**：单会话同时仅允许一个 run，运行中重复调用 `prompt()`/`continue()` 报 `SESSION_BUSY`；运行中可通过 `steer()`（工具轮次后插队纠偏）与 `followUp()`（本轮结束后追问）排队（空闲态报 `SESSION_IDLE`，`abort()` 与 run 结束自动清空未消费队列）。
- **护栏与上下文管理**：透传 `sessionId`（复用 provider cache）与 `identity`（默认 `{ attribution: null }`）；支持 `maxTurns` 工具轮次护栏、`retry` 瞬时错误退避重试、以及手动/超阈值/上下文溢出自动 `compact()`（绝不拆分 `toolCall`/`toolResult` 对）。
- **会话操作**：支持 `fork()`（生成新 `sessionId` 与 `parentSessionId`，校验安全切分边界）、空闲态 `setModel()` / `setThinkingLevel()` / `setTitle()`、`reset(handoff?)` 与 `getStats()` 用量汇总。
