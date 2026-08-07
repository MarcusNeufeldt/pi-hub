# Pi Hub Telegram 接入设计

> 状态：Draft  
> 版本：V1  
> 日期：2026-08-07  
> 适用仓库：`jiangliuhong/pi-hub`  
> 参考实现：`benedict2310/TelePi` / `@futurelab-studio/telepi` `v0.4.2`  
> 参考源码基线：`60b5742473d81c01286ac35bf2b052c738f1555a`

## 1. 文档目标

本文档定义 Pi Hub 的 Telegram 接入方案，使 Telegram 成为 Pi Hub 的移动端交互入口、远程任务控制入口和通知通道。

目标能力包括：

1. 在 Telegram 中发送文本 Prompt，创建或继续 Pi Session；
2. 在 Telegram 与 Pi Hub Web UI 中查看同一份 Session；
3. 浏览、创建和切换不同工作区中的 Session；
4. 远程停止正在执行的 Agent；
5. 接收定时任务成功、失败和异常通知；
6. 在 Telegram 中查看并手动执行定时任务；
7. 后续支持图片、语音、Pi 命令桥接、扩展交互和 CLI handoff；
8. 通过 Pi Hub Web UI 完成 Bot 配置、用户配对、状态查看和权限管理。

该设计必须遵守仓库中的：

- `AGENTS.md`
- `AGENTS.local.md`
- `docs/pi-hub/scheduled-execution-design.zh-CN.md`

核心原则：

> Telegram 是 Pi Hub 的一个客户端和传输通道，不是另一套独立的 Pi Agent Runtime。

---

## 2. TelePi 能力分析

TelePi 是一个独立运行的 Telegram Bot 服务，它直接创建和维护 Pi AgentSession，并通过 Telegram 提供移动端控制能力。

其主要能力包括：

- Telegram 用户白名单；
- 每个 Telegram Chat / Forum Topic 独立维护 Pi Session；
- 文本 Prompt；
- 图片输入；
- 语音转写；
- 流式消息更新；
- 工具执行状态展示；
- Session 创建、切换和跨工作区浏览；
- 模型切换；
- Pi Prompt、Skill 和 Extension 命令桥接；
- Extension 的 select、confirm、input 交互；
- Session Tree、Branch 和 Label；
- CLI 到 Telegram 的 `/handoff`；
- Telegram 到 CLI 的 `/handback`；
- 外部 Prompt Inbox；
- macOS launchd 和 Linux systemd 用户服务；
- 长轮询冲突、限流和消息格式错误处理。

### 2.1 能力采纳矩阵

| TelePi 能力 | Pi Hub 决策 | 阶段 | 说明 |
|---|---|---:|---|
| Telegram Long Polling | 采纳 | P0 | 适合私有服务器，不要求公网 Webhook |
| 用户 ID 白名单 | 采纳并增强 | P0 | 增加 Web 配对码与角色权限 |
| 每个 Chat / Topic 独立 Session | 采纳 | P0 | 映射关系持久化到 Pi Hub SQLite |
| 文本 Prompt | 采纳 | P0 | 复用 Pi Hub AgentSession |
| Session 创建与切换 | 采纳 | P0 | 复用 Pi Hub Session Reader 和 RPC Manager |
| 流式回复 | 采纳 | P0 | 消息编辑节流，最终按 Telegram 长度限制分片 |
| `/abort`、`/retry` | 采纳 | P0 | 通过统一执行协调器实现 |
| 定时任务通知与控制 | Pi Hub 新增 | P0 | TelePi 本身不提供完整任务中心 |
| Pi 命令选择器 | 采纳 | P1 | 复用现有 `get_commands` 能力 |
| 模型切换 | 采纳 | P1 | 复用现有模型和 Session 能力 |
| 图片输入 | 采纳 | P1 | 临时文件、大小限制和 MIME 校验 |
| Extension select / confirm / input | 采纳 | P1 | Telegram 原生按钮和文本回复 |
| Telegram Forum Topic | 架构支持，默认关闭群组 | P1 | 私聊默认开启；群组需显式授权 |
| CLI handoff / handback | 重新设计 | P2 | 不重启 Pi Hub，使用本地控制接口 |
| 语音转写 | 采纳为可选模块 | P2 | 不让重量级原生依赖进入核心安装 |
| Session Tree / Branch / Label | 采纳 | P2 | 与现有 Session 树能力对齐 |
| Prompt Inbox | 不直接采纳 | — | 由 Pi Hub Scheduler 和 API Trigger 替代 |
| 独立 TelePi systemd 服务 | 不采纳 | — | Bot Runtime 由 Pi Hub 进程统一管理 |

---

## 3. 核心架构决策

### 3.1 不直接嵌入 TelePi 进程

Pi Hub 不直接启动或嵌入 `@futurelab-studio/telepi` 的完整运行时。

原因：

1. TelePi 是独立应用，不是稳定的 Telegram Transport SDK；
2. TelePi 内部拥有自己的 `PiSessionRegistry` 和 AgentSession 生命周期；
3. Pi Hub 已经有 `lib/rpc-manager.ts` 和 Session Registry；
4. 两套 Runtime 会重复打开同一个 Session 文件，存在并发写入风险；
5. 同一个 Telegram Bot Token 不能同时被 TelePi 和 Pi Hub 长轮询，否则会产生 `409 Conflict`；
6. TelePi 当前依赖的 Pi SDK 版本与 Pi Hub 不完全一致；
7. 直接依赖 TelePi 会让 Pi Hub 的上游同步、升级和错误排查更加复杂。

### 3.2 原生 Telegram 模块

Pi Hub 新增：

```text
modules/telegram/
```

该模块参考 TelePi 的产品能力和交互设计，但直接调用 Pi Hub 已有的 Session、模型、任务和 Agent 执行服务。

### 3.3 单一 Agent 执行入口

需要增加一个共享执行协调层：

```text
modules/agent-execution/
```

Web、Telegram 和 Scheduler 都必须通过同一个协调层执行 Prompt，避免多个入口同时写入一个 Session。

### 3.4 Long Polling 优先

V1 使用 Telegram Long Polling：

- 不要求公网域名；
- 不要求 TLS Webhook；
- 适合当前 OCI Ubuntu 常驻服务；
- 与 Pi Hub 的本地部署模式一致。

Webhook 作为后续可选部署方式，不进入 V1。

### 3.5 私聊优先

V1 默认只允许 Telegram 私聊：

```text
telegram.privateOnly = true
```

群组和 Forum Topic 的数据结构从第一版开始预留，但必须由用户在 Web UI 中显式开启并授权具体 Chat ID。

---

## 4. 总体架构

### 4.1 Telegram 发起 Agent 执行

```text
┌──────────────────────────────────────────────────────────────┐
│                         Telegram Client                      │
│                                                              │
│  Text / Command / Image / Voice / Inline Callback            │
└───────────────────────────────┬──────────────────────────────┘
                                │ Telegram Bot API
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                    Pi Hub Telegram Runtime                   │
│                                                              │
│  TelegramTransport                                            │
│       │                                                       │
│       ├── Authentication / Pairing                            │
│       ├── Chat + Topic Context                                │
│       ├── Command Router                                      │
│       ├── Prompt Controller                                   │
│       ├── Attachment Handler                                  │
│       ├── Extension Dialogs                                   │
│       └── Message Renderer                                    │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                  AgentExecutionCoordinator                   │
│                                                              │
│  Session Lock / Run Owner / Event Routing / Abort             │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                Existing Pi Hub Agent Runtime                 │
│                                                              │
│  startRpcSession()                                            │
│  AgentSessionWrapper                                          │
│  SessionManager                                               │
│  Pi SDK                                                       │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 定时任务通知

```text
Scheduler
    │
    ▼
