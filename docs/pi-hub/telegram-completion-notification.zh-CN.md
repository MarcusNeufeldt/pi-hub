# Pi Hub 完成通知（Telegram）设计

> 状态：Implemented（V1）
> 日期：2026-08-07
> 依赖：`telegram-integration-design.zh-CN.md`（阶段二通知投递）、`scheduled-execution-design.zh-CN.md`

## 1. 设计目标

让用户在「任务或 Agent 执行完之后」能收到 Telegram 通知，并能在发起时**自行选择是否通知**。覆盖两类来源：

| 来源 | 配置位置 | 粒度 |
|---|---|---|
| 定时任务（Scheduler） | 任务创建/编辑表单 | 每任务「成功时通知 / 失败时通知」两个开关 |
| 手动跑 Agent（Web 聊天） | 聊天输入栏 | 每会话 sticky 开关（同完成提示音） |

核心体验：

- 定时任务：配置时勾选 → 执行结束按标志投递卡片（含「再次执行」按钮）。
- 手动任务：点亮输入栏的纸飞机按钮 → 该会话每次 prompt 完成（成功/失败）→ Telegram 收到完成卡片。

设计原则（沿用既有 Telegram 集成）：

> 通知失败永远只记 Warning，绝不改写已完成的 Agent/Task 运行状态（§30.10）；
> Token 永不落库/日志/响应（§21、§23.2）；
> 投递一律经 outbox，绝不在请求路径里直连 Telegram API（§18.1）。

---

## 2. 关键判断与既有缺口

实现前发现两处既有缺口，本方案一并补齐：

### 2.1 定时任务：标志已存但「既不可编辑也不生效」

`ExecutionOptions` 早已含 `notifyOnSuccess`/`notifyOnFailure`（默认 `false`/`true`），DB、DTO、UI 数据流都通了，但：

- `components/TasksConfig.tsx` 当时把它们声明成只读常量，注释写着「Notification toggles are not user-editable in V1 UI」；
- `modules/telegram/telegram-task-notifier.ts` 的三个 hook **从未读取**这两个标志——只要有 owner/operator 私聊就发，无视用户意愿。

→ 方案：UI 改可编辑（§4.1），Notifier 按快照门控（§4.2）。

### 2.2 手动跑 Agent：完全没有通知链路

Web 聊天的完成信号（`prompt_done`）只在客户端 SSE 里流动，没有任何「完成 → 外部通知」的出口。

→ 方案：新增 sticky 开关 + 客户端完成回调 + 服务端通知路由（§4.3）。

---

## 3. 数据流

### 3.1 定时任务

```text
TasksConfig(勾选) ──createTask──▶ scheduled_tasks.notify_on_success/failure
                                       │ (执行时快照进 task_runs.execution_options_snapshot_json)
SchedulerRuntime.execute ──▶ safeNotify(onRunSucceeded/Failed)
                                       │
              TelegramTaskNotifier.notify()
                  ├─ parseExecutionOptions(run)  ← 读快照
                  ├─ notifyOnSuccess===false? → return（静默）
                  └─ OutboxWriter.enqueue() ──▶ OutboxWorker(leader) ──▶ Telegram
```

### 3.2 手动跑 Agent

```text
ChatInput(纸飞机按钮) ──toggle──▶ localStorage(pi-telegram-notify-enabled)
useAgentSession.handleSend ──记录 currentRunPromptRef/StartedAt──▶ prompt
        │ SSE
        ├─ prompt_done  ─▶ firePromptFinished(runId,"success")
        └─ prompt_error ─▶ firePromptFinished(runId,"failed",errMsg)
                                       │ (按 runId 去重，首事件胜出)
                  onPromptFinished(info)
                                       │
              ChatWindow.wrappedOnPromptFinished
                  ├─ notifyEnabledRef.current? 否 → 跳过
                  └─ POST /api/integrations/telegram/notify-run
                                       │
              路由：补全 session 元数据 + 入 outbox
                  ├─ resolveSessionPath / readSessionHeader / getSessionEntries
                  │   → sessionName(cwd) + 最后一条 assistant 文本
                  └─ notifyManualRun(store, input) ──▶ OutboxWriter ──▶ Telegram
```

