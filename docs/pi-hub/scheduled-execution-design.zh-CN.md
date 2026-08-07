# Pi Hub 定时执行功能设计

> 状态：Draft  
> 版本：V1  
> 日期：2026-08-07  
> 适用仓库：`jiangliuhong/pi-hub`

## 1. 文档目标

本文档定义 Pi Hub 的定时执行能力，包括：

1. 每天在指定时间自动执行一个 Pi Agent 任务；
2. 在指定日期和时间执行一次任务；
3. 在 Web UI 中创建、编辑、暂停、恢复、删除和立即执行任务；
4. 保存任务执行历史，并能跳转到对应的 Pi 会话查看完整过程；
5. 为后续 TelePi 通知和远程管理预留清晰的扩展接口。

该功能必须遵守 `AGENTS.md` 与 `AGENTS.local.md` 中的开发规则，核心原则是：

> 在复用 pi-web 现有 Agent 执行链路的前提下，以新增模块为主，尽量减少对上游文件的修改。

---

## 2. 决策摘要

V1 采用以下方案：

- 调度器运行在 Pi Hub 的 Node.js 服务进程中；
- 通过 `instrumentation.ts` 在服务启动时初始化调度器；
- 任务和执行记录保存在 `~/.pi/hub/app.db`；
- 使用 SQLite 持久化，不依赖 Redis；
- 使用持久化的 `next_run_at` 扫描机制，而不是仅依赖内存中的 `setTimeout` 或 `node-cron`；
- 每次任务执行都创建一个新的 Pi Session；
- Agent 执行复用现有 `startRpcSession()` 和 `AgentSessionWrapper`；
- 通过监听 `prompt_done` 和 `prompt_error` 判断一次 Prompt 是否结束，不使用第一次 `agent_end` 作为完成信号；
- 默认全局并发数为 `1`；
- 默认不自动重试失败的 Agent 任务，避免重复产生有副作用的操作；
- 定时执行不依赖浏览器、SSE 连接或页面保持打开；
- TelePi 通过通知适配器接入，不进入调度器核心逻辑。

---

## 3. 背景

原 pi-web 主要解决交互式场景：

```text
用户打开浏览器
      │
      ▼
输入 Prompt
      │
      ▼
Pi Agent 执行
      │
      ▼
通过 SSE 在页面展示过程和结果
```

Pi Hub 需要补充无人值守执行场景：

```text
用户提前创建任务
      │
      ▼
任务持久化
      │
      ▼
指定时间到达
      │
      ▼
后台启动 Pi Agent Session
      │
      ▼
执行 Prompt
      │
      ├── 保存执行记录
      ├── 保留 Pi Session
      └── 可选发送 TelePi 通知
```

这意味着任务生命周期不能由浏览器控制，也不能把任务是否完成绑定到某个 HTTP 请求或 SSE 连接。

---

## 4. 功能范围

### 4.1 V1 包含

#### 任务类型

- 每日任务：每天在指定本地时间执行；
- 一次性任务：在指定日期和时间执行一次；
- 手动执行：用户可对任意任务点击“立即执行”。

#### 任务管理

- 创建任务；
- 编辑任务；
- 启用和暂停任务；
- 删除任务；
- 立即执行；
- 查看下一次执行时间；
- 查看最近一次执行状态；
- 查看完整执行历史。

#### Agent 配置

每个任务至少支持：

- 任务名称；
- 工作目录 `cwd`；
- Prompt；
- 调度类型和时间；
- 时区；
- 超时时间；
- 可选的模型配置；
- 可选的 Thinking Level；
- 可选的工具集配置；
- 是否在成功或失败后发送通知。

#### 执行记录

每次执行记录：

- 触发方式；
- 计划执行时间；
- 实际开始时间；
- 实际结束时间；
- 状态；
- Pi Session ID；
- 最终结果摘要；
- 错误信息；
- 执行耗时。

### 4.2 V1 不包含

- 自然语言解析调度时间，例如“明天下午三点”；
- 多步骤工作流和任务依赖；
- 分布式调度；
- 多台 Pi Hub 共享同一个任务数据库；
- 任务审批；
- 任务版本回滚；
- 在同一个固定 Session 中持续执行周期任务；
- 默认自动重试；
- 任意 Shell 命令调度；
- Web UI 中直接开放高级 Cron 表达式编辑。

后端数据结构可为高级 Cron 预留能力，但 V1 页面只提供“每天”和“一次性”两种清晰的配置方式。

---

## 5. 设计原则

### 5.1 持久化优先

任务定义、下次执行时间和执行记录必须落库。服务重启后不能丢失任务。

### 5.2 浏览器无关

关闭浏览器、刷新页面或断开 SSE 不能中断调度器。

### 5.3 Agent 执行链路唯一

定时任务必须复用 pi-web 已有的 Pi AgentSession 创建和执行能力，不能再实现一套独立的 Pi CLI 调用链路。

### 5.4 每次执行独立会话

V1 每次任务运行创建一个新 Session，避免不同日期的上下文相互污染，也方便追踪和审计。

