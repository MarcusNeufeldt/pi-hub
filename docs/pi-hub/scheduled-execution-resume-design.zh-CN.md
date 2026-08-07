# Pi Hub 定时执行恢复模式设计

> 状态：Draft  
> 版本：V1  
> 日期：2026-08-08  
> 适用仓库：`jiangliuhong/pi-hub`  
> 关联文档：`scheduled-execution-design.zh-CN.md`（V1 定时执行总设计）

## 1. 文档目标

本文档定义 Pi Hub 定时执行功能的 **恢复模式（Resume Mode）**：允许定时任务直接在一个已存在的 Pi Session 上继续对话，而不是每次创建新 Session。

该能力主要解决以下场景：

- 一次 Agent 执行因为大模型配额限制（如 5 小时滚动限额）而中途终止；
- Session 中已经完成了大量有价值的上下文工作；
- 用户希望在配额刷新窗口后，自动接着原 Session 继续完成任务。

本设计是对 V1 定时执行总设计的 **扩展**，不改变 V1 的默认行为。新增能力以 opt-in 形式提供，默认仍然每次新建 Session。

---

## 2. 与 V1 设计的关系

V1 总设计（`scheduled-execution-design.zh-CN.md`）明确：

- §4.2 将“在同一个固定 Session 中持续执行周期任务”列为 V1 不包含；
- §5.4 核心原则“每次执行独立会话”，理由是避免不同日期上下文相互污染、方便追踪和审计；
- §16.6 默认不自动重试 Agent 任务，理由是 Agent 可能已经产生副作用。

本设计不否定上述原则，而是针对一个 **性质不同的子场景** 做窄豁免：

| 维度 | V1 默认（新建） | 本设计（恢复） |
|---|---|---|
| 场景 | 周期巡检、一次性任务 | 失败执行的重试恢复 |
| 上下文诉求 | 隔离、可审计 | **必须保留**（否则白干） |
| 续接次数 | 不复用 | 通常 1~2 次，任务即结束 |
| 心智模型 | 每次独立任务 | 同一个对话的断点续传 |
| 副作用风险 | 无（全新开始） | 低（任务本身未完成） |

因此恢复模式保留独立会话、不污染周期任务、并以 once 任务承载，**不与 V1 原则冲突**。

---

## 3. 决策摘要

采用以下方案：

- 在 `TaskDefinition` 上新增可选 `resume` 配置，指向目标 Session 文件；
- 执行器复用现有 `startRpcSession()` 管线，仅把 `sessionFile` 参数从 `""`（新建）改为目标路径（续接）；
- 不引入第二套 Session 创建逻辑，不修改 Pi Session JSONL 格式；
- 续接前做内存态互斥检查，避免与浏览器并发写同一文件；
- 续接模式下显式 `set_model`，绕过 `startRpcSession` 对已有 Session 的模型忽略分支；
- 恢复 Prompt 采用“断点续传”信封，不重发原始任务正文，避免重复执行已完成工作；
- 以 once 任务承载恢复语义，成功即 `completed`；
- 提供（可选）限额错误自动顺延的窄豁免，默认关闭。

---

## 4. 为什么不采用其他路径

### 4.1 不用“每次新建 Session”

新建会丢弃失败 Session 中已完成的上下文。对于“因为限额没跑完”的任务，这是不可接受的回退。

### 4.2 不用“Fork 起点模式”

Fork 会生成一个独立的 `.jsonl` 文件，带来三个问题：

1. 破坏“同一个对话”的心智模型——用户期望恢复后仍在原 Session 里看到完整轨迹；
2. 失败 Session 末尾往往是未完成的 assistant message 或失败 toolCall，Fork 这些中间态语义不明；
3. `task_runs.session_id` 会指向 Fork 出的新文件，与原失败 Session 关联断裂，不利于追溯。

Fork 起点模式更适合“周期巡检要继承昨日结论”的场景，不适合“一次失败执行的重试”。

### 4.3 不用“直接重跑原始 Prompt”

