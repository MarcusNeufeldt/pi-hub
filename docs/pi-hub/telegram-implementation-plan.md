# Pi Hub Telegram 接入 — 剩余实施计划

> 基于 `telegram-integration-design.zh-CN.md` §28 的阶段划分与 §27 验收标准。
> 阶段一（基础运行时）已完成；本文覆盖阶段二/三/四 + TelePi 迁移。
>
> 原则：遵循 `AGENTS.local.md`（新增模块、最小上游改动、不改 Session JSONL、Token 永不落库/日志/响应）。

## 依赖关系（决定顺序）

```
阶段二（通知 + 任务命令）   ── 独立，无协调器依赖（任务总是创建全新 Session）
   │
   ▼
阶段三（协调器 + Prompt + Session）  ── 依赖 AgentExecutionCoordinator
   │
   ▼
阶段四（增强命令 P1）        ── 可选，后置
TelePi 迁移（§22）           ── 独立，可任意时点插入
```

关键判断：调度器执行任务时**总是创建全新 Session**（`pi-task-executor.ts` → `startSession` → 新文件），所以任务通知与 `/run` **不会**与已有 Web/Telegram Session 竞争，因此阶段二可在协调器之前独立交付（与设计 §28 排序一致）。

---

## 阶段二 · 配对完成 + 通知 + 任务命令

**目标**：定时任务成功/失败通知送达 Telegram；`/tasks` `/task <id>` `/run <id>` 可用。
**满足 §27**：#13（/tasks /run）、#14（通知）、#15（通知失败不改任务状态）。

### 新增文件

| 文件 | 职责 |
|---|---|
| `modules/telegram/telegram-outbox.ts` | `OutboxWriter.enqueue()`（幂等键去重，写 `telegram_notification_outbox`）+ `OutboxWorker`（仅 leader 运行的 drain 循环：指数退避重试 ≤5 次、尊重 429 `Retry-After`、Token 无效→标记配置错误并停止、`max(1, min(...))` 防御） |
| `modules/telegram/telegram-actions.ts` | Action Token 服务：`createAction()` 生成短期、单次、绑定 `ownerKey`/`role` 的回调 Token（写 `telegram_actions`）；`resolveAndConsumeAction()` 校验+消费 |
| `modules/telegram/telegram-task-notifier.ts` | `class TelegramTaskNotifier implements TaskNotifier`（懒加载：`getTelegramRuntime()` 在调用时解析）。把 `onRunStarted/Succeeded/Failed` 转成 §18.4/18.5 文案 + 内联按钮（查看详情/打开 Session/再次执行）→ `OutboxWriter.enqueue()` |
| `modules/telegram/telegram-callback-router.ts` | `routeCallbackQuery()`：校验 Action Token → 按 action 类型分发（view/open/rerun）→ 角色与 owner 校验 → `answerCallbackQuery` |
| 测试 | `telegram-outbox.test.mjs`（幂等、退避、429、无效 token 停止）、`telegram-task-notifier.test.mjs`（三态文案 + 按钮 + 不抛异常） |

### 集成点（最小上游改动）

- `modules/telegram/telegram-runtime.ts`：获得 leader 租约时启动 `OutboxWorker`；失去 leader 时停止。维持「仅 leader 调用 Telegram API」不变量。
- `modules/telegram/telegram-dispatcher.ts`：实现 `/tasks`（分页 + 下次执行时间/时区）、`/task <id>`（详情 + 最近执行）、`/run <id>`（调用 `TaskService.runNow()`，不改 `next_run_at`）；`callback_query` 经 `routeCallbackQuery` 路由。
- `instrumentation.ts`：调度器启动时注入懒加载 notifier（约 3 行）：
  ```ts
  await import("@/modules/scheduler").then(async (m) => {
    const { TelegramTaskNotifier } = await import("@/modules/telegram");
    return m.startSchedulerRuntime({ notifier: new TelegramTaskNotifier() });
  })
  ```
  （`startSchedulerRuntime` 已接受 `{ notifier }` 选项；notifier 懒解析 telegram runtime，故启动顺序无关。）
- Telegram→TaskService 访问：镜像 `lib/scheduler-service-access.ts` 模式，新增 `lib/telegram-to-scheduler.ts`（或直接在 dispatcher 内调用 `getSchedulerRuntime()?.getTaskService()`）。

### 通知投递目标（V1 简化）
默认投递给所有 enabled 的 owner/operator 用户的**私聊**会话；`telegram_task_subscriptions` 表用于后续按任务订阅（V1 仅建表 + 默认规则，不实现管理 UI）。

### 退出标准
- 触发一次定时任务 → Telegram 收到成功/失败卡片 + 按钮；按钮回调带短期 Token。
- 通知发送失败 → 仅 Warning 日志，Task Run 状态不变；DB 无重复（幂等键）。
- `/run <id>` → 立即入队执行，周期任务 `next_run_at` 不变。

---

## 阶段三 · AgentExecutionCoordinator + 文本 Prompt + Session

**目标**：Telegram 文本 Prompt 真正驱动 Agent；Session 创建/切换；流式回复；`/abort` `/retry`；Web 与 Telegram Run Owner 协调。
**满足 §27**：#6/#7/#8（Prompt、Web 可见、可继续）、#9（Chat/Topic 独立映射）、#12（/new /session /sessions /abort /retry）、#16（无并发写入）。

### 3.1 协调器（先行，其余依赖它）