---

## 4. 实现细节

### 4.1 定时任务 UI 可编辑（`components/TasksConfig.tsx`）

- `notifySuccess`/`notifyFailure` 由常量改为 `useState`，初值取自 `editing?.execution.*`。
- 「Agent 配置」折叠区内，工具勾选之后新增「Telegram 通知」分组：两个 `CheckboxOption` + 一行灰色提示（需先配置 Telegram 集成）。
- `handleSubmit` 原样把两个状态写进 `execution`，无需改服务端。

> 注：复制任务路径仍保留 `notifyOnSuccess: false` 的旧行为（spread 保留 `notifyOnFailure`），属既有逻辑，未在本方案内调整。

### 4.2 Notifier 门控（`modules/telegram/telegram-task-notifier.ts`）

新增 `parseExecutionOptions(run)`：从 `run.executionOptionsSnapshotJson` 解析（解析失败回退服务默认 `success:false/failure:true`，永不抛错）。门控规则：

| 事件 | 触发条件 |
|---|---|
| `onRunStarted` | `notifyOnSuccess \|\| notifyOnFailure`（两个都关则全静默，避免「只收到开始、收不到结果」的噪声） |
| `onRunSucceeded` | `notifyOnSuccess === true` |
| `onRunFailed` | `notifyOnFailure === true` |

同时把 `esc/fmtTime/fmtDuration` 抽到共享模块（§4.5），减少重复。

### 4.3 手动跑 Agent 通知

#### 4.3.1 sticky 开关 `hooks/useTelegramNotify.ts`

镜像 `useAudio`：

- `notifyEnabled`（localStorage `pi-telegram-notify-enabled`，默认 `false`）+ `notifyEnabledRef`；
- `telegramConfigured`：挂载时及切回前台时调 `getTelegramStatus()`，当 `configured && userCount > 0` 才为真——保证「没地方可发时按钮直接隐藏」，而非点了无效；
- 返回 `{ notifyEnabled, notifyEnabledRef, onNotifyToggle, telegramConfigured, refreshConfigured }`。

#### 4.3.2 完成回调 `hooks/useAgentSession.ts`

新增可选 `onPromptFinished(info)`：

- `handleSend` 起跑时写入 `currentRunPromptRef`（指令）、`currentRunStartedAtRef`（开始时间）、并把 `notifiedRunFinishedRef` 置为 `promptRunId - 1`（标记本 run 尚未通知）；
- `firePromptFinished(runId, status, errMsg?)`：按 `notifiedRunFinishedRef === runId` 去重，**首个终态事件胜出**（错误后自动重试成功不会重复触发），调用 `onPromptFinished`；
- 触发点：`prompt_done` → `"success"`；`prompt_error` → `"failed"` + errorMessage。
- Bash 命令（`!cmd`）与 extension 注入的 run 不经此路径——前者提前 return 不走 prompt 流；后者只到 `agent_settled`，不在 V1 通知范围。

#### 4.3.3 聊天层接线 `components/ChatWindow.tsx`

- `useTelegramNotify()` 取开关与 `configured`；
- `wrappedOnPromptFinished`：读 `notifyEnabledRef.current`（避免运行中切换回溯触发），`void notifyTelegramManualRun(...).catch(warn)`——fire-and-forget，失败只 warn；
- 把 `onPromptFinished` 传入 `useAgentSession`；把三个 prop 传入 `ChatInput`。
- `wrappedOnPromptFinished` deps 只含稳定的 `notifyEnabledRef`，不会令 `handleAgentEvent` 频繁重建。

#### 4.3.4 输入栏按钮 `components/ChatInput.tsx`

