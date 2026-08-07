# Pi Hub 定时执行功能 UI 设计

> 状态：Draft  
> 版本：V1  
> 日期：2026-08-07

## 1. 设计目标

定时执行 UI 的目标不是提供一个复杂的 Cron 管理器，而是提供一个面向个人 Agent 使用场景的任务控制中心。

核心体验：

- 我可以告诉 Agent 未来什么时候执行什么事情；
- 我可以知道它什么时候执行过；
- 我可以查看执行结果；
- 我可以随时暂停、恢复或者手动触发。

设计原则：

> 让创建 Agent 自动任务像创建日历事件一样简单。

---

# 2. 页面结构

新增一级功能入口：

```text
Pi Hub

├── Chat
├── Sessions
├── Tasks        新增
│   ├── Task List
│   ├── Task Detail
│   └── Task Runs
├── Skills
└── Settings
```

新增页面：

```text
/tasks
/tasks/new
/tasks/[id]
/tasks/[id]/runs
```

---

# 3. Task Dashboard（任务首页）

路径：

```text
/tasks
```

## 页面目标

快速了解：

- 当前有哪些自动任务；
- Scheduler 是否正常；
- 最近执行情况。

---

## 页面布局

```text
┌──────────────────────────────────────┐
│ Tasks                     + New Task │
├──────────────────────────────────────┤
│                                      │
│ Scheduler                            │
│                                      │
│ ● Running                            │
│ Next tick: 10 seconds                │
│ Running Tasks: 1                     │
│ Today Success: 5                     │
│ Today Failed: 0                      │
│                                      │
├──────────────────────────────────────┤
│ Task List                            │
│                                      │
│ Daily Code Review                    │
│ Every day 08:00                      │
│ Asia/Singapore                       │
│ Next: Today 08:00                    │
│ [Run] [Pause] [Edit]                 │
│                                      │
│ Server Check                         │
│ Once                                 │
│ Tomorrow 10:00                       │
│ [Cancel] [Edit]                      │
│                                      │
└──────────────────────────────────────┘
```

---

# 4. Scheduler 状态卡片

位置：Tasks 页面顶部。

## 展示字段

```text
Scheduler

Status: Running
Leader: Yes

Running:
1
Queued:
2

Last Tick:
2026-08-07 10:30:10
```

状态：

|状态|显示|
|-|-|
|正常|绿色 Running|
|非 Leader|黄色 Standby|
|数据库异常|红色 Error|
|未启动|灰色 Offline|

点击状态卡：

进入 Scheduler Debug 页面。

---

# 5. Task List 页面

## 5.1 列表字段

|字段|说明|
|-|-|
|名称|任务名称|
|类型|每日/一次性|
|Schedule|执行规则|
|Next Run|下一次执行时间|
|Last Result|最近结果|
|Status|启用状态|
|Action|操作|

---

## 5.2 状态设计

### Active

```text
● Active
Next Run:
Tomorrow 08:00
```

### Paused

```text
Ⅱ Paused
Task disabled
```

### Completed

一次性任务：

```text
✓ Completed
Executed:
2026-08-08 10:00
```

---

## 5.3 操作菜单

```text
⋮

Run Now
Pause
Edit
Duplicate
View Runs
Delete
```

删除需要二次确认：

```text
Delete task?

Task history will be kept.

[Cancel]
[Delete]
```

---

# 6. 创建任务页面

路径：

```text
/tasks/new
```

采用向导式设计。

---

## Step 1 基础信息

```text
Create Task

Name
[ Daily Code Review          ]

Description
[ optional                 ]

Working Directory
[/home/user/project        ]

Next
```

---

## Step 2 Prompt

```text
Agent Instruction

┌──────────────────────────┐
│ Check git changes        │
│ Run tests                │
│ Generate report          │
└──────────────────────────┘

Variables:

{{date}}
{{workspace}}
```

V1 不提供复杂变量系统，只预留扩展。

---

## Step 3 Schedule

### 选择类型