在原 Session 上重发原始任务 Prompt，会让模型把已完成的工作再做一遍（可能重复改文件、重复调用接口）。必须使用专门的恢复 Prompt（见 §8）。

---

## 5. 总体流程

```text
用户在失败 Session（或其 Run 详情）上选择“定时恢复”
        │
        ▼
创建 resume 型 once 任务
  （记录 sessionFile / sessionId / 原始 Prompt / 可选覆盖模型）
        │
        ▼
配额刷新窗口到达
        │
        ▼
执行器：校验 sessionFile 仍存在
        │
        ├── 不存在 ──▶ failed (SESSION_NOT_FOUND)
        │
        ▼
互斥检查：目标 Session 是否被占用（浏览器或其它任务在用）
        │
        ├── 被占用 ──▶ skipped (SESSION_BUSY)，once 任务机会保留
        │
        ▼
startRpcSession(tempKey, sessionFile, cwd)   ← open 续接分支
        │
        ▼
（可选）set_model 覆盖为任务配置的模型
        │
        ▼
发送恢复 Prompt（断点续传信封）
        │
        ▼
等待 prompt_done / prompt_error
        │
        ├── prompt_done ──▶ 提取结果摘要 ──▶ success ──▶ 任务 completed
        │
        └── prompt_error ──▶ failed
                              │
                              ├── 命中限额且开启自动顺延 ──▶ 重算 next_run_at，attempt++
                              └── 否则交由用户决定
```

---

## 6. 数据模型改动

### 6.1 新增类型

在 `modules/scheduler/types.ts` 增加 `ResumeTarget`，并把它作为 `TaskDefinition` 的可选字段：

```ts
export interface ResumeTarget {
  /** 要续接的 Session jsonl 绝对路径。 */
  sessionFile: string;
  /** 冗余的 Session id，方便 UI 展示与互斥查找。 */
  sessionId: string;
  /**
   * 续接时覆盖 Session 已有模型；不填则沿用 Session 上次使用的模型。
   * 续接模式下 startRpcSession 会忽略 initialModel（见 §9），因此需要
   * 在 Session 启动后显式 set_model 才能生效。
   */
  provider?: string;
  modelId?: string;
}

export interface TaskDefinition {
  // ...现有字段
  /** 非 null 表示恢复模式；null/undefined 保持 V1 的“每次新建”行为。 */
  resume?: ResumeTarget | null;
}
```

> 设计选择：把 `resume` 与 `execution`（模型/工具/超时）拆成并列字段，而不是塞进 `execution`。两者语义维度不同——`resume` 描述“从哪里来”，`execution` 描述“怎么跑”。

### 6.2 数据库迁移

在 `scheduled_tasks` 和 `task_runs` 上各增加一个可空 JSON 列，走 `schema-migrations.ts` 的版本化迁移机制：

```sql
ALTER TABLE scheduled_tasks ADD COLUMN resume_json TEXT;
ALTER TABLE task_runs     ADD COLUMN resume_snapshot_json TEXT;
```

`task_runs` 同样打快照（§10.2 设计原则：任务编辑或删除后历史仍可解释）。

### 6.3 DTO 与 Service

- `lib/scheduler-dto.ts` 的 `CreateTask` / `TaskDTO` 增加可选 `resume` 字段，epoch 时间转换规则不变；
- `lib/scheduler-coerce.ts` 增加校验：`resume.sessionFile` 必须是绝对路径且指向 `.jsonl`；`resume.provider` 与 `resume.modelId` 必须同时为空或同时有值；
- `modules/scheduler/task-service.ts` 的 `insertRunIfAbsent` 在打 run 快照时一并写入 `resume_snapshot_json`（从 `task.resume` 取）。

---

## 7. 执行器改动

`modules/scheduler/pi-task-executor.ts` 目前在第 100 行附近硬编码 `sessionFile = ""`：

```ts
session = await startSession(`__scheduled_task__${run.id}`, "", cwd, { ... });
```

改为根据 run 快照分流：