Task Run
    │
    ▼
TelegramTaskNotifier
    │
    ▼
Notification Outbox
    │
    ▼
TelegramTransport
    │
    ▼
Telegram Chat / Topic
```

通知失败不改变 Task Run 的最终状态。

---

## 5. 功能范围

### 5.1 P0：基础接入与任务控制

P0 必须包含：

- Web UI 配置 Bot Token；
- Bot Token 有效性检查；
- Telegram 用户配对；
- 用户白名单；
- 中文命令菜单和中文响应；
- Telegram Runtime 状态查看；
- 文本 Prompt；
- 每个 Chat / Topic 的独立 Session 映射；
- 新建 Session；
- 查看和切换 Session；
- 查看当前 Session；
- 停止当前执行；
- 重试上一个 Prompt；
- 查看定时任务；
- 手动执行定时任务；
- 定时任务成功和失败通知；
- Web 与 Telegram 共享同一个 Session；
- 未授权用户拦截；
- 同一 Session 并发写入保护；
- Bot Token 冲突提示。

### 5.2 P1：增强交互

P1 包含：

- Pi Prompt / Skill / Extension 命令选择器；
- 模型切换；
- Context 和 Session Stats；
- 图片输入；
- Extension select / confirm / input；
- Telegram 中创建定时任务的向导；
- 任务暂停和恢复；
- 群组和 Forum Topic 显式授权；
- Bot API 兼容的自建 Telegram API Endpoint；
- 任务和 Session 深链接。

### 5.3 P2：完整移动端控制

P2 包含：

- 语音转写；
- Session Tree；
- Branch；
- Label；
- CLI `/handoff`；
- Telegram `/handback`；
- Web、Telegram 和 CLI 的 Session 所有权切换；
- Webhook 部署模式；
- 多 Bot 配置。

### 5.4 不在范围内

- Telegram 内直接管理 Pi Hub 系统服务；
- Telegram 内执行任意未经过 Agent 的 Shell 命令；
- 通过 Telegram 修改 Bot Token；
- 默认允许任意群成员访问；
- 同一个 Session 被多个 Agent Prompt 并发修改；
- 在 V1 中支持多实例或 Kubernetes 横向扩容；
- 兼容任意非 Bot API 协议的 Telegram 私有实现。

---

## 6. 模块设计

建议新增：

```text
modules/
├── agent-execution/
│   ├── index.ts
│   ├── agent-execution-coordinator.ts
│   ├── agent-run-context.ts
│   ├── agent-event-sink.ts
│   ├── session-run-lock.ts
│   ├── prompt-run-waiter.ts
│   ├── types.ts
│   └── errors.ts
│
└── telegram/
    ├── index.ts
    ├── telegram-runtime.ts
    ├── telegram-runtime-lease.ts
    ├── telegram-config.ts
    ├── telegram-secret-store.ts
    ├── telegram-store.ts
    ├── sqlite-telegram-store.ts
    ├── telegram-bot.ts
    ├── telegram-transport.ts
    ├── telegram-auth.ts
    ├── telegram-pairing.ts
    ├── telegram-context.ts
    ├── telegram-dispatcher.ts
    ├── telegram-prompt-controller.ts
    ├── telegram-session-service.ts
    ├── telegram-task-service.ts
    ├── telegram-task-notifier.ts
    ├── telegram-outbox-worker.ts
    ├── telegram-command-catalog.ts
    ├── telegram-callback-actions.ts
    ├── telegram-message-renderer.ts
    ├── telegram-event-renderer.ts
    ├── telegram-extension-dialogs.ts
    ├── telegram-attachments.ts
    ├── telegram-voice.ts
    ├── telegram-handoff.ts
    ├── types.ts
    ├── errors.ts
    ├── commands/
    │   ├── basic.ts
    │   ├── sessions.ts
    │   ├── tasks.ts
    │   ├── models.ts
    │   ├── commands.ts
    │   └── tree.ts
    └── i18n/
        ├── zh-CN.ts
        └── en.ts
```

### 6.1 API 路由

```text
app/api/integrations/telegram/status/route.ts
app/api/integrations/telegram/config/route.ts
app/api/integrations/telegram/token/route.ts
app/api/integrations/telegram/test/route.ts
app/api/integrations/telegram/restart/route.ts
app/api/integrations/telegram/pairing-codes/route.ts
app/api/integrations/telegram/users/route.ts
app/api/integrations/telegram/users/[id]/route.ts
app/api/integrations/telegram/conversations/route.ts
app/api/integrations/telegram/conversations/[id]/route.ts
app/api/integrations/telegram/import-telepi/route.ts
```

### 6.2 Web UI

```text
app/settings/integrations/telegram/page.tsx
components/telegram/TelegramSettings.tsx
components/telegram/TelegramStatusCard.tsx
components/telegram/TelegramPairingPanel.tsx
components/telegram/TelegramUsers.tsx
components/telegram/TelegramConversations.tsx
components/telegram/TelegramNotificationSettings.tsx
components/telegram/TelePiImportPanel.tsx
```

### 6.3 上游文件修改边界

| 文件 | 修改目的 | 约束 |
|---|---|---|
| `instrumentation.ts` | 初始化 Telegram Runtime | 只增加独立模块初始化调用 |
| `app/api/agent/new/route.ts` | 接入统一 Agent 执行协调器 | 保持现有请求和返回兼容 |
| `app/api/agent/[id]/route.ts` | Prompt、Abort 和 UI Response 经过协调器 | 其他命令保持原逻辑 |
| `app/api/agent/[id]/events/route.ts` | 附加 Run Owner 信息并过滤非 Web 交互 | SSE 格式只做增量扩展 |
| `components/AppShell.tsx` 或设置入口 | 增加 Telegram 设置入口 | 不修改 Chat 行为 |
| `package.json` | 增加 Grammy 相关依赖 | 不替换上游依赖 |
| i18n 资源 | 增加 Telegram 文案 | 只增量添加 |

Telegram 业务逻辑不得写入 `ChatWindow`、`ChatInput` 或现有 Session Sidebar。

---

## 7. Telegram Runtime

### 7.1 启动方式

在 `instrumentation.ts` 的 Node.js Runtime 分支中调用：

```ts
const { startTelegramRuntime } = await import("@/modules/telegram");
await startTelegramRuntime();
```

`startTelegramRuntime()` 只完成初始化和后台启动，不等待 Long Polling 永久结束。

### 7.2 幂等初始化

使用：

```ts
globalThis.__piHubTelegramRuntime
```

避免 Next.js 开发模式热更新重复创建 Bot。

### 7.3 Runtime Lease

使用 SQLite 租约保证只有一个进程轮询同一个 Token：

```text
lease_name: telegram-bot
owner_id: process UUID
lease_until: timestamp
```

建议：

- 每 5 秒续租；
- 租约有效期 15 秒；
- Leader 启动 Long Polling；
- Follower 状态为 `standby`；
- 租约丢失后立即停止 Polling。

### 7.4 单进程部署约束

V1 正式支持：

```text
一个 Pi Hub Node.js 进程
```

原因：

- Pi Hub 当前 AgentSession Registry 存放在进程内；
- Web、Scheduler 和 Telegram 必须共享同一份 Registry；
- 多个 Next.js Worker 同时打开一个 Session 文件存在风险。

不得使用 PM2 Cluster 或多副本部署运行 V1 Telegram Agent 功能。

后续若需要横向扩容，应先把 Agent Runtime 拆为独立服务。

### 7.5 Long Polling 策略

建议：

```text
drop_pending_updates = true
```

理由：

- 编程 Agent Prompt 可能产生文件和网络副作用；
- 服务停机期间积压的旧命令不应在重启后突然执行；
- 安全性高于消息不丢失。

同时拒绝时间戳明显过旧的 Update。

### 7.6 Bot Token 冲突

当 Telegram 返回 `409 Conflict`：

1. Runtime 进入 `error` 状态；
2. 错误码为 `TELEGRAM_TOKEN_IN_USE`；
3. Web UI 显示：可能仍有 TelePi 或其他 Bot 进程使用该 Token；
4. 不自动终止外部进程；
5. 不持续高频重试；
6. 用户停止旧服务后，可在 Web UI 点击“重新启动”。

### 7.7 优雅停止

收到 `SIGINT`、`SIGTERM` 或配置禁用时：

- 停止 Long Polling；
- 停止 Outbox Worker；
- 释放 Lease；
- 清理临时交互状态；
- 不销毁仍被 Web 或 Scheduler 使用的公共 AgentSession。

---

## 8. 统一 Agent 执行协调器

Telegram 接入前必须解决多客户端并发问题。

### 8.1 问题

同一个 Session 可能同时收到：

- Web Chat Prompt；
- Telegram Prompt；
- Scheduled Task；
- Extension UI Response；
- Abort。

如果各入口直接调用 `session.send()`，可能出现：

- Prompt 相互排队或交叉；
- 两个客户端同时响应同一个 Extension Dialog；
- 一个客户端 Abort 另一个客户端的任务；
- Session JSONL 写入竞争；
- UI 展示的 Run Owner 不明确。

### 8.2 Run Context

```ts
export interface AgentRunContext {
  runId: string;
  sessionId: string;
  source: "web" | "telegram" | "scheduler" | "api";
  ownerKey: string;
  startedAt: number;
}
```

Telegram Owner Key：

```text
telegram:{chatId}:{threadId}
```

Web Owner Key：

```text
web:{clientId}
```

Scheduler Owner Key：

```text
scheduler:{taskRunId}
```

### 8.3 执行流程

```text
Acquire Session Run Lock
        │
        ▼