| 文件 | 职责 |
|---|---|
| `modules/agent-execution/run-context.ts` | 类型：`AgentRunContext`（runId/sessionId/source/ownerKey/startedAt）、ownerKey 构造器（`telegram:{chatId}:{threadId}` / `web:{clientId}` / `scheduler:{taskRunId}`） |
| `modules/agent-execution/agent-execution-coordinator.ts` | 进程内单例：`acquire(sessionId, ctx)` → 同一 Session 仅一个 Run（Busy 抛 `RUN_BUSY` + 当前 owner）；`release()`；`getOwner(sessionId)`；`withOwner(...)` 事件路由（仅 owner 订阅者收事件）；超时→`abort`；extension UI 所有权查询（§8.6） |
| 测试 | `agent-execution-coordinator.test.mjs`（互斥、Busy 文案含 owner、release 后可再获取、超时 abort） |

### 3.2 Prompt 执行链路

| 文件 | 职责 |
|---|---|
| `modules/telegram/telegram-conversation-service.ts` | `resolveConversation(chatId,threadId)`：无则按默认 Workspace + Project Trust 校验创建 Session（`startRpcSession`，命名 `[TG] {name} · {time}`）；Busy 检查；返回 `(wrapper, runOwner)` |
| `modules/telegram/telegram-prompt-runner.ts` | Prompt 主路径：`conversation busy?` → `coordinator.acquire()` → **先订阅事件** → `session.send({type:"prompt"})` → typing 循环(4.5s) → `prompt_done`/`prompt_error` 释放锁（§8.4：不以首次 `agent_end` 为终态）；`abort`（owner 校验 §8.7）；`retry` |
| `modules/telegram/telegram-stream-renderer.ts` | 流式渲染：首 delta 建消息、1.5s 节流编辑、3800 字符分片、Tool Verbosity（默认 summary）、执行中「停止」按钮、终态移除按钮 |
| `modules/telegram/telegram-html.ts` | Markdown→Telegram HTML：转义、code/inline code/bold/italic/链接白名单、解析失败回退纯文本 |
| `modules/telegram/telegram-session-service.ts` | `/new`（Workspace 选择器）、`/sessions`（`listAllSessions()` 按 Project/Worktree 分组 + 分页 Inline Keyboard + 短 Token + `resolveSessionPath`，正忙禁止切换）、`/session` |

### 集成点（上游改动，仍最小化）

- `modules/telegram/telegram-runtime.ts`：构造 dispatcher 时注入 coordinator + conversation/session service。
- `modules/telegram/telegram-dispatcher.ts`：实现 `/new` `/session` `/sessions` `/abort` `/retry` + **自由文本** → `telegram-prompt-runner`；移除现有 `featureNotReady` 占位。
- Web 端（**协调器对 Web 的最小接入**，满足 §8.6）：
  - `POST /api/agent/[id]`（或其 prompt 分支）：发送 prompt 前用 `web:{clientId}` ownerKey 调 `coordinator.acquire()`；`prompt_done`/`prompt_error` 时 release。
  - `extension_ui_response` 处理：若 session 被 telegram owner 占用 → 返回 `409 RUN_OWNED_BY_TELEGRAM`（§8.6）。
  - 用 `lib/agent-execution-access.ts` 薄封装，避免散落。
- 调度器经协调器（**可选后置**）：阶段二先不动；阶段三后期让 `pi-task-executor.ts` 用 `scheduler:{taskRunId}` 走协调器，使 `/run` 的 owner 可见。V1 可只做 Telegram+Web，scheduler 接入留作 §8 兑现的收尾。

### 退出标准
- Telegram 发文本 → 创建/复用 Session → 流式回复 → `prompt_done` 释放；Web 同时能看到该 Session 在执行。
- 同一 Session 被 Telegram 占用时，Web 提交 extension_ui_response 返回 409 含 owner。
- `/abort` 仅 owner/Pi Hub owner 可用；`/retry` 重放上一 Prompt。
- 重启 Pi Hub 后 Conversation→Session 映射仍在，`resetTransientStates()` 把 active run 清为 idle。

---

## 阶段四 · 增强命令（P1，可后置）

`/commands`（`get_commands` 桥：Prompt Templates / Skills / Extension Commands 分页选择器）、`/model`、`/context`、图片输入（§16.1）。
独立小模块，不阻塞主体。

---

## TelePi 迁移（§22，独立单元）

| 文件 | 职责 |
|---|---|
| `modules/telegram/telegram-telepi-import.ts` | 解析 TelePi 配置（`BOT_TOKEN`、allowed users、session 路径）→ 映射 allowed users 到 `telegram_users`；可选保存 token；标记待迁移 sessions |
| `app/api/integrations/telegram/import-telepi/route.ts` | `POST`：读取 + 校验 + 导入；返回导入摘要 |
| UI | `TelegramSettings` 配置 Tab 增加「从 TelePi 导入」入口 |
| 测试 | `telegram-telepi-import.test.mjs`（用户映射、token 处理、幂等） |

退出标准：导入后原 TelePi allowed 用户成为 Pi Hub telegram_users；Bot Token 复用（不重复落库）。

---

## 全局收尾

- `package.json`：test 脚本纳入 telegram + agent-execution 测试（沿用 `node --experimental-strip-types --test` + jiti）。
- §25 可观测性：统一 `[pi-hub:telegram]`/`[pi-hub:agent-execution]` 日志前缀；outbox/协调器关键事件结构化日志。
- §27 逐条核对清单（实现完成后走一遍）。

## 建议执行批次

1. **批次 A = 阶段二全部**（通知 + 任务命令）— 自包含、可独立验证、用户立即可感知价值。
2. **批次 B = 阶段三 3.1 协调器**（仅协调器 + 测试，不动 prompt 链路）— 降低风险、可单独合入。
3. **批次 C = 阶段三 3.2 prompt/session/streaming**（依赖 B）。
4. **批次 D = TelePi 迁移**（独立）。
5. **批次 E = 阶段四**（P1，按需）。

每批次：实现 → 单测 → `next dev` 冒烟 → §27 对应项打钩。