```ts
const resume = run.resumeSnapshotJson
  ? (JSON.parse(run.resumeSnapshotJson) as ResumeTarget)
  : null;

// 1. 续接模式下先校验目标 Session 文件仍在
if (resume && !existsSync(resume.sessionFile)) {
  progress.onFinish({
    status: "failed",
    errorCode: SchedulerErrorCode.SESSION_NOT_FOUND,
    errorMessage: `Session file no longer exists: ${resume.sessionFile}`,
    ...
  });
  return;
}

// 2. 互斥检查（见 §9），必须先于 startSession
if (resume && isSessionInUse(resume.sessionId)) {
  progress.onFinish({
    status: "failed", // 或新增带原因的 skipped
    errorCode: SchedulerErrorCode.SESSION_BUSY,
    errorMessage: `Session ${resume.sessionId} is currently active. Skipped to avoid concurrent writes.`,
    ...
  });
  return;
}

// 3. cwd：续接时沿用快照（即原 Session 的 cwd），仍做 realpath 校验
const cwd = run.cwdSnapshot; // 已在现有 §23.1 校验逻辑里处理

// 4. 关键：resume 有值就走 open 续接，无值保持新建
session = await startSession(
  `__scheduled_task__${run.id}`,
  resume?.sessionFile ?? "",
  cwd,
  {
    ...(execution.toolNames.length ? { toolNames: execution.toolNames } : {}),
    ...(execution.provider && execution.modelId
      ? { initialModel: { provider: execution.provider, modelId: execution.modelId } }
      : {}),
    ...(execution.thinkingLevel ? { thinkingLevel: execution.thinkingLevel as never } : {}),
  },
);

// 5. 续接模式下 startRpcSession 忽略 initialModel，显式覆盖
if (resume?.provider && resume?.modelId) {
  await session.send({
    type: "set_model",
    provider: resume.provider,
    modelId: resume.modelId,
  });
}
```

`SessionStarter` 类型与 `createRealSessionStarter` 适配器签名本就以 `sessionFile` 为参数，无需改动。

需要新增的错误码（`modules/scheduler/errors.ts`）：

| 错误码 | 含义 |
|---|---|
| `SESSION_NOT_FOUND` | 目标 Session 文件不存在或已被删除 |
| `SESSION_BUSY` | 目标 Session 正被占用，本轮跳过 |

---

## 8. 恢复 Prompt 设计

**核心原则：不重发原始任务正文。** 恢复 Prompt 的职责是让模型“意识到此前中断、从断点继续、不重复已完成工作”。

```ts
/** 续接模式下的断点续传信封（与 V1 buildPrompt 并列，不要复用）。 */
export function buildResumePrompt(originalTaskPrompt: string): string {
  return [
    "[Pi Hub Resume Execution]",
    "The previous run in this session was interrupted before completion",
    "(most likely by a provider rate limit or quota).",
    "",
    "Instructions:",
    "1. Review the conversation above to see what was already accomplished.",
    "2. Do NOT redo work that already succeeded.",
    "3. Resume the task from where it stopped. If the last action failed mid-way,",
    "   assess its partial effects before continuing.",
    "4. If a blocker remains, explain it in the final response.",
    "",
    "<Original task for reference>",
    originalTaskPrompt.trim(),
  ].join("\n");
}
```

执行器中根据 `resume` 是否存在选择 `buildPrompt` 还是 `buildResumePrompt`。

### 8.1 待验证项

限额中断时，Session jsonl 末尾的形态尚不确定，可能是：

- 一条完整的 user message + 缺失的 assistant 响应（干净可续）；或
- 一条未完成的 assistant message + 失败的 toolCall（断点不干净）。

第二种情况下 Pi 重新 `SessionManager.open` 时能否正常接续，需要先在真机上验证。建议实施前手动实验：把一个限额中断的 Session 文件用 `pi` CLI 续上，观察行为，再据此调整恢复 Prompt 措辞（例如是否需要更强的“先修复断点”引导）。

---

## 9. 互斥保护（必做）

### 9.1 风险