Open / Create AgentSession
        │
        ▼
Subscribe Events
        │
        ▼
Send Prompt
        │
        ▼
Route Events to Owner
        │
        ▼
Wait prompt_done / prompt_error
        │
        ▼
Release Session Run Lock
```

### 8.4 完成信号

Telegram 回复不能以第一次 `agent_end` 作为最终完成信号。

原因：

- Retry、Compaction 和 Extension 后续动作可能继续同一个逻辑 Prompt；
- Pi Hub 已经在 Wrapper 层提供 `prompt_done` 和 `prompt_error`。

规则：

- 文本和工具事件用于流式展示；
- `prompt_error` 保存错误；
- `prompt_done` 结束本次 Telegram Run；
- 超时后调用 `abort`；
- 事件订阅必须在发送 Prompt 前建立。

### 8.5 并发策略

V1：

- 同一 Session 同一时间只允许一个 Prompt Run；
- 同一 Telegram Conversation 同一时间只允许一个交互操作；
- 不同 Session 可以按 Pi Hub 全局并发上限运行；
- Session 正忙时返回“该会话正在由 Web / Telegram / Scheduler 执行”；
- V1 不自动把第二个 Prompt 排队，避免用户误以为立即执行。

### 8.6 Extension UI 所有权

交互型事件：

```text
select
confirm
input
editor
custom
```

必须由当前 Run Owner 响应。

例如 Telegram 发起 Prompt 时：

- Telegram 可以响应 select / confirm / input；
- Web SSE 可以看到该 Session 正在执行；
- Web 不展示可操作的交互按钮；
- Web 提交 `extension_ui_response` 时返回 `409 RUN_OWNED_BY_TELEGRAM`。

### 8.7 Abort 权限

- 当前 Run Owner 可 Abort；
- Pi Hub Owner 角色可强制 Abort；
- 普通 Telegram Operator 不能 Abort 其他用户拥有的 Run；
- Task 通知中的 Abort 按钮必须携带短期、单次 Action Token。

---

## 9. 身份认证与配对

### 9.1 身份来源

Telegram 用户身份使用：

```text
ctx.from.id
```

不能使用 Username 作为授权依据，因为 Username 可以修改。

### 9.2 配对流程

推荐流程：

```text
Pi Hub Web
   │
   ├── 配置 Bot Token
   ├── 验证 Bot
   └── 生成 6 位一次性配对码
             │
             ▼
Telegram
   │
   └── /pair 123456
             │
             ▼
Pi Hub 校验用户、配对码和过期时间
             │
             ▼
用户加入白名单
```

规则：

- 配对码有效期默认 10 分钟；
- 只能使用一次；
- 数据库只保存配对码 Hash；
- 连续失败需要限流；
- 第一个配对用户自动成为 Owner；
- 后续配对码可指定角色；
- 未配对用户只允许 `/start`、`/help` 和 `/pair`。

### 9.3 角色

| 角色 | 权限 |
|---|---|
| `owner` | 所有 Telegram 功能、用户管理、任务控制、强制 Abort |
| `operator` | Prompt、Session、查看和运行授权任务 |
| `viewer` | 只查看状态、任务结果和通知 |

### 9.4 私聊和群组

默认：

- 允许已配对用户的私聊；
- 拒绝群组、超级群组和 Channel；
- 不允许 Bot 响应其他用户转发的命令。

启用群组后：

- Chat ID 必须在 Web UI 中显式授权；
- 用户 ID 仍必须在白名单中；
- 每个 Forum Topic 使用独立 Conversation；
- Bot 输出可能被群成员看到，UI 必须给出风险提示；
- 群组不允许执行高风险任务，除非 Owner 显式开启。

### 9.5 限流

建议默认：

```text
每用户命令：30 次 / 分钟
每 Conversation Prompt：5 次 / 分钟
配对尝试：5 次 / 10 分钟
附件下载：5 个 / 分钟
```

命中限流时不调用 Agent。

---

## 10. 配置与 Secret

### 10.1 数据目录

```text
~/.pi/hub/
├── app.db
├── config.json
├── secrets.json
└── logs/
```

不得使用：

```text
~/.pi-web/
```

### 10.2 Bot Token

Bot Token 支持两种来源。

#### 环境变量

```text
PI_HUB_TELEGRAM_BOT_TOKEN
```

适合服务器部署。

#### 本地 Secret 文件

```text
~/.pi/hub/secrets.json
```

文件权限：

```text
0600
```

### 10.3 优先级

```text
环境变量
  > secrets.json
  > 未配置