### 5.5 默认保守执行

- 默认并发为 1；
- 默认同一个任务不允许重叠执行；
- 默认失败不自动重试；
- 默认交互式扩展请求自动取消；
- 默认限制最长执行时间。

### 5.6 上游同步友好

新增能力放在 `modules/scheduler/` 等 Pi Hub 专属目录，只对少量上游文件做小型接入修改。

---

## 6. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         Pi Hub Web UI                         │
│                                                              │
│  Task List  ──  Task Editor  ──  Task Run History            │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTP API
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                         Task API Layer                        │
│                                                              │
│  TaskService   TaskValidation   SchedulePreview              │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                     Scheduler Application Layer              │
│                                                              │
│  SchedulerRuntime                                             │
│       │                                                       │
│       ├── Leader Lease                                        │
│       ├── Due Task Scanner                                    │
│       ├── Misfire Handler                                     │
│       ├── Run Claim                                           │
│       └── Execution Queue                                     │
└───────────────────────┬───────────────────┬──────────────────┘
                        │                   │
                        ▼                   ▼
              ┌─────────────────┐   ┌────────────────────┐
              │ SQLite TaskStore│   │ Notification Port  │
              │ ~/.pi/hub/app.db│   │ TelePi Adapter     │
              └─────────────────┘   └────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│                        PiTaskExecutor                         │
│                                                              │
│  startRpcSession()                                            │
│       │                                                       │
│       ├── set_session_name                                    │
│       ├── subscribe events                                    │
│       ├── prompt                                               │
│       ├── wait prompt_done / prompt_error                     │
│       ├── get_last_assistant_text                             │
│       └── session id persisted                                │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
                         Existing Pi Runtime
```

---

## 7. 模块划分

建议新增以下目录：

```text
modules/
└── scheduler/
    ├── index.ts
    ├── scheduler-runtime.ts
    ├── scheduler-lease.ts
    ├── due-task-scanner.ts
    ├── schedule-calculator.ts
    ├── task-service.ts
    ├── task-store.ts
    ├── sqlite-task-store.ts
    ├── schema-migrations.ts
    ├── task-executor.ts
    ├── pi-task-executor.ts
    ├── prompt-run-waiter.ts
    ├── task-notifier.ts
    ├── types.ts
    ├── validation.ts
    └── errors.ts
```

建议新增 API：

```text
app/api/tasks/route.ts
app/api/tasks/[id]/route.ts
app/api/tasks/[id]/run/route.ts
app/api/task-runs/route.ts
app/api/task-runs/[id]/route.ts
app/api/task-runs/[id]/cancel/route.ts
app/api/scheduler/status/route.ts
app/api/scheduler/preview/route.ts
```

建议新增页面和组件：

```text
app/tasks/page.tsx
components/tasks/TaskList.tsx
components/tasks/TaskEditor.tsx
components/tasks/TaskScheduleEditor.tsx
components/tasks/TaskRunList.tsx
components/tasks/TaskRunDetail.tsx
components/tasks/SchedulerStatus.tsx
```

### 7.1 上游文件修改边界

预计只需要少量修改：

| 文件 | 修改目的 | 约束 |
|---|---|---|
| `instrumentation.ts` | 启动 SchedulerRuntime | 仅增加一次导入和初始化调用 |
| `components/AppShell.tsx` 或侧边栏组件 | 增加任务中心入口 | 不改变现有 Chat 行为 |
| `package.json` | 增加必要的纯 JavaScript 调度依赖 | 不替换上游依赖 |
| i18n 资源文件 | 增加任务中心文案 | 只做增量添加 |

其余功能尽量全部放在新增文件中。

---

## 8. 运行方式

### 8.1 调度器启动

在 `instrumentation.ts` 的 Node.js Runtime 分支中调用：

```ts
const { startSchedulerRuntime } = await import("@/modules/scheduler");
await startSchedulerRuntime();
```

`startSchedulerRuntime()` 必须具备幂等性：

```text
同一 Node 进程
      │
      ├── 第一次调用：初始化并启动
      └── 后续调用：直接返回已有实例
```

建议使用：

```ts
globalThis.__piHubSchedulerRuntime
```

防止 Next.js 开发模式热更新时重复创建扫描器。

### 8.2 数据库租约

仅依赖 `globalThis` 不能防止两个独立 Node 进程同时调度，因此增加 SQLite 租约：

```text
lease_name: scheduler
owner_id: 当前进程 UUID
lease_until: 租约过期时间
```

规则：

- 每 5 秒续约；
- 租约有效期 15 秒；
- 只有持有租约的进程扫描并触发任务；
- 进程异常退出后，其他进程可在租约过期后接管；
- V1 仍明确只支持单实例部署，租约主要用于防重复初始化和意外双进程。

### 8.3 扫描频率

建议每 10 秒执行一次扫描：

```text
查询 next_run_at <= 当前时间 的任务
```

任务实际执行精度为秒级，不承诺毫秒级准时。

每日任务和普通提醒场景不需要更高频率。

---

## 9. 存储设计

### 9.1 数据目录

默认目录：

```text
~/.pi/hub/
├── app.db
└── logs/
```

支持环境变量覆盖：

```text
PI_HUB_HOME=/custom/path
```

最终数据库路径：

```text
${PI_HUB_HOME:-~/.pi/hub}/app.db
```

不得使用 `~/.pi-web/`。

### 9.2 SQLite 选择

V1 优先通过一个独立的 `TaskStore` 接口使用 Node.js 内置 `node:sqlite`，原因：

- 不需要部署 Redis；
- 不引入 ARM 环境下可能需要编译的原生 npm 扩展；
- 与当前单用户、单机部署场景匹配；
- 数据量较小；
- 可以使用事务和唯一约束实现任务抢占与防重复执行。

SQLite 实现必须封装在 `sqlite-task-store.ts` 中，业务层不能直接依赖 `DatabaseSync`，便于未来替换。

推荐初始化参数：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

不得在 Agent 长时间执行期间持有数据库事务。

### 9.3 数据库迁移

新增迁移表：

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;
```