`startRpcSession` 的 registry（`lib/rpc-manager.ts`）按传入的 sessionId 索引。定时执行传入的临时键是 `__scheduled_task__{runId}`，**查不到**用户在浏览器里正打开的同一 Session 的 wrapper，于是会基于同一文件 `SessionManager.open` 出第二份内存态，两份内存态并发写同一 jsonl 会造成数据竞争和文件损坏。

### 9.2 方案

续接前调用 registry 自检（`getRpcSession` 已在 `rpc-manager.ts` 导出）：

```ts
import { getRpcSession } from "@/lib/rpc-manager";

function isSessionInUse(sessionId: string): boolean {
  const wrapper = getRpcSession(sessionId);
  return !!wrapper?.isAlive();
}
```

被占用时本轮直接 `skipped`（不 mark completed，保留 once 任务执行机会），错误码 `SESSION_BUSY`，等用户关闭浏览器后再点“立即执行”。

### 9.3 边界

- 该互斥只能防“pi-web 进程内”的并发。V1 明确只支持单实例部署，跨进程并发不在本设计范围内。
- 未来若放开多实例，需要引入基于 sessionFile 的跨进程文件锁。

---

## 10. 模型配置处理

续接模式下 `startRpcSession` 因 `hasExistingMessages === true`（`rpc-manager.ts` 第 1230 行附近）走 `scopedModels` 分支，会**忽略** `initialModel` 与 `thinkingLevel`。

两种策略：

| 策略 | 行为 | 适用 |
|---|---|---|
| **覆盖**（推荐） | resume 配置里指定 `provider/modelId`，Session 起来后显式 `set_model` | 配额刷新后想换模型或确保同一模型 |
| **沿用** | resume 不带模型字段，使用 Session 上次模型 | “限额就是当前模型触发的，刷新后继续用同一个” |

UI 上提供开关：“使用原 Session 模型 / 覆盖为指定模型”。

> `thinkingLevel` 在续接模式下同样被忽略。如需保证，Session 起来后显式 `set_thinking_level`，处理方式与 `set_model` 一致。

---

## 11. 限额自动顺延（可选，默认关闭）

V1 §16.6 默认不自动重试，理由是 Agent 可能已经产生副作用。但限额中断属于副作用最小的可重试错误（任务本身尚未完成），值得做窄豁免。

### 11.1 配置

```ts
// TaskDefinition 新增可选字段
retryOnRateLimit?: {
  enabled: boolean;
  /** 顺延间隔（分钟），如 300 表示 5 小时。 */
  intervalMinutes: number;
  /** 最大尝试次数，含首次。 */
  maxAttempts: number;
};
```

### 11.2 错误识别

`prompt-run-waiter.ts` 已经捕获 `prompt_error` 到 `result.error`。对其做限额特征匹配：

```ts
const RATE_LIMIT_PATTERNS = [
  /rate[\s-]?limit/i,
  /quota/i,
  /\b5h\b/,               // 5 小时滚动限额
  /too many requests/i,
  /\b429\b/,
];

export function isRateLimitError(message: string | null): boolean {
  return !!message && RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}
```

### 11.3 顺延逻辑

执行失败时：

```text
若 isRateLimitError(error) && retryOnRateLimit.enabled && attempt < maxAttempts:
    不 mark completed
    重算 next_run_at = now + intervalMinutes
    attempt++
    任务保持 active
否则:
    正常 failed（保护副作用类错误不被重试）
```

### 11.4 风险与缓解

限额文案因 provider 而异，启发式匹配存在漏判与误判：

- **漏判**：未识别为限额 → 正常 failed，用户手动重试，可接受；
- **误判**：非限额错误被识别为限额 → 多跑一次，因 `maxAttempts` 有上限，影响可控。

建议 UI 上让用户**手动勾选**“如果是限额错误则自动顺延”，而不依赖自动识别——即使误判也只是多跑一次。

---

## 12. Web UI 改动

### 12.1 任务编辑器（`components/TasksConfig.tsx`）

任务编辑器顶部增加“**任务模式**”单选：

- **新建会话**（默认，V1 行为）
- **继续已有会话**（恢复模式）