- 新增 prop `notifyTelegramEnabled / onNotifyTelegramToggle / telegramConfigured`；
- 在提示音按钮右侧渲染纸飞机按钮，**仅当 `telegramConfigured && onNotifyTelegramToggle !== undefined`** 时显示；
- 启用态用 `--accent` 实心高亮、禁用态 `--text-dim` + 0.55 透明度（视觉与提示音按钮一致）。

#### 4.3.5 通知路由 `app/api/integrations/telegram/notify-run/route.ts`（POST）

请求体：`{ sessionId, status, prompt?, errorMessage?, startedAt?, finishedAt? }`。

- 解析 `getTelegramRuntime()?.getStore()`；未运行 → `{ ok:true, notified:false, reason:"telegram_not_configured" }`（**始终 200**，保证聊天 UI 永不报错）；
- `resolveSessionPath` → `readSessionHeader`（取 cwd）→ `extractSessionMetadata`（扫描 entries：最新的 `session_info` 取会话名、最新的 assistant text 取结果摘要，≤4000 字符）；
- 调 `notifyManualRun(store, input)` 入 outbox；
- 返回 `{ ok:true, notified:<n>, skipped:<b> }`。

#### 4.3.6 渲染/投递 `modules/telegram/telegram-manual-run-notifier.ts`

`notifyManualRun(store, input)`：

- `resolveOwnerChatTargets(store)`（与任务通知相同的默认规则：所有 enabled 的 owner/operator 用户的私聊根会话）；
- 复用 outbox + `task_success`/`task_failure` 事件类型（无需新增枚举/迁移）；
- dedupeKey：`manual-run:{sessionId}:{finishedAt|now}:{chatId}:{threadId}`；
- 文案：`✅ 手动任务完成` / `❌ 手动任务失败`，含会话名、开始/完成时间或耗时、指令摘要（≤400 字）、结果/错误摘要（≤1200 字）、目录、Session id，以及（配置了 `publicUrl` 时）`打开会话` 超链接。

> V1 不附 inline 按钮：任务通知的 rerun 按钮绑的是「按 taskId 重跑」，对手动会话语义不符；transport 暂不支持 URL 按钮，故以文本超链接代替。

### 4.4 客户端封装 `lib/telegram-client.ts`

新增 `notifyTelegramManualRun(body)`：`sendJson("POST", "/api/integrations/telegram/notify-run", body)`，返回 `{ ok, notified, reason?, skipped? }`。

### 4.5 共享格式 `modules/telegram/telegram-format.ts`（新）

抽出 `esc / fmtTime / fmtDuration / resolveOwnerChatTargets`，供 `TelegramTaskNotifier` 与 `notifyManualRun` 共用，避免两处漂移。`modules/telegram/index.ts` 同步导出 `notifyManualRun`、类型与格式辅助函数。

### 4.6 i18n（en + zh-CN）

| key | en | zh-CN |
|---|---|---|
| `chat.enableTelegramNotify` | Notify on Telegram when done | 完成后通过 Telegram 通知 |
| `chat.disableTelegramNotify` | Disable Telegram completion notification | 关闭 Telegram 完成通知 |
| `task.create.notifyTitle` | Telegram Notification | Telegram 通知 |
| `task.create.notifySuccess` | Notify on success | 成功时通知 |
| `task.create.notifyFailure` | Notify on failure | 失败时通知 |
| `task.create.notifyHint` | Sent to your Telegram after the run finishes (requires Telegram integration). | 任务执行结束后发送到 Telegram（需先配置 Telegram 集成）。 |

---

## 5. 文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `modules/telegram/telegram-format.ts` | 共享 `esc/fmtTime/fmtDuration/resolveOwnerChatTargets` |
| `modules/telegram/telegram-manual-run-notifier.ts` | `notifyManualRun()`：渲染手动任务卡片并入 outbox |
| `modules/telegram/telegram-manual-run-notifier.test.mjs` | 4 例（成功/失败/无目标静默/publicUrl 链接） |
| `app/api/integrations/telegram/notify-run/route.ts` | POST：补全 session 元数据 + 入队 |
| `hooks/useTelegramNotify.ts` | sticky 开关 + Telegram 配置探测 |