```

当环境变量存在时：

- Web UI 显示“由环境变量管理”；
- 不允许通过 Web 修改或删除；
- API 不返回 Token；
- 日志中必须脱敏。

### 10.4 非敏感配置

示例：

```json
{
  "telegram": {
    "enabled": true,
    "privateOnly": true,
    "defaultLocale": "zh-CN",
    "defaultWorkspace": "/home/ubuntu/work",
    "toolVerbosity": "summary",
    "dropPendingUpdates": true,
    "apiRoot": "https://api.telegram.org",
    "fileApiRoot": "https://api.telegram.org/file",
    "publicUrl": null
  }
}
```

### 10.5 自建 Bot API Endpoint

Telegram Transport 必须抽象：

```ts
interface TelegramEndpointConfig {
  apiRoot: string;
  fileApiRoot: string;
}
```

仅保证兼容 Telegram Bot API 的服务端。

不承诺兼容：

- 任意 MTProto 服务；
- 修改过协议的第三方 Telegram Server；
- 不完整实现 Bot API 的私有服务。

---

## 11. SQLite 数据模型

Telegram 数据与 Scheduler 数据共用：

```text
~/.pi/hub/app.db
```

### 11.1 telegram_settings

```sql
CREATE TABLE telegram_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  private_only INTEGER NOT NULL DEFAULT 1,
  default_locale TEXT NOT NULL DEFAULT 'zh-CN',
  default_workspace TEXT,
  tool_verbosity TEXT NOT NULL DEFAULT 'summary'
    CHECK (tool_verbosity IN ('all', 'summary', 'errors-only', 'none')),
  drop_pending_updates INTEGER NOT NULL DEFAULT 1,
  api_root TEXT NOT NULL DEFAULT 'https://api.telegram.org',
  file_api_root TEXT NOT NULL DEFAULT 'https://api.telegram.org/file',
  public_url TEXT,
  bot_id INTEGER,
  bot_username TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