启动时按版本顺序执行迁移。迁移失败时：

- Scheduler 不启动；
- Web UI 仍可返回明确的 Scheduler 错误状态；
- 不允许静默跳过迁移。

---

## 10. 数据模型

### 10.1 scheduled_tasks

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,

  schedule_type TEXT NOT NULL
    CHECK (schedule_type IN ('recurring', 'once')),
  cron_expression TEXT,
  execute_at INTEGER,
  timezone TEXT NOT NULL,
  next_run_at INTEGER,

  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,

  provider TEXT,
  model_id TEXT,
  thinking_level TEXT,
  tool_names_json TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed')),
  overlap_policy TEXT NOT NULL DEFAULT 'skip'
    CHECK (overlap_policy IN ('skip')),
  misfire_policy TEXT NOT NULL
    CHECK (misfire_policy IN ('run_once', 'skip')),
  misfire_grace_seconds INTEGER NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 7200,

  notify_on_success INTEGER NOT NULL DEFAULT 0,
  notify_on_failure INTEGER NOT NULL DEFAULT 1,

  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,

  CHECK (
    (schedule_type = 'recurring'
      AND cron_expression IS NOT NULL
      AND execute_at IS NULL)
    OR
    (schedule_type = 'once'
      AND cron_expression IS NULL
      AND execute_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_scheduled_tasks_due
ON scheduled_tasks(status, next_run_at);
```

说明：

- 时间统一使用 Unix Epoch 毫秒并以 UTC 存储；
- `timezone` 使用 IANA 时区，例如 `Asia/Singapore`；
- 每日任务在内部转换成标准五段 Cron，例如每天 08:30：`30 8 * * *`；
- V1 页面不直接让用户编辑 Cron；
- `revision` 用于乐观锁，避免两个页面同时覆盖任务配置；
- `tool_names_json` 保存工具名数组，不保存工具实现；
- `provider` 与 `model_id` 必须同时为空或同时有值。

### 10.2 task_runs

```sql
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES scheduled_tasks(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL UNIQUE,

  task_name_snapshot TEXT NOT NULL,
  prompt_snapshot TEXT NOT NULL,
  cwd_snapshot TEXT NOT NULL,
  schedule_snapshot_json TEXT NOT NULL,
  execution_options_snapshot_json TEXT NOT NULL,

  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('scheduled', 'manual')),
  scheduled_for INTEGER NOT NULL,

  status TEXT NOT NULL
    CHECK (status IN (
      'queued',
      'running',
      'success',
      'failed',
      'cancelled',
      'interrupted',
      'skipped',
      'missed'
    )),

  session_id TEXT,
  result_excerpt TEXT,
  error_code TEXT,
  error_message TEXT,

  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  heartbeat_at INTEGER,

  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_task_runs_task_created
ON task_runs(task_id, created_at DESC);

CREATE INDEX idx_task_runs_status
ON task_runs(status, created_at);
```

设计要点：

- Run 保存任务快照，任务编辑或删除后历史仍可解释；
- 完整 Agent 输出仍保存在 Pi Session 中；
- `task_runs` 只保存有限长度的最终摘要和错误信息；
- `session_id` 用于从历史记录跳转到现有会话页面；
- `dedupe_key` 用于阻止同一个计划时间被重复触发。

计划触发的去重键：

```text
scheduled:{task_id}:{scheduled_for}
```

手动触发的去重键：

```text
manual:{run_id}
```

### 10.3 scheduler_leases

```sql
CREATE TABLE scheduler_leases (
  lease_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

---

## 11. 调度时间设计

### 11.1 时区

规则：

- 所有落库时间使用 UTC；
- 每日任务的时间解释必须结合任务自己的 IANA 时区；
- 页面默认时区按以下顺序确定：
  1. Pi Hub 配置的默认时区；
  2. 浏览器时区；
  3. 服务端系统时区；
- 页面保存任务时必须明确传递时区，不能只传 `08:00`；
- 页面展示计划时间时同时展示时区。

示例：

```text
每天 08:00
时区 Asia/Singapore
```

服务端计算并保存对应的下一次 UTC 时间。

### 11.2 每日任务

UI 输入：

```json
{
  "type": "daily",
  "time": "08:00",
  "timezone": "Asia/Singapore"
}
```

服务端转换为：

```text
schedule_type = recurring
cron_expression = 0 8 * * *
timezone = Asia/Singapore
```

建议使用支持 IANA 时区的 Cron 计算器。该能力封装在 `schedule-calculator.ts` 中，不能散落在 API 或 UI 中。

### 11.3 一次性任务

UI 输入本地日期、时间和时区，服务端转换为 UTC：

```json
{
  "type": "once",
  "localDateTime": "2026-08-08T10:00:00",
  "timezone": "Asia/Singapore"
}
```

落库：

```text
execute_at = UTC epoch milliseconds
next_run_at = execute_at
```

### 11.4 夏令时

虽然当前主要使用 `Asia/Singapore`，实现仍必须使用真正的时区计算，不能用固定 UTC 偏移替代 IANA 时区。

需要针对以下情况编写单元测试：

- 夏令时开始时本地时间不存在；
- 夏令时结束时本地时间重复；
- 跨天计算；
- 月末和年末。

---

## 12. 任务状态模型

### 12.1 Task 状态

```text
active ───────▶ paused
  ▲               │
  └───────────────┘

once task 被成功抢占后：
active ───────▶ completed
```

说明：

- `active`：参与到期扫描；
- `paused`：不触发，`next_run_at` 可保留但不扫描；
- `completed`：一次性计划已经被消费；
- 一次性任务在成功创建 Run 后即设置为 `completed`，而不是等 Agent 成功后再设置，避免进程重启造成重复副作用；
- Agent 执行失败后，可通过“立即执行”重新运行，或复制任务重新安排。

### 12.2 Run 状态

```text
queued
   │
   ▼
running
   │
   ├──▶ success
   ├──▶ failed
   ├──▶ cancelled
   └──▶ interrupted

到期但因策略不执行：
queued 之前直接生成 skipped / missed 记录
```

---

## 13. 到期任务抢占

扫描到任务到期后，在一个短事务中完成：

1. 再次确认任务仍为 `active`；
2. 再次确认 `next_run_at <= now`；
3. 生成对应 `dedupe_key`；
4. 插入 `task_runs`；
5. 对每日任务计算并更新下一次 `next_run_at`；
6. 对一次性任务设置 `status = completed`；
7. 提交事务；
8. 事务提交后把 Run 放入内存执行队列。

伪代码：

```ts
transaction(() => {
  const task = store.findDueTaskForUpdate(taskId, now);
  if (!task) return null;

  const run = store.insertRunIfAbsent({
    dedupeKey: `scheduled:${task.id}:${task.nextRunAt}`,
    scheduledFor: task.nextRunAt,
    taskSnapshot: task,
  });

  if (!run) return null;

  if (task.scheduleType === "recurring") {
    store.updateNextRunAt(task.id, calculateNextRun(task, task.nextRunAt));
  } else {
    store.markCompleted(task.id);
  }

  return run;
});
```

不得在该事务中启动 Agent。

---

## 14. 误点火与服务停机恢复

“误点火”指任务的计划时间已经过去，但服务当时没有运行或调度器没有及时执行。

### 14.1 配置

每个任务包含：

```text
misfire_policy
misfire_grace_seconds
```

推荐默认值：

| 任务类型 | 默认策略 | 默认宽限时间 |
|---|---|---:|
| 每日任务 | `run_once` | 3600 秒 |
| 一次性任务 | `run_once` | 86400 秒 |

### 14.2 run_once

当：

```text
now - next_run_at <= misfire_grace_seconds
```

则在服务恢复后执行一次。

对于每日任务，即使停机期间错过多次，也只补执行最近需要消费的一次，不批量补跑全部历史日期。

### 14.3 skip

如果配置为 `skip`，或超过宽限时间：

- 不启动 Agent；
- 写入一条 `skipped` 或 `missed` 的 Run 记录；
- 每日任务计算下一次未来时间；
- 一次性任务设置为 `completed`。

这样用户可以从历史中看到任务为什么没有执行。

---

## 15. 并发和重叠策略

### 15.1 全局并发

V1 默认：

```text
scheduler.maxConcurrency = 1
```

理由：

- 个人服务器资源有限；
- Pi Agent 可能执行编译、测试和大量文件操作；
- 多任务同时修改同一个仓库风险较高；
- 先保证可控性，再开放并发。

后续可配置为大于 1，但必须继续受全局上限约束。

### 15.2 同任务重叠

V1 仅支持：

```text
overlap_policy = skip
```

当一个任务仍在运行，而它的下一次计划时间到达：

- 不启动第二个相同任务；
- 创建 `skipped` Run；
- 错误码为 `TASK_ALREADY_RUNNING`；
- 正常推进下一次执行时间。

### 15.3 不同任务操作同一工作目录

V1 的全局并发为 1，因此不会同时执行。

未来放开并发后，应增加按规范化 `cwd` 的互斥锁，默认不允许两个 Agent 同时修改同一个工作目录。

---

## 16. Pi Agent 执行设计

### 16.1 创建 Session

每个 Run 使用唯一临时键：

```text
__scheduled_task__{run_id}
```

调用：

```ts
const { session, realSessionId } = await startRpcSession(
  `__scheduled_task__${run.id}`,
  "",
  run.cwd,
  {
    toolNames: run.toolNames,
    initialModel: run.model,
    thinkingLevel: run.thinkingLevel,
  },
);
```

创建成功后立即把 `realSessionId` 写入 `task_runs.session_id`。

### 16.2 Session 名称

建议命名：

```text
[Task] 每日代码巡检 · 2026-08-07 08:00
```

通过现有命令设置：

```ts
await session.send({
  type: "set_session_name",
  name: sessionName,
});
```

### 16.3 Prompt 上下文

在用户 Prompt 前增加简短的无人值守执行说明：

```text
[Pi Hub Scheduled Execution]
This is an unattended task. Do not wait for interactive user input.
Make safe, reasonable decisions. If blocked, explain the blocker in the final response.

<User Prompt>
...
```

不得改变用户原始 Prompt 的正文，只在执行时构造最终 Prompt。

### 16.4 等待完成

现有 `session.send({ type: "prompt" })` 是异步触发，调用本身不会等待 Agent 完成。因此必须：

1. 在发送 Prompt 前注册事件监听；
2. 记录 `prompt_error`；
3. 以 `prompt_done` 作为这次 Prompt 的最终完成信号；
4. 不以第一次 `agent_end` 作为完成信号；
5. 超时后发送 `abort`；
6. 完成后取消事件监听。

伪代码：

```ts
async function runPromptAndWait(session, prompt, timeoutMs) {
  let promptError: string | null = null;

  return new Promise(async (resolve, reject) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type === "prompt_error") {
        promptError = String(event.errorMessage ?? "Unknown prompt error");
      }

      if (event.type === "prompt_done") {
        cleanup();
        if (promptError) reject(new Error(promptError));
        else resolve(undefined);
      }
    });

    const timer = setTimeout(async () => {
      await session.send({ type: "abort" }).catch(() => undefined);
      cleanup();
      reject(new TaskTimeoutError());
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
    }

    await session.send({ type: "prompt", message: prompt });
  });
}
```

正式实现还需要处理：

- `send()` 在注册监听后立即抛错；
- 超时与 `prompt_done` 同时发生的竞态；
- Runtime 停止时主动取消等待；
- Promise 只能完成一次。

### 16.5 获取结果

任务完成后调用：

```ts
const result = await session.send({
  type: "get_last_assistant_text",
});
```

保存：

- 最多 4,000 个字符的 `result_excerpt`；
- 完整内容继续由 Pi Session 保存；
- Web UI 提供“打开会话”入口。

### 16.6 自动重试

V1 默认不自动重试 Agent 任务。

原因：

- Agent 可能已经修改文件、提交代码或调用外部接口；
- 自动重试可能重复产生副作用；
- 网络失败不一定代表 Agent 没有完成部分操作。

失败后提供：

- “重新执行”按钮；
- 复制任务；
- 查看原 Session 和错误信息。

后续如增加重试，必须由任务显式开启，并区分可重试错误和不可重试错误。

---

## 17. 无人值守交互策略

Pi 扩展可能发起：

- `select`；
- `confirm`；
- `input`；
- `editor`；
- `custom` UI。

定时任务没有浏览器用户响应，这些请求不能无限等待。

`PiTaskExecutor` 必须订阅 `extension_ui_request`：

| 请求类型 | V1 行为 |
|---|---|
| `confirm` | 自动返回 `confirmed: false` |
| `select` | 自动返回 `cancelled: true` |
| `input` | 自动返回 `cancelled: true` |
| `editor` | 自动返回 `cancelled: true` |
| `custom` | 自动返回 `cancelled: true` |
| `notify` | 记录日志，可转发到通知模块 |
| `setStatus` / `setWidget` / `setTitle` | 记录或忽略，不阻塞 |

响应使用已有命令：

```ts
await session.send({
  type: "extension_ui_response",
  id: event.id,
  cancelled: true,
});
```

Run 记录中应增加一条警告日志，说明执行期间发生了被自动取消的交互请求。

如果某个扩展强依赖交互，Agent 最终应以失败或阻塞说明结束，而不是让任务永久处于 `running`。

---

## 18. 超时和取消

### 18.1 超时

默认：

```text
timeout_seconds = 7200
```

即 2 小时。

建议限制：

```text
最小 60 秒
最大 86400 秒
```

超时处理：

1. 调用 `session.send({ type: "abort" })`；
2. Run 标记为 `failed`；
3. `error_code = TASK_TIMEOUT`；
4. 保留 Session；
5. 可选发送失败通知。

### 18.2 用户取消

V1 支持取消 `queued` 和 `running` Run：

- `queued`：直接标记 `cancelled`，从内存队列移除；
- `running`：调用 `abort`，待 Agent 停止后标记 `cancelled`；
- 如果进程在取消过程中退出，重启后标记为 `interrupted`。

---

## 19. 进程重启恢复

Scheduler 启动时执行恢复：

1. 获取 Scheduler 租约；
2. 查找状态为 `running` 的历史 Run；
3. 如果对应进程已不存在或 `heartbeat_at` 超时，将其标记为 `interrupted`；
4. 不自动重跑该 Run；
5. 扫描到期任务；
6. 根据 Misfire Policy 决定补跑或跳过。

错误码：

```text
PROCESS_RESTARTED
```

原因是 Pi Session 的内存执行状态无法在 Node 进程重启后无损恢复。Session 文件仍保留，用户可查看已经产生的内容。

---

## 20. API 设计

### 20.1 获取任务列表

```http
GET /api/tasks?status=active&page=1&pageSize=20
```

返回：

```json
{
  "items": [
    {
      "id": "task-id",
      "name": "每日代码巡检",
      "schedule": {
        "type": "daily",
        "time": "08:00",
        "timezone": "Asia/Singapore"
      },
      "status": "active",
      "nextRunAt": "2026-08-08T00:00:00.000Z",
      "lastRun": {
        "status": "success",
        "finishedAt": "2026-08-07T00:12:00.000Z"
      }
    }
  ],
  "total": 1
}
```

### 20.2 创建任务

```http
POST /api/tasks
```

每日任务：

```json
{
  "name": "每日代码巡检",
  "cwd": "/home/ubuntu/work/personal-app/openspec",
  "prompt": "检查项目状态，执行测试并总结发现的问题。",
  "schedule": {
    "type": "daily",
    "time": "08:00",
    "timezone": "Asia/Singapore"
  },
  "timeoutSeconds": 7200,
  "notifyOnSuccess": true,
  "notifyOnFailure": true
}
```

一次性任务：

```json
{
  "name": "明天检查发布结果",
  "cwd": "/home/ubuntu/work/personal-app/openspec",
  "prompt": "检查最新部署状态并输出检查报告。",
  "schedule": {
    "type": "once",
    "localDateTime": "2026-08-08T10:00:00",
    "timezone": "Asia/Singapore"
  }
}
```

### 20.3 编辑任务

```http
PATCH /api/tasks/{id}
```

请求包含当前 `revision`。版本不一致时返回：

```http
409 Conflict
```

### 20.4 暂停和恢复

统一通过 PATCH：

```json
{
  "status": "paused",
  "revision": 3
}
```

恢复时重新计算 `next_run_at`，不能直接执行暂停期间错过的所有历史任务。

### 20.5 立即执行

```http
POST /api/tasks/{id}/run
```

返回：

```json
{
  "runId": "run-id",
  "status": "queued"
}
```

立即执行不改变原任务的 `next_run_at`。

### 20.6 执行历史

```http
GET /api/task-runs?taskId={id}&page=1&pageSize=20
```

### 20.7 Scheduler 状态

```http
GET /api/scheduler/status
```

返回：

```json
{
  "running": true,
  "leader": true,
  "ownerId": "process-uuid",
  "lastTickAt": "2026-08-07T10:30:10.000Z",
  "nextTickAt": "2026-08-07T10:30:20.000Z",
  "queuedRuns": 0,
  "runningRuns": 1,
  "maxConcurrency": 1,
  "databasePath": "~/.pi/hub/app.db",
  "error": null
}
```

API 不得返回 Bot Token、模型密钥或其他敏感配置。

---

## 21. Web UI 设计

### 21.1 任务列表

建议字段：

| 字段 | 说明 |
|---|---|
| 名称 | 任务名称 |
| 类型 | 每天 / 一次性 |
| 调度 | 本地时间和时区 |
| 下次执行 | 转换后的明确日期时间 |
| 最近状态 | 成功、失败、运行中等 |
| 状态 | 启用、暂停、已完成 |
| 操作 | 立即执行、编辑、暂停、删除 |

顶部展示：

```text
Scheduler：运行中
运行任务：1
等待任务：0
今日成功：3
今日失败：1
```

### 21.2 任务编辑器

字段顺序：

1. 名称；
2. 工作目录；
3. Prompt；
4. 任务类型；
5. 时间和时区；
6. 模型配置；
7. 工具配置；
8. 超时时间；
9. 成功和失败通知；
10. 高级策略。

保存前展示预览：

```text
下一次执行：2026-08-08 08:00:00 Asia/Singapore
对应 UTC：2026-08-08 00:00:00 UTC
```

### 21.3 执行详情

展示：

- Task 快照；
- Run 状态；
- 触发方式；
- 计划时间；
- 实际开始和结束时间；
- 耗时；
- 结果摘要；
- 错误信息；
- “打开 Pi Session”；
- “重新执行”。

---

## 22. TelePi 集成边界

Scheduler 不直接依赖 TelePi。

定义通知接口：

```ts
export interface TaskNotifier {
  onRunStarted?(event: TaskRunNotification): Promise<void>;
  onRunSucceeded?(event: TaskRunNotification): Promise<void>;
  onRunFailed?(event: TaskRunNotification): Promise<void>;
}
```

默认实现：

```text
NoopTaskNotifier
```

后续增加：

```text
TelePiTaskNotifier
```

通知内容建议：

```text
✅ 任务执行成功

任务：每日代码巡检
开始：2026-08-07 08:00
耗时：12 分钟
结果：发现 2 个测试失败，未修改代码。
Session：可在 Pi Hub 中查看
```

TelePi 失败不能把已经成功的 Agent Run 改成失败。通知失败单独记录为 Warning。

---

## 23. 安全设计

### 23.1 工作目录

创建和编辑任务时：

- `cwd` 必须存在；
- 必须是绝对路径；
- 使用真实路径规范化，避免符号链接造成重复锁；
- 复用现有项目可信状态和文件访问规则；
- 运行前再次检查目录是否存在。

目录不存在时：

```text
status = failed
error_code = CWD_NOT_FOUND
```

### 23.2 未经值守执行风险

定时 Agent 可以修改文件、执行命令和访问网络，因此：

- Pi Hub 不应直接暴露到公网；
- LAN 模式部署必须由反向代理或其他方式提供访问控制；
- TelePi 创建、编辑和执行任务前必须验证用户身份；
- 日志和数据库不得保存 API Key、Bot Token 和 OAuth 凭据；
- Task API 不接受任意可执行 JavaScript；
- V1 不提供独立 Shell 调度字段。

### 23.3 Prompt 和日志

- Prompt 属于敏感数据，API 只对已授权 Pi Hub 用户开放；
- 错误日志中对常见 Token、Authorization Header 等内容进行脱敏；
- `result_excerpt` 限制长度；
- 完整会话遵循 Pi 原有 Session 存储规则。

---

## 24. 错误码

建议统一错误码：

| 错误码 | 含义 |
|---|---|
| `TASK_NOT_FOUND` | 任务不存在 |
| `TASK_PAUSED` | 任务已暂停 |
| `INVALID_SCHEDULE` | 调度配置无效 |
| `INVALID_TIMEZONE` | 时区无效 |
| `CWD_NOT_FOUND` | 工作目录不存在 |
| `TASK_ALREADY_RUNNING` | 同一任务已有实例运行 |
| `MODEL_UNAVAILABLE` | 配置模型不可用 |
| `PROMPT_FAILED` | Pi Prompt 执行失败 |
| `TASK_TIMEOUT` | 超时 |
| `TASK_CANCELLED` | 用户取消 |
| `PROCESS_RESTARTED` | 进程重启导致中断 |
| `SCHEDULER_NOT_LEADER` | 当前进程不是调度 Leader |
| `DATABASE_ERROR` | 数据库错误 |
| `NOTIFICATION_FAILED` | 通知失败，仅作为警告 |

---

## 25. 日志和可观测性

统一日志前缀：

```text
[pi-hub:scheduler]
[pi-hub:task-runner]
[pi-hub:task-store]
[pi-hub:notifier]
```

关键日志：

- Scheduler 启动和停止；
- Leader 租约获取和丢失；
- 每次任务抢占；
- Run 入队、开始和结束；
- Agent Session ID；
- Misfire 决策；
- 超时和取消；
- 数据库迁移；
- 通知失败。

不得每 10 秒无条件打印一次 Tick 日志，避免日志污染。只有状态变化或异常时记录。

---

## 26. 为什么不采用其他方案

### 26.1 不直接使用系统 Cron

系统 Cron 的问题：

- Web UI 无法统一管理；
- 一次性任务不方便；
- 缺少执行历史；
- 无法自然关联 Pi Session；
- 无法统一暂停、恢复和通知；
- 部署和迁移任务困难。

### 26.2 不只使用 node-cron

仅把任务注册到内存中的 `node-cron`：

- 服务重启后需要重新注册；
- 难以正确处理错过的任务；
- 多进程容易重复触发；
- 缺少原子抢占和防重复机制；
- 不能作为任务状态的唯一事实来源。

因此 V1 使用数据库中的 `next_run_at` 作为事实来源，Cron 仅用于计算下一次时间。

### 26.3 V1 不使用 BullMQ

BullMQ 需要 Redis。当前需求是单用户、单机和低并发，Redis 会增加：

- 部署复杂度；
- 数据备份复杂度；
- 服务依赖；
- 故障点。

当未来出现多实例、分布式 Worker 或大量任务时，再评估迁移到队列系统。

### 26.4 不直接启动 Pi CLI 子进程

Pi Hub 已经具备进程内 AgentSession 能力。直接调用 Pi CLI 会导致：

- 两套 Session 创建逻辑；
- 模型和工具行为不一致；
- 无法直接复用现有运行状态；
- 结果和错误采集更困难；
- 增加上游维护成本。

---

## 27. 测试设计

### 27.1 单元测试

#### ScheduleCalculator

- 每日任务计算下一次时间；
- 当前时间恰好等于计划时间；
- 跨天、跨月和跨年；
- 不同时区；
- 夏令时；
- 一次性任务过去和未来时间；
- Misfire 宽限时间边界。

#### TaskStore

- 数据库迁移；
- 创建、编辑、暂停和删除；
- Revision 冲突；
- `dedupe_key` 防重复；
- 原子抢占；
- Run 快照；
- Leader 租约。

#### PromptRunWaiter

- `prompt_done` 正常结束；
- `prompt_error` 后收到 `prompt_done`；
- 第一次 `agent_end` 不结束；
- 超时调用 `abort`；
- 取消；
- 重复终止事件只完成一次；
- 自动取消 Extension UI 请求。

### 27.2 集成测试

使用 Fake TaskExecutor 测试：

- 每日任务准时生成 Run；
- 一次性任务只执行一次；
- 两次 Tick 不重复创建 Run；
- 进程重启后补执行；
- 超过宽限期后跳过；
- 全局并发为 1；
- 同任务重叠被跳过；
- 手动执行不改变下次计划时间；
- Task 删除后历史仍存在。

### 27.3 Pi 集成验证

- 能创建新的 Pi Session；
- Session 出现在现有会话列表；
- Session 名称正确；
- Agent 能使用任务配置的工具；
- 能正确获得最后一条 Assistant 文本；
- Prompt 失败后 Run 状态正确；
- 页面未打开时仍能执行；
- 浏览器刷新不影响任务。

---

## 28. 验收标准

V1 完成必须满足：

1. 用户可以创建一个每天 08:00 执行的任务；
2. 用户可以创建一个指定日期时间执行一次的任务；
3. 关闭浏览器后任务仍能执行；
4. Pi Hub 重启后任务仍存在；
5. 一次性任务不会因多次扫描重复执行；
6. 每次执行创建独立 Pi Session；
7. 任务历史可以跳转到对应 Session；
8. 任务可暂停和恢复；
9. 用户可立即执行任务；
10. Agent 执行失败和超时有明确记录；
11. Scheduler 重复初始化不会重复触发任务；
12. 不修改 Pi 原有 Session 文件格式；
13. 不使用 `~/.pi-web/`；
14. 现有 Chat、Session、Skills、Plugins 和模型配置功能不受影响；
15. 上游 pi-web 更新时，定时功能主要集中在新增模块中。

---

## 29. 实施阶段

### 阶段一：调度核心

- `~/.pi/hub/` 路径解析；
- SQLite 初始化和迁移；
- TaskStore；
- ScheduleCalculator；
- Scheduler 租约；
- Due Task Scanner；
- Run Claim；
- 恢复和 Misfire。

### 阶段二：Pi 执行器

- PiTaskExecutor；
- PromptRunWaiter；
- Session 命名；
- 最终文本提取；
- 超时、取消和 Extension UI 自动响应；
- Run 状态更新。

### 阶段三：API

- Task CRUD；
- 立即执行；
- Run 查询；
- Scheduler 状态；
- Schedule Preview；
- 参数校验和错误码。

### 阶段四：Web UI

- 任务列表；
- 每日和一次性任务编辑器；
- 执行历史；
- Session 跳转；
- Scheduler 状态；
- i18n 文案。

### 阶段五：TelePi

- TaskNotifier 接口；
- TelePi Adapter；
- 成功和失败通知；
- 通知配置页面；
- 通知失败记录。

---

## 30. 需要特别注意的实现点

1. `session.send({ type: "prompt" })` 不是等待 Agent 完成的 Promise；
2. 必须在发送 Prompt 前订阅事件，避免丢失快速完成事件；
3. 必须等待 `prompt_done`，不能在第一次 `agent_end` 时结束 Run；
4. Agent 执行期间不能持有 SQLite 事务；
5. 一次性任务在抢占成功时即消费调度机会，避免重启后重复执行；
6. `dedupe_key` 必须有数据库唯一约束，不能只依靠内存判断；
7. Next.js 热更新环境必须使用 `globalThis` 防重复初始化；
8. 独立进程之间必须使用 SQLite 租约；
9. 定时任务中的交互式扩展请求必须自动响应或取消；
10. TelePi 通知失败不得改变 Agent Run 的最终状态；
11. 每次运行必须保存 Session ID；
12. 不允许通过定时功能修改 Pi Session JSONL 格式；
13. 所有时间必须明确时区并以 UTC 落库；
14. 新增代码优先放在 `modules/scheduler/`，避免散落到上游目录。

---

## 31. 最终结论

Pi Hub 的定时执行功能适合采用“进程内调度器 + SQLite 持久化 + 现有 AgentSession 执行链路”的方案。

该方案能够同时满足：

- 每日任务；
- 一次性任务；
- Web 管理；
- 执行历史；
- 服务重启恢复；
- 独立 Pi Session；
- TelePi 扩展；
- 对上游 pi-web 的低侵入维护。

V1 不引入 Redis 和独立 Worker 服务，优先把单机个人 Agent 控制中心做稳定。未来需要分布式执行时，可以保留 TaskService、TaskStore 和 TaskExecutor 接口，将 SchedulerRuntime 或执行队列替换为独立服务，而不需要重写任务管理页面和领域模型。