```text
( ) Every Day
( ) One Time
```

---

### Every Day

```text
Time
[08:00]

Timezone
[Asia/Singapore ▼]

Preview:

Next execution:
2026-08-08 08:00
UTC:
2026-08-08 00:00
```

---

### One Time

```text
Date
[2026-08-08]

Time
[10:00]

Timezone
[Asia/Singapore]

Preview:

Execute at:
Tomorrow 10:00
```

---

## Step 4 Agent 配置

```text
Model

[ Default ▼ ]

Thinking

[ Default ▼ ]

Tools

[x] Read
[x] Bash
[x] Edit
[x] Write
```

默认隐藏高级配置。

---

## Step 5 Notification

```text
Notifications

Success
[✓] Notify me

Failure
[✓] Notify me

Channel

[x] Telegram
```

---

## 创建确认

最终确认页：

```text
Review Task

Name:
Daily Code Review

Schedule:
Every day 08:00
Asia/Singapore

Workspace:
/home/user/project

Next execution:
Tomorrow 08:00

[Back]
[Create Task]
```

---

# 7. Task Detail 页面

路径：

```text
/tasks/[id]
```

布局：

```text
┌───────────────────────────────┐
│ Daily Code Review              │
│ ● Active                      │
│                               │
│ Schedule                      │
│ Every day 08:00               │
│ Asia/Singapore                │
│                               │
│ Next Run                      │
│ Tomorrow 08:00                │
│                               │
│ Prompt                        │
│ Check code...                 │
│                               │
│ Agent                         │
│ Claude Sonnet                 │
│                               │
│ [Run Now] [Pause] [Edit]      │
└───────────────────────────────┘
```

---

# 8. Task Run History

路径：

```text
/tasks/[id]/runs
```

## 列表

```text
Execution History

2026-08-07 08:00
✓ Success
12 minutes

2026-08-06 08:00
✓ Success
8 minutes

2026-08-05 08:00
✕ Failed
Timeout
```

---

# 9. Run Detail 页面

点击一次执行进入。

展示：

```text
Run Detail

Status
✓ Success

Started
08:00:02

Finished
08:12:30

Duration
12m28s

Pi Session
abc123

Result

Found 3 changes...

[Open Session]
```

---

# 10. Agent Session 联动

定时任务执行后生成普通 Pi Session。

UI 不创建特殊 Session 页面。

复用已有 Session 页面。

入口：

```text
Task Run
    |
    └── Open Session
            |
            ▼
       Existing Chat View
```

这样保持和 pi-web 原有 Session 体系一致。

---

# 11. Mobile 适配

移动端优先展示：

```text
Task Card

Daily Code Review

08:00 Daily

Next:
Tomorrow

[Run]
```

详细配置采用页面滚动，不使用复杂弹窗。

---

# 12. 空状态设计

首次进入：

```text
No scheduled tasks yet.

Create your first Agent automation.

[Create Task]
```

---

# 13. 错误状态

## Scheduler Offline

```text
Scheduler unavailable

The task engine is not running.

[View Logs]
```

## Task Failed

```text
Task failed

Reason:
Agent timeout

[View Run]
[Retry]
```

---

# 14. V1 页面范围

实现优先级：

## P0

- Task List
- Create Task
- Edit Task
- Pause / Resume
- Run Now
- Run History
- Open Session

## P1

- Scheduler Dashboard
- Duplicate Task
- Advanced Agent Config
- Telegram Settings

## P2

- Calendar View
- Task Templates
- Natural Language Schedule
- Multi-agent Selector

---

# 15. UI 设计原则总结

1. 不复制 Chat 页面能力。
2. Task 是 Agent 的未来计划，不是新的聊天入口。
3. 执行结果回到 Session 体系。
4. 高级配置隐藏，默认简单。
5. 每个任务必须可以追踪完整生命周期。
6. 所有自动化行为必须可解释、可查看、可重新执行。
7. 新页面尽量作为独立模块，不侵入 pi-web 原有 Chat UI。