```

Token 不得存入该表。

### 11.2 telegram_users

```sql
CREATE TABLE telegram_users (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'operator', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1,
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

### 11.3 telegram_chats

```sql
CREATE TABLE telegram_chats (
  chat_id INTEGER PRIMARY KEY,
  chat_type TEXT NOT NULL,
  title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  approved_by INTEGER REFERENCES telegram_users(telegram_user_id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

### 11.4 telegram_conversations

```sql
CREATE TABLE telegram_conversations (
  chat_id INTEGER NOT NULL REFERENCES telegram_chats(chat_id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL DEFAULT 0,
  owner_user_id INTEGER REFERENCES telegram_users(telegram_user_id),

  active_session_id TEXT,
  active_session_path TEXT,
  workspace TEXT,

  locale TEXT NOT NULL DEFAULT 'zh-CN',
  tool_verbosity TEXT,
  last_prompt TEXT,

  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle', 'running', 'switching', 'transcribing', 'detached')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (chat_id, thread_id)
) STRICT;
```

`thread_id = 0` 表示 Chat 根上下文。

### 11.5 telegram_pairing_codes

```sql
CREATE TABLE telegram_pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'operator', 'viewer')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
```

### 11.6 telegram_actions

Inline Keyboard 的 Callback Data 长度有限，不能直接写入文件路径、完整 Session ID 或 Prompt。

```sql
CREATE TABLE telegram_actions (
  token TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  user_id INTEGER,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
```

Callback Data 只包含短 Token：

```text
a:<token>
```

### 11.7 telegram_notification_outbox

```sql
CREATE TABLE telegram_notification_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_telegram_outbox_pending
ON telegram_notification_outbox(status, next_attempt_at);
```

### 11.8 telegram_task_subscriptions

```sql
CREATE TABLE telegram_task_subscriptions (
  task_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  notify_started INTEGER NOT NULL DEFAULT 0,
  notify_success INTEGER NOT NULL DEFAULT 1,
  notify_failure INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, chat_id, thread_id)
) STRICT;
```

### 11.9 telegram_runtime_leases

```sql
CREATE TABLE telegram_runtime_leases (
  lease_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

---

## 12. Telegram Context 与消息路由

### 12.1 Context Key

```ts
interface TelegramConversationKey {
  chatId: number;
  threadId: number;
}
```

字符串 Key：

```text
{chatId}::{threadId}
```

### 12.2 Update 流程

```text
Telegram Update
      │
      ▼
Resolve Chat / Topic
      │
      ▼
Check User Allowlist
      │
      ▼
Check Chat Permission
      │
      ▼
Rate Limit
      │
      ▼
Resolve Command / Callback / Attachment / Prompt
      │
      ▼
Load Conversation
      │
      ▼
Execute Application Service
```

### 12.3 状态隔离

以下状态必须按 Chat / Topic 隔离：

- 当前 Session；
- 工作区；
- 上一次 Prompt；
- Pending Extension Dialog；
- Pending Session Picker；
- Pending Model Picker；
- Pending Task Action；
- Busy 状态；
- Locale；
- Tool Verbosity。

### 12.4 重启恢复

进程重启后：

- Conversation 与 Session 映射从 SQLite 恢复；
- Pending Inline Picker 失效；
- Pending Callback 返回“操作已过期，请重新打开菜单”；
- 状态为 `running` 的 Conversation 改为 `idle` 或 `detached`；
- 不自动重发进程重启前的 Prompt；
- 已经写入 Session 的消息仍可从 Web 和 Telegram 查看。

---

## 13. Session 与 Workspace 设计

### 13.1 新 Session

流程：

1. 获取 Conversation 默认 Workspace；
2. 校验 Workspace 存在；
3. 校验 Workspace 在 Pi Hub Allowed Roots 中；
4. 校验 Project Trust；
5. 调用 `startRpcSession()` 创建新 Session；
6. 设置 Session 名称；
7. 保存真实 Session ID 和路径；
8. 返回 Session 信息。

建议名称：

```text
[TG] jarome · 2026-08-07 12:30
```

Forum Topic：

```text
[TG] Backend Topic · 2026-08-07
```

### 13.2 Session 切换

`/sessions`：

- 使用 Pi Hub `listAllSessions()`；
- 按 Project / Worktree 分组；
- 使用分页 Inline Keyboard；
- Callback 保存短 Token；
- 点击后通过 `resolveSessionPath()` 打开；
- Session 正忙时禁止切换。

V1 不接受 Telegram 用户直接输入任意绝对路径。

允许：

```text
/sessions <session-id-or-prefix>
```

不建议：

```text
/sessions /任意/文件路径/session.jsonl
```

### 13.3 工作区选择

`/new`：

- 一个可用 Workspace：直接创建；
- 多个 Workspace：显示选择器；
- Workspace 来源只包括：
  - 已有 Session 的 cwd；
  - 已允许的 Project Root；
  - Pi Hub 显式添加的 Allowed Root；
- 不允许 Telegram 任意浏览整个服务器文件系统。

### 13.4 Project Trust

Telegram 不能在 P0 中批准一个不可信项目。

遇到未授权项目时：

```text
该项目尚未在 Pi Hub 中信任。
请先在 Web UI 中确认项目权限。
```

### 13.5 Session 文件

Telegram 接入不修改 Pi Session JSONL 格式。

Session 文件仍保存在：

```text
~/.pi/agent/sessions/
```

Pi Hub SQLite 只保存 Session 引用和 Telegram 映射。

---

## 14. 命令设计

Telegram 命令名称必须使用英文小写和下划线，描述与响应默认中文。

### 14.1 P0 命令

| 命令 | 中文说明 |
|---|---|
| `/start` | 查看连接状态和当前 Session |
| `/help` | 查看使用帮助 |
| `/pair <code>` | 使用 Pi Hub 配对码绑定用户 |
| `/new` | 创建新的 Pi Session |
| `/session` | 查看当前 Session |
| `/sessions` | 浏览和切换历史 Session |
| `/abort` | 停止当前 Agent 执行 |
| `/retry` | 重新执行当前 Chat / Topic 的上一个 Prompt |
| `/tasks` | 查看定时任务 |
| `/task <id>` | 查看任务详情和最近执行记录 |
| `/run <id>` | 立即执行指定任务 |
| `/status` | 查看 Pi Hub、Scheduler 和 Telegram 状态 |
| `/lang` | 切换语言 |

### 14.2 P1 命令

| 命令 | 中文说明 |
|---|---|
| `/commands` | 浏览 Pi Prompt、Skill 和 Extension 命令 |
| `/model` | 查看和切换模型 |
| `/context` | 查看 Context 和 Session Stats |
| `/task_new` | 通过向导创建每日或一次性任务 |
| `/task_pause <id>` | 暂停任务 |
| `/task_resume <id>` | 恢复任务 |

### 14.3 P2 命令

| 命令 | 中文说明 |
|---|---|
| `/tree` | 查看 Session Tree |
| `/branch <id>` | 切换到指定分支位置 |
| `/label` | 管理 Session Entry 标签 |
| `/handback` | 将 Session 交还 Pi CLI |

### 14.4 命令菜单本地化

注册：

- 默认英文菜单；
- `language_code = zh` 的中文描述；
- Conversation 语言通过 `/lang` 保存；
- 命令名称保持不变。

### 14.5 Pi 命令桥接

P1 通过现有：

```text
get_commands
```

发现：

- Prompt Templates；
- Skills；
- Extension Commands。

`/commands` 使用分页选择器。

兼容 Telegram 原生命令名称的 Pi 命令可以在私聊中同步到命令菜单；Forum Topic 中因 Telegram 命令 Scope 不是 Topic 级，默认只保留 Pi Hub 固定命令，动态命令通过 `/commands` 使用。

---

## 15. Prompt 执行与流式回复

### 15.1 交互流程

```text
用户发送 Prompt
      │
      ▼
检查 Conversation Busy
      │
      ▼
Acquire Session Run Lock
      │
      ▼
发送 typing 状态
      │
      ▼
启动 Prompt
      │
      ├── 文本 Delta → 编辑 Telegram 消息
      ├── Tool Event → 展示工具状态
      ├── UI Request → Telegram Dialog
      └── Error → 错误提示
      │
      ▼
prompt_done
      │
      ▼
发送最终结果并释放锁
```

### 15.2 消息编辑策略

参考值：

```text
Typing Interval：4.5 秒
Message Edit Debounce：1.5 秒
```

规则：

- 第一个文本 Delta 创建消息；
- 后续 Delta 节流编辑同一条消息；
- 执行中提供“停止”按钮；
- 最终结果移除“停止”按钮；
- 最终内容超长时拆为多条消息；
- 不对每个 Token 调用 Telegram API。

### 15.3 Telegram 长度限制

内部安全分片建议：

```text
每段不超过 3,800 字符
```

避免 Markdown / HTML 转换后超过 Telegram 限制。

### 15.4 消息格式

优先：

```text
Telegram HTML
```

必须实现：

- HTML 转义；
- Code Block；
- Inline Code；
- Bold / Italic；
- Link 协议白名单；
- 解析失败时自动回退 Plain Text；
- 大段 Markdown 安全分片。

### 15.5 Tool Verbosity

支持：

| 模式 | 行为 |
|---|---|
| `all` | 展示工具开始、更新和结束 |
| `summary` | 最终回复附加工具调用统计 |
| `errors-only` | 只展示失败的工具 |
| `none` | 不展示工具状态 |

默认：

```text
summary
```

### 15.6 Busy 提示

示例：

```text
当前 Session 正在由 Telegram 执行。

任务：检查项目测试
开始时间：12:30

可使用 /abort 停止。
```

或者：

```text
当前 Session 正在由 Web UI 使用，请完成后再试。
```

---

## 16. 图片、文件与语音

### 16.1 图片输入

P1 支持：

- Telegram Photo；
- MIME 为 `image/*` 的 Document；
- Caption 作为 Prompt；
- 无 Caption 时使用默认 Prompt：分析该图片。

流程：

1. 调用 Telegram File API；
2. 检查大小；
3. 下载到 OS 临时目录；
4. 校验 MIME；
5. 转为 Pi Image Input；
6. 执行 Prompt；
7. `finally` 删除临时文件。

默认最大大小：

```text
25 MB
```

### 16.2 非图片文件

V1 不自动把任意文件放入工作区。

后续支持时必须：

- 明确上传目标；
- 进行文件名清理；
- 防止路径穿越；
- 限制扩展名和大小；
- 需要用户确认写入位置。

### 16.3 语音转写

P2 定义：

```ts
interface VoiceTranscriber {
  transcribe(filePath: string): Promise<{
    text: string;
    backend: string;
    durationMs: number;
  }>;
}
```

可选实现：

- Local Parakeet；
- Sherpa-ONNX；
- OpenAI Whisper；
- 用户自定义 HTTP Transcription Provider。

原则：

- 核心 Pi Hub 安装不强制安装 1GB 级模型；
- Ubuntu ARM 不假设本地原生模块一定可用；
- Cloud Voice 必须显式启用并提示隐私风险；
- 原生模型实例必须串行访问；
- 音频解码依赖 `ffmpeg` 时要做清晰检测；
- 临时音频转写后立即删除。

---

## 17. Extension Dialog

### 17.1 支持范围

P1 支持：

| Pi Extension UI | Telegram 实现 |
|---|---|
| `select` | Inline Keyboard |
| `confirm` | Yes / No 按钮 |
| `input` | 用户下一条文本消息 |
| `notify` | 普通 Telegram 消息 |

暂不支持：

| Pi Extension UI | V1 行为 |
|---|---|
| `editor` | 返回不支持错误 |
| `custom` | 返回不支持错误 |
| `setWidget` | 忽略或记录状态 |
| `setHeader` / `setFooter` | 忽略 |
| Theme | Plain Text Shim |

### 17.2 Dialog 生命周期

- 每个 Conversation 同时最多一个 Pending Dialog；
- 默认超时 60 秒；
- `/abort` 同时取消 Pending Dialog；
- Dialog Token 与 Chat、Topic 和用户绑定；
- 其他用户点击按钮返回无权限；
- 超时后原消息更新为“操作已过期”；
- 进程重启后所有 Pending Dialog 失效。

---

## 18. 定时任务集成

### 18.1 Notifier 接口

实现 Scheduled Execution 设计中的：

```ts
export class TelegramTaskNotifier implements TaskNotifier {
  onRunStarted(event: TaskRunNotification): Promise<void>;
  onRunSucceeded(event: TaskRunNotification): Promise<void>;
  onRunFailed(event: TaskRunNotification): Promise<void>;
}
```

Notifier 不直接发送网络请求，而是写入 Notification Outbox。

### 18.2 幂等键

```text
task-run:{runId}:started
task-run:{runId}:success
task-run:{runId}:failed
```

数据库唯一约束防止重复通知。

### 18.3 Outbox 重试

建议：

- 最大 5 次；
- 指数退避；
- Telegram 429 尊重 Retry-After；
- Bot Token 无效时停止重试并标记配置错误；
- 发送失败只记录 Warning，不修改 Task Run 状态。

### 18.4 成功通知

示例：

```text
✅ 任务执行成功

任务：每日代码巡检
计划时间：2026-08-07 08:00
开始时间：2026-08-07 08:00:02
耗时：12 分 28 秒

结果：
发现 2 个测试失败，未自动修改代码。
```

按钮：

```text
[查看详情] [打开 Session]
[再次执行]
```

没有配置 Pi Hub Public URL 时，“打开 Session”改为 Bot Callback 或只展示 Session ID。

### 18.5 失败通知

```text
❌ 任务执行失败

任务：服务器巡检
错误：TASK_TIMEOUT
耗时：2 小时

Session：abc123
```

按钮：

```text
[查看错误] [重新执行]
```

### 18.6 Telegram 任务命令

`/tasks`：

- 显示 Active、Paused 和一次性待执行任务；
- 默认分页；
- 展示下一次执行时间和时区；
- 按钮使用短期 Action Token。

`/run <id>`：

- 调用 `TaskService.runNow()`；
- 不直接调用 Pi Agent；
- 不改变周期任务的 `next_run_at`；
- 要求 Operator 或 Owner；
- 高风险任务可要求二次确认。

P1 `/task_new`：

```text
名称
  ↓
Workspace
  ↓
Prompt
  ↓
每日 / 一次性
  ↓
时间与时区
  ↓
通知设置
  ↓
确认创建
```

---

## 19. Handoff 与 Handback

Pi Hub 不照搬 TelePi 的“重启 Bot 进程并注入 `PI_SESSION_PATH`”方案。

### 19.1 Web 与 Telegram

Web 和 Telegram 本身共享 Pi Hub Runtime，因此两者之间不需要 handoff。

只需要：

- Session Run Lock；
- Run Owner；
- 同一个 Session 的实时状态；
- 客户端切换后继续查看 Session。

### 19.2 CLI → Pi Hub

P2 提供 Pi Extension：

```text
~/.pi/agent/extensions/pi-hub-handoff.ts
```

命令：

```text
/handoff
```

流程：

1. 获取当前 Session 文件；
2. 调用 Pi Hub 本地控制接口；
3. 指定目标 Telegram Conversation，或使用默认 Owner 私聊；
4. Pi Hub 验证 Session 文件和 Workspace；
5. Pi Hub 关闭旧 Wrapper 并重新打开该 Session；
6. Telegram 收到“Session 已接管”通知；
7. Pi Hub 返回 ACK；
8. CLI 只在 ACK 成功后退出。

接口优先采用：

- Unix Domain Socket；或
- 仅绑定 `127.0.0.1` 的认证接口。

不得暴露未认证的公网 handoff API。

### 19.3 Telegram → CLI

`/handback`：

1. 检查 Session 不在运行；
2. 释放 Pi Hub AgentSession Wrapper；
3. Conversation 标记为 `detached`；
4. 返回：

```bash
cd '/path/to/project' && pi --session '/path/to/session.jsonl'
```

5. 记录 Session Ownership 为 CLI；
6. 在收到下一次 `/handoff` 或用户明确“重新接管”前，Pi Hub 不允许该 Session 被再次写入。

### 19.4 不重启 Pi Hub

Handoff 只切换 Session 所有权，不重启：

- Pi Hub；
- Telegram Runtime；
- Scheduler；
- systemd 服务。

---

## 20. Web 管理页面

路径：

```text
/settings/integrations/telegram
```

### 20.1 状态卡

显示：

```text
Telegram Bot

状态：运行中
Bot：@your_bot
模式：Long Polling
Leader：Yes
最后收到消息：12:31:22
已授权用户：1
活动 Conversation：2
```

状态：

| 状态 | 说明 |
|---|---|
| `disabled` | 未启用 |
| `starting` | 初始化中 |
| `running` | 正常轮询 |
| `standby` | 当前进程不是 Leader |
| `stopping` | 正在停止 |
| `error` | Token、网络或冲突错误 |

### 20.2 配置向导

```text
1. 输入 Bot Token
2. 验证 Bot
3. 保存配置
4. 生成配对码
5. 在 Telegram 发送 /pair
6. 发送测试消息
```

### 20.3 用户管理

展示：

- Telegram User ID；
- Username；
- Display Name；
- Role；
- 最后访问时间；
- Enabled；
- Revoke。

### 20.4 Conversation 管理

展示：

- Chat / Topic；
- 当前 Session；
- Workspace；
- 状态；
- 最近活动时间；
- 清除 Session 绑定；
- 禁用该 Conversation。

### 20.5 通知设置

支持：

- 默认通知 Chat；
- 任务开始通知；
- 任务成功通知；
- 任务失败通知；
- Scheduler 异常通知；
- Pi Hub Runtime 异常通知；
- 测试通知。

### 20.6 TelePi 导入

若检测到：

```text
~/.config/telepi/config.env
```

显示：

```text
发现 TelePi 配置

可导入：
- Bot Token
- Allowed User IDs
- Default Workspace
- Tool Verbosity
```

不自动导入：

- OpenAI API Key；
- Voice 模型路径；
- PI_SESSION_PATH；
- launchd / systemd 服务设置。

---

## 21. API 设计

### 21.1 状态

```http
GET /api/integrations/telegram/status
```

```json
{
  "configured": true,
  "enabled": true,
  "tokenSource": "environment",
  "runtime": {
    "status": "running",
    "leader": true,
    "botId": 123456,
    "botUsername": "pi_hub_bot",
    "startedAt": "2026-08-07T04:00:00.000Z",
    "lastUpdateAt": "2026-08-07T04:31:22.000Z",
    "error": null
  },
  "userCount": 1,
  "conversationCount": 2
}
```

不得返回 Token。

### 21.2 配置

```http
GET /api/integrations/telegram/config
PUT /api/integrations/telegram/config
```

### 21.3 Token

```http
PUT /api/integrations/telegram/token
DELETE /api/integrations/telegram/token
```

Token 为只写字段。

环境变量管理时返回：

```http
409 TELEGRAM_TOKEN_MANAGED_BY_ENV
```

### 21.4 测试

```http
POST /api/integrations/telegram/test
```

支持：

- 只验证 Token；
- 向指定已授权 Chat 发送测试消息。

### 21.5 配对码

```http
POST /api/integrations/telegram/pairing-codes
```

```json
{
  "role": "owner",
  "expiresInSeconds": 600
}
```

返回一次性明文 Code，后续不能再次查询。

### 21.6 用户

```http
GET /api/integrations/telegram/users
PATCH /api/integrations/telegram/users/{id}
DELETE /api/integrations/telegram/users/{id}
```

### 21.7 Conversation

```http
GET /api/integrations/telegram/conversations
DELETE /api/integrations/telegram/conversations/{id}
```

删除 Conversation 映射不删除 Pi Session 文件。

### 21.8 TelePi 导入

```http
POST /api/integrations/telegram/import-telepi
```

导入前必须：

- 显示将导入的字段；
- 用户确认；
- 检查旧 TelePi 是否仍在运行；
- 不覆盖环境变量 Token。

---

## 22. 从 TelePi 迁移

### 22.1 使用同一个 Bot Token

同一个 Token 不能同时由两个 Long Polling 进程使用。

迁移前停止 TelePi。

Linux installed mode：

```bash
systemctl --user disable --now telepi.service
```

如果 TelePi 是手动启动：

- 停止对应 `telepi start` 进程；
- 确认没有其他主机使用同一个 Token。

Pi Hub 不应自动 Kill 未识别的外部进程。

### 22.2 导入配置

可从：

```text
~/.config/telepi/config.env
```

导入：

- `TELEGRAM_BOT_TOKEN`；
- `TELEGRAM_ALLOWED_USER_IDS`；
- `TELEPI_WORKSPACE`；
- `TOOL_VERBOSITY`。

### 22.3 Session 数据

无需迁移 Session 内容。

TelePi 和 Pi Hub 都使用：

```text
~/.pi/agent/sessions/
```

Pi Hub 重新扫描 Session 后即可显示原历史。

### 22.4 Handoff Extension

旧文件：

```text
~/.pi/agent/extensions/telepi-handoff.ts
```

在 Pi Hub Handoff 功能完成前：

- 可以保留但不要执行 `/handoff`；或
- 暂时禁用该 Extension。

P2 完成后替换为：

```text
pi-hub-handoff.ts
```

旧 Extension 会尝试启动或重启 TelePi，不适用于 Pi Hub 原生 Telegram Runtime。

### 22.5 回滚

导入不会删除 TelePi 配置文件。

回滚步骤：

1. 在 Pi Hub 禁用 Telegram；
2. 确认 Pi Hub Long Polling 已停止；
3. 重新启动 TelePi 服务；
4. 使用原 `~/.config/telepi/config.env`。

---

## 23. 安全设计

### 23.1 Bot 权限风险

Telegram Bot 实际获得的是：

```text
远程控制 Coding Agent 的能力
```

因此必须按高权限远程入口处理。

### 23.2 强制规则

- 默认仅监听私聊；
- 用户 ID 必须配对；
- 群组必须双重授权 User + Chat；
- Bot Token 不进入数据库、API 返回和普通日志；
- Token 日志统一脱敏；
- Callback 使用短期、单次 Token；
- 不把文件路径直接放入 Callback Data；
- 不允许 Telegram 任意选择服务器路径；
- Workspace 必须在 Allowed Roots；
- Project Trust 不能从 Telegram 绕过；
- 下载附件限制大小和 MIME；
- 临时文件必须删除；
- Telegram HTML 需要 URL 协议白名单；
- Cloud Voice 必须明确告知会上传音频；
- Agent Run 必须有 Session Lock；
- CLI handoff 必须通过本地认证接口；
- Telegram API 错误不得输出 Token；
- 不允许 Agent 自行修改或重启 Telegram Runtime 服务。

### 23.3 高风险操作确认

以下操作需要确认：

- 删除任务；
- 暂停关键任务；
- 强制 Abort 他人 Run；
- Handback 到 CLI；
- 在群组中启用 Agent；
- 重新接管标记为 CLI 控制的 Session。

### 23.4 Bot Token 泄露处理

Web UI 提供：

- 禁用 Telegram；
- 清除本地 Token；
- 显示前往 BotFather 重新生成 Token 的说明；
- Token 更新后重新验证并重启 Runtime。

---

## 24. 错误码

| 错误码 | 含义 |
|---|---|
| `TELEGRAM_DISABLED` | Telegram 集成未启用 |
| `TELEGRAM_TOKEN_MISSING` | 未配置 Bot Token |
| `TELEGRAM_TOKEN_INVALID` | Bot Token 无效 |
| `TELEGRAM_TOKEN_IN_USE` | Token 正被其他轮询进程使用 |
| `TELEGRAM_TOKEN_MANAGED_BY_ENV` | Token 由环境变量管理 |
| `TELEGRAM_USER_NOT_ALLOWED` | 用户未授权 |
| `TELEGRAM_CHAT_NOT_ALLOWED` | Chat 未授权 |
| `TELEGRAM_PRIVATE_ONLY` | 当前仅允许私聊 |
| `TELEGRAM_PAIRING_INVALID` | 配对码无效 |
| `TELEGRAM_PAIRING_EXPIRED` | 配对码已过期 |
| `TELEGRAM_RATE_LIMITED` | 请求触发限流 |
| `TELEGRAM_CALLBACK_EXPIRED` | Callback 已过期 |
| `TELEGRAM_SEND_FAILED` | 消息发送失败 |
| `TELEGRAM_FILE_TOO_LARGE` | 附件过大 |
| `TELEGRAM_UNSUPPORTED_ATTACHMENT` | 附件类型不支持 |
| `TELEGRAM_TRANSCRIPTION_UNAVAILABLE` | 没有语音转写后端 |
| `TELEGRAM_TRANSCRIPTION_FAILED` | 语音转写失败 |
| `TELEGRAM_DIALOG_TIMEOUT` | Extension Dialog 超时 |
| `TELEGRAM_CONVERSATION_BUSY` | 当前 Conversation 正忙 |
| `AGENT_SESSION_BUSY` | Session 正被其他入口执行 |
| `AGENT_RUN_OWNED_BY_OTHER_CLIENT` | Run 属于其他客户端 |
| `TELEGRAM_SESSION_NOT_FOUND` | Session 不存在 |
| `TELEGRAM_WORKSPACE_NOT_ALLOWED` | Workspace 不在允许范围 |
| `TELEGRAM_PROJECT_NOT_TRUSTED` | 项目未信任 |
| `TELEGRAM_RUNTIME_NOT_LEADER` | 当前进程不是 Bot Leader |
| `TELEGRAM_IMPORT_CONFLICT` | TelePi 配置导入冲突 |

---

## 25. 日志与可观测性

日志前缀：

```text
[pi-hub:telegram]
[pi-hub:telegram:polling]
[pi-hub:telegram:auth]
[pi-hub:telegram:prompt]
[pi-hub:telegram:outbox]
[pi-hub:telegram:voice]
[pi-hub:agent-execution]
```

关键日志：

- Runtime 启动和停止；
- Lease 获取和丢失；
- Bot 身份验证；
- 409 Polling 冲突；
- 用户配对成功和失败；
- 用户未授权访问；
- Conversation 与 Session 切换；
- Run Owner 获取和释放；
- Prompt 开始、结束和错误；
- Abort；
- Outbox 发送和重试；
- Telegram 429；
- 附件拒绝；
- Voice Backend 状态；
- TelePi 导入结果。

不得记录：

- Bot Token；
- Authorization Header；
- 完整语音文件；
- Base64 图片；
- OAuth 凭据；
- 模型 API Key。

Runtime Status 应提供：

```text
status
leader
bot username
started at
last update at
last successful send at
pending outbox count
active conversations
last error code
last error time
```

---

## 26. 测试设计

### 26.1 单元测试

#### 配置与 Secret

- 环境变量优先级；
- Secret 文件权限；
- API 不返回 Token；
- Token 脱敏；
- 自定义 API Root 校验。

#### 配对与权限

- 配对码生成和 Hash；
- 配对码过期；
- 单次使用；
- 用户角色；
- 私聊限制；
- 群组双重授权；
- 限流。

#### Conversation

- Root Chat Key；
- Topic Key；
- 不同 Topic 状态隔离；
- Session 映射持久化；
- Retry Memory；
- 重启恢复。

#### AgentExecutionCoordinator

- 同一 Session 只允许一个 Run；
- Web 与 Telegram 冲突；
- Scheduler 与 Telegram 冲突；
- `prompt_done` 正常释放；
- `prompt_error`；
- 第一次 `agent_end` 不提前结束；
- Abort 权限；
- Extension UI Owner 校验。

#### 消息渲染

- HTML 转义；
- Markdown 分片；
- Telegram Parse Error 回退；
- 超长 Code Block；
- 危险 URL；
- Tool Verbosity。

#### Callback

- Token 过期；
- Token 单次消费；
- 用户不匹配；
- Chat / Topic 不匹配；
- Callback Data 长度。

#### Outbox

- Dedupe Key；
- 发送成功；
- 429 Retry-After；
- 最大重试；
- 通知失败不改变 Task Run。

### 26.2 集成测试

使用 Fake Telegram API 和 Fake Agent Executor：

- 配置 Bot 并启动 Runtime；
- 未授权用户被拒绝；
- `/pair` 成功；
- 文本 Prompt 创建 Session；
- 第二个 Prompt Busy；
- 文本流式编辑；
- `/abort`；
- `/sessions` 切换；
- Topic 独立 Session；
- Web 与 Telegram 查看同一 Session；
- Task 成功通知；
- `/run` 创建 Task Run；
- 409 Token 冲突进入 Error 状态；
- Runtime 重启恢复 Conversation；
- TelePi 配置导入；
- 图片临时文件删除；
- Extension select / confirm / input。

### 26.3 真实环境验证

- OCI Ubuntu ARM；
- Node.js `>=22.19`；
- Pi Hub systemd 用户服务；
- 浏览器关闭后 Telegram 仍可执行；
- SSH 通道断开后 Telegram 仍可执行；
- 服务重启后 Bot 恢复；
- TelePi 停止后相同 Token 可被 Pi Hub 使用；
- 同一个 Session 可在 Telegram 执行后回到 Web 查看；
- Scheduler 任务结果正常发送到 Telegram。

---

## 27. 验收标准

P0 完成必须满足：

1. 用户可以在 Pi Hub Web UI 配置并验证 Bot Token；
2. Token 不会出现在读取 API、日志或页面源码中；
3. 用户可以生成配对码并在 Telegram 完成绑定；
4. 未授权 Telegram 用户无法操作 Agent；
5. Bot 命令描述和默认响应为中文；
6. 用户可以发送文本 Prompt；
7. Telegram Prompt 创建的 Session 能在 Web UI 中看到；
8. Web UI 中已有 Session 可以从 Telegram 继续；
9. 每个 Chat / Topic 有独立的 Session 映射；
10. 浏览器关闭后 Telegram 仍能执行；
11. Pi Hub 重启后 Conversation 映射仍存在；
12. `/new`、`/session`、`/sessions`、`/abort`、`/retry` 可用；
13. `/tasks` 和 `/run` 可用；
14. 定时任务成功和失败可以通知 Telegram；
15. 通知失败不会改变任务状态；
16. 同一 Session 不能被 Web、Telegram 和 Scheduler 并发写入；
17. Bot Token 被 TelePi 占用时，Web UI 显示明确的 409 冲突提示；
18. 不修改 Pi Session JSONL 格式；
19. 不使用 `~/.pi-web/`；
20. 现有 pi-web Chat、Session、Skills、Plugins 和模型配置不受影响。

---

## 28. 实施阶段

### 阶段一：基础运行时

- Telegram 配置与 Secret Store；
- SQLite Migration；
- Telegram Runtime；
- Long Polling；
- Runtime Lease；
- Status API；
- Web 配置页；
- Bot Token 验证；
- 409 冲突处理。

### 阶段二：配对与通知

- 配对码；
- 用户白名单；
- 角色；
- 中文菜单；
- Telegram Transport；
- Notification Outbox；
- TelegramTaskNotifier；
- Task 成功和失败通知；
- `/tasks`、`/task`、`/run`。

### 阶段三：文本 Agent 客户端

- AgentExecutionCoordinator；
- Conversation Store；
- 文本 Prompt；
- Session 创建和切换；
- 流式回复；
- Tool Summary；
- `/abort`；
- `/retry`；
- Web / Telegram Run Owner 协调。

### 阶段四：增强命令

- `/commands`；
- Pi Prompt / Skill / Extension Bridge；
- `/model`；
- `/context`；
- 图片输入；
- Extension Dialog；
- Telegram Task 创建向导；
- 群组 / Topic 授权。

### 阶段五：完整移动端能力

- VoiceTranscriber；
- Session Tree / Branch / Label；
- Pi Hub Handoff Extension；
- `/handback`；
- CLI Session Ownership；
- Webhook；
- 多 Bot。

---

## 29. 主要风险与处理

### 29.1 同一 Session 多客户端竞争

风险最高。

处理：

- 统一 AgentExecutionCoordinator；
- Session Run Lock；
- Run Owner；
- Extension Dialog Owner；
- 单进程部署。

### 29.2 Telegram API 限流

处理：

- 文本编辑 Debounce；
- Tool Summary 默认；
- Grammy Auto Retry；
- 尊重 Retry-After；
- Notification Outbox。

### 29.3 Token 被旧 TelePi 占用

处理：

- 明确识别 409；
- Web UI 提示迁移步骤；
- 不自动 Kill 外部服务；
- 提供 TelePi 配置导入。

### 29.4 Pi SDK 升级

处理：

- Telegram 不直接依赖 TelePi PiSession 实现；
- 统一通过 Pi Hub AgentExecutionCoordinator；
- Event Adapter 单独封装；
- SDK 变更只影响执行适配层。

### 29.5 Voice 原生依赖

处理：

- P2；
- Provider Interface；
- Optional Dependency；
- Ubuntu ARM 默认不安装；
- 支持 Cloud 或自定义服务。

### 29.6 上游 pi-web 冲突

处理：

- 新代码集中在 `modules/telegram/` 和 `modules/agent-execution/`；
- 上游文件只做入口级修改；
- 不修改 Chat Component 业务；
- 不改 Session JSONL；
- 新 API 独立命名空间。

---

## 30. TelePi 源码引用与许可证

TelePi 使用 MIT License。

若 Pi Hub 直接移植 TelePi 的以下具体实现代码：

- Telegram Markdown / HTML Renderer；
- Message Chunking；
- Telegram Transport Retry；
- Extension Dialog Manager；
- Voice Backend；
- Handoff Extension；

必须：

1. 保留原始版权和许可证声明；
2. 在 `THIRD_PARTY_NOTICES.md` 中记录来源；
3. 标注参考的 TelePi Commit；
4. 不删除原作者信息；
5. 尽量通过重新实现接口和测试保持模块独立。

参考：

- https://github.com/benedict2310/TelePi
- https://github.com/benedict2310/TelePi/blob/main/README.md
- https://github.com/benedict2310/TelePi/blob/main/docs/architecture.md

---

## 31. 最终结论

基于 TelePi 的功能设计 Pi Hub Telegram 接入是高度可行的，但正确方向不是在 Pi Hub 中再运行一套 TelePi Agent Runtime。

推荐方案是：

```text
TelePi 产品能力与交互经验
              │
              ▼
Pi Hub 原生 Telegram 模块
              │
              ▼
统一 AgentExecutionCoordinator
              │
              ▼
现有 Pi Hub AgentSession Runtime
```

该方案能够同时实现：

- Telegram 移动端 Agent 控制；
- Web 与 Telegram 共享 Session；
- 定时任务通知和远程执行；
- 用户配对和权限控制；
- 中文 Bot 体验；
- 后续图片、语音、命令和 handoff；
- 对上游 pi-web 的低侵入维护。

第一阶段应优先完成“Bot 配置、用户配对、任务通知、任务控制”，随后接入文本 Agent 会话。这样可以最快获得稳定价值，同时为完整 TelePi 类移动端体验建立正确的共享执行基础。