### 修改

| 文件 | 改动 |
|---|---|
| `modules/telegram/telegram-task-notifier.ts` | 按 `notifyOnSuccess/notifyOnFailure` 门控；格式函数改用共享模块 |
| `modules/telegram/telegram-task-notifier.test.mjs` | `fakeRun` 默认两个标志为 true；新增门控用例 |
| `modules/telegram/index.ts` | 导出 `notifyManualRun` / 类型 / 格式函数 |
| `components/TasksConfig.tsx` | 通知标志改 `useState` + 渲染勾选项 |
| `hooks/useAgentSession.ts` | `onPromptFinished` 回调 + 起跑记录 + prompt_done/prompt_error 触发 |
| `components/ChatWindow.tsx` | `useTelegramNotify` + `wrappedOnPromptFinished` + 传 prop |
| `components/ChatInput.tsx` | 纸飞机按钮 + 新 prop |
| `lib/telegram-client.ts` | `notifyTelegramManualRun()` |
| `lib/i18n/messages/{en,zh-CN}.ts` | 新文案 |

---

## 6. 关键陷阱与决策

### 6.1 一次 prompt 只通知一次

`prompt_error` 之后 pi 可能自动重试并最终 `prompt_done`。用 `notifiedRunFinishedRef === runId` 去重，**首终态事件胜出**：先错则只发失败卡（用户可回 Web 看到后续成功），避免重复打扰。

### 6.2 不在请求路径直连 Telegram

手动通知走「客户端 POST → 路由写 outbox → 仅 leader 的 OutboxWorker 发送」，与任务通知同一管线，复用重试/退避/429/无效 token 处理。

### 6.3 通知失败不影响聊天

`notify-run` 路由永远返回 200；客户端 `.catch` 只 warn；Notifier 内部 `try/catch` + `logWarn`。三层保证 Telegram 抖动不会污染已完成的会话体验。

### 6.4 session 名取自 entries 而非 header

`.jsonl` 首行 `session` 头只有 `{type,version,id,timestamp,cwd,parentSession}`，**没有 name**。会话名存在 `session_info` entry 里。`extractSessionMetadata` 反向扫描 entries 同时取「最新 session_info 名」与「最新 assistant 文本」。

### 6.5 按钮仅在「有处可发」时显示

`useTelegramNotify` 要求 `status.configured && userCount > 0` 才置 `telegramConfigured=true`，按钮才出现——避免给用户一个点了无效的开关。

### 6.6 sticky 而非每条消息

手动通知开关与完成提示音同模式（localStorage、跨会话保留），符合「我离开工位，让它在后台跑、跑完叫我」的语义；每个 prompt_done 都通知一次即「每次执行完都通知」。

---

## 7. 测试

- `telegram-task-notifier.test.mjs`：6 例（含新增门控：success/failure/started 三态按标志静默；`{}` 快照回退 failure-only 仍发）。
- `telegram-manual-run-notifier.test.mjs`：4 例（成功多目标、失败文案、无目标静默、publicUrl 链接）。
- 全量模块测试：**145 例全过**。
- 本次触及文件 `tsc --noEmit` 与 `eslint` 均干净（仓库其余 tsc 报错均为该分支既有未提交模块，与本次无关）。

---

## 8. 后续（P1，可后置）

- 手动通知 inline 按钮：等 transport 支持 URL 按钮后，把「打开会话」文本链接换成可点按钮；或新增 `open_session` action 类型走 callback router。
- 复制任务时保留 `notifyOnSuccess`（当前强制置 false）。
- extension 注入的 run 也纳入手动通知（目前只覆盖用户 prompt 的 `prompt_done`）。
- 每个 prompt 的通知去抖：会话内连续多轮时，可选「仅长时间运行才通知」阈值。