选择恢复模式后：

1. 出现 Session 选择器，复用 `GET /api/sessions` 的列表数据；建议只列出与任务同 `cwd` 的 Session 以减少误选；
2. `schedule` 默认锁成 `once`（恢复是一次性行为）；
3. `cwd` 只读（从选中 Session 继承，避免 §6.1 的 cwd 冲突）；
4. 模型给“沿用原 Session 模型 / 覆盖为指定模型”开关；
5. 显眼提示：“将直接在原会话上继续，请确保执行时该会话未在浏览器中使用”；
6. 可选开关：“若因配额限制再次失败，自动顺延重试（间隔 / 次数）”。

### 12.2 推荐入口

最理想的入口不是任务编辑器，而是**失败 Session 的 Run 详情页或 Chat 页**上的“⏰ 定时恢复”按钮：

- 一键预填 `resume` 字段（sessionFile / sessionId / cwd 全部来自当前失败 Run）；
- 用户只需选择恢复时间（或确认自动顺延配置）；
- 降低创建恢复任务的认知负担。

---

## 13. 分阶段实施

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P1 最小可用** | 类型 + 迁移 + 执行器 open 分支 + `buildResumePrompt` + `SESSION_BUSY` / `SESSION_NOT_FOUND` 互斥 | 手动插 SQL 即可验证恢复闭环 |
| **P2 体验** | 任务编辑器 resume UI + 失败 Run“定时恢复”一键入口 | 全流程可用 |
| **P3 自动化** | `retryOnRateLimit` 自动顺延 + 限额错误识别 | 真正“挂机等刷新” |

建议 P1 先行：手动往 `scheduled_tasks` 插一条带 `resume_json` 的 once 任务，在真机上验证“限额中断 Session 续接”的完整闭环（含 §8.1 的断点形态确认），再补 UI。

---

## 14. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 断点 jsonl 状态未知（§8.1） | 实施前在 CLI 验证续接行为 |
| 2 | 与浏览器并发写同一 jsonl | §9 进程内互斥兜底 |
| 3 | 限额错误误判导致无谓重试 | §11.4 默认关闭，用户显式开启，`maxAttempts` 设上限 |
| 4 | 目标 Session 被用户中途删除 | 执行前 `existsSync` 校验，`SESSION_NOT_FOUND` |
| 5 | 同一 Session 被多个 resume 任务引用 | UI 选过的不让再选，或执行时提示已存在引用 |
| 6 | 续接模式下模型/Thinking 配置静默失效 | §10 显式 `set_model` / `set_thinking_level` |
| 7 | 多实例部署下的跨进程并发 | V1 单实例范围内可接受；多实例需引入文件锁 |

---

## 15. 验收标准

1. 用户可以创建一个指向某已有 Session 的恢复任务；
2. 到点后任务在该 Session 上继续对话，而非新建 Session；
3. 恢复 Prompt 不重复执行已完成工作；
4. 当目标 Session 正被浏览器使用时，本轮安全跳过并保留执行机会；
5. 当目标 Session 文件已被删除时，任务以 `SESSION_NOT_FOUND` 失败；
6. 恢复成功后 once 任务进入 `completed`，原 Session 在会话列表中可见完整轨迹；
7. 开启自动顺延后，限额类失败会按配置间隔重试，达上限后停止；
8. V1 的默认行为（每次新建 Session）不受任何影响；
9. 上游 pi-web 文件无破坏性修改，新增代码集中在 `modules/scheduler/` 与必要的接入点。

---

## 16. 后续方向

- **跨进程文件锁**：放开多实例部署后，为续接模式引入基于 sessionFile 的跨进程互斥；
- **断点感知恢复**：解析 jsonl 末尾的未完成 toolCall，在恢复 Prompt 中提供更精确的断点描述；
- **恢复任务模板化**：把“失败 Run → 恢复任务”沉淀为一键操作，自动继承原任务的模型/工具/超时配置；
- **与 TelePi 通知打通**：恢复成功 / 顺延时通过通知适配器告知用户。
