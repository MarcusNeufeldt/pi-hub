# Pi Hub Telegram 官方开源 Bot API Server 接入补充设计

> 状态：Draft  
> 版本：V1  
> 日期：2026-08-07  
> 关联文档：`docs/pi-hub/telegram-integration-design.zh-CN.md`  
> 目标服务：Telegram 官方开源项目 `tdlib/telegram-bot-api`

## 1. 设计结论

Pi Hub 不为自建 Telegram Bot API Server 设计另一套 Telegram 协议，也不增加第三方兼容服务 Provider。

对于 Telegram 官方开源 Bot API Server，接入方式与 Telegram 官方云端 Bot API 完全一致，核心差异只有：

```text
https://api.telegram.org
```

替换为用户部署的服务地址，例如：

```text
https://tg-api.example.com
```

或者在同一内网中：

```text
http://telegram-bot-api:8081
```

Pi Hub 仍然使用：

- 相同的 Bot Token；
- 相同的 Telegram Bot API 方法；
- 相同的 Long Polling；
- 相同的 Update、Message、Callback Query 数据结构；
- 相同的 Telegram 用户 ID、Chat ID 和 Topic ID；
- 相同的命令、Session、定时任务和通知逻辑。

因此，V1 只需要为 Telegram 客户端增加一个可配置的：

```text
apiRoot
```

不需要设计：

- 第三方兼容协议；
- 自定义 Provider Adapter；
- MTProto 适配；
- 私有 Telegram Server 协议转换；
- 多套 Telegram 业务实现。

---

## 2. 支持范围

Pi Hub 支持两种 Telegram Bot API 服务地址。

### 2.1 Telegram 官方云端

默认配置：

```text
https://api.telegram.org
```

### 2.2 Telegram 官方开源 Bot API Server

用户自行部署：

```text
https://github.com/tdlib/telegram-bot-api
```

Pi Hub 通过用户配置的域名或内网地址访问，例如：

```text
https://tg-api.example.com
```

或者：

```text
http://127.0.0.1:8081
```

或者 Docker 网络地址：

```text
http://telegram-bot-api:8081
```

Bot API Server 本身需要的：

```text
api_id
api_hash
```

由用户在 Bot API Server 部署侧配置，Pi Hub 不保存、不展示，也不管理这两个参数。

---

## 3. 配置设计

### 3.1 配置结构

```json
{
  "telegram": {
    "enabled": true,
    "botApi": {
      "mode": "self-hosted",
      "apiRoot": "https://tg-api.example.com",
      "localMode": false
    }
  }
}
```

类型定义：

```ts
export interface TelegramBotApiConfig {
  mode: "official" | "self-hosted";
  apiRoot: string;
  localMode: boolean;
}
```

### 3.2 默认值

```ts
const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";
```

官方模式：

```json
{
  "mode": "official",
  "apiRoot": "https://api.telegram.org",
  "localMode": false
}
```

自建模式：

```json
{
  "mode": "self-hosted",
  "apiRoot": "https://tg-api.example.com",
  "localMode": false
}
```

### 3.3 apiRoot 规则

`apiRoot` 只填写服务根地址。

正确：

```text
https://tg-api.example.com
http://telegram-bot-api:8081
https://example.com/telegram-api
```

错误：

```text
https://tg-api.example.com/bot123456:token
https://tg-api.example.com/bot
https://tg-api.example.com/file
```

Bot Token 不能写入 `apiRoot`。

Pi Hub 保存前执行：

- 去除首尾空格；
- 去除末尾 `/`；
- 校验协议为 `http` 或 `https`；
- 禁止 URL 中包含用户名和密码；
- 检查 URL 中是否疑似包含 Bot Token；
- 修改后重新执行 Bot 连接测试。

---

## 4. Telegram 客户端初始化

Pi Hub 使用 Grammy 时，只需要把 `apiRoot` 传入客户端。

```ts
import { Bot } from "grammy";

const bot = new Bot(botToken, {
  client: {
    apiRoot: telegramConfig.botApi.apiRoot,
  },
});
```

Telegram 官方模式：

```ts
apiRoot = "https://api.telegram.org";
```

开源自建模式：

```ts
apiRoot = "https://tg-api.example.com";
```

后续调用无需区分：

```ts
await bot.api.getMe();
await bot.api.sendMessage(chatId, text);
await bot.api.editMessageText(chatId, messageId, text);
await bot.api.getFile(fileId);
await bot.start();
```

Long Polling、发送消息、Callback Query、命令菜单和文件信息查询全部使用同一个 `apiRoot`。

---

## 5. Telegram Transport 修改

Pi Hub 的 `TelegramTransport` 不得硬编码：

```text
https://api.telegram.org
```

建议统一持有：

```ts
export interface TelegramTransportOptions {
  token: string;
  apiRoot: string;
  localMode: boolean;
}
```

所有网络请求都从该配置生成。

### 5.1 普通 API 方法

由 Grammy 的：

```text
client.apiRoot
```

统一处理。

### 5.2 文件下载地址

非 Local Mode 下，文件下载地址根据相同的 `apiRoot` 构造：

```ts
function buildTelegramFileUrl(
  apiRoot: string,
  token: string,
  filePath: string,
): string {
  return `${apiRoot}/file/bot${token}/${filePath}`;
}
```

例如：

```text
https://tg-api.example.com/file/bot<token>/photos/file_1.jpg
```

不能继续使用 TelePi 当前类似的固定地址：

```text
https://api.telegram.org/file/bot<token>/...
```

否则文本消息会走自建服务器，但图片和语音仍会绕回 Telegram 官方云端。

---

## 6. Local Mode 特殊处理

Telegram 官方开源 Bot API Server 可以使用：

```text
--local
```

如果没有启用 `--local`，Pi Hub 的改动就只有 `apiRoot`，没有其他区别。

如果启用 `--local`，`getFile` 返回的 `file_path` 可能是 Bot API Server 上的绝对文件路径，例如：

```text
/var/lib/telegram-bot-api/123456789/documents/file_1.jpg
```

### 6.1 同机部署

如果 Pi Hub 与 Bot API Server 在同一台主机，并且 Pi Hub 可以读取该目录：

```text
localMode = true
```

Pi Hub 直接读取绝对路径。

读取前必须校验：

- 路径为绝对路径；
- 路径实际存在；
- 路径位于配置允许的 Bot API 数据目录内；
- 解析符号链接后仍位于允许目录；
- 文件大小未超过 Pi Hub 限制。

### 6.2 Docker 部署

如果 Bot API Server 和 Pi Hub 分别运行在容器中，应把 Bot API Server 文件目录挂载到两个容器中的相同路径。

示例：

```yaml
services:
  telegram-bot-api:
    volumes:
      - telegram-data:/var/lib/telegram-bot-api

  pi-hub:
    volumes:
      - telegram-data:/var/lib/telegram-bot-api:ro
```

这样 `getFile` 返回：

```text
/var/lib/telegram-bot-api/...
```

Pi Hub 可以直接按相同路径只读访问。

### 6.3 不共享文件目录

如果 Pi Hub 无法访问 Bot API Server 返回的本地绝对路径：

- 不启用 `localMode`；或
- 调整部署，让 Pi Hub 只读挂载相同目录。

V1 不设计第三方文件代理协议。

### 6.4 推荐默认值

```text
localMode = false
```

只有明确以 `--local` 启动 Bot API Server，并完成共享目录配置后才开启。

---

## 7. 数据库存储

在 `telegram_settings` 中增加：

```sql
ALTER TABLE telegram_settings
ADD COLUMN bot_api_mode TEXT NOT NULL DEFAULT 'official'
  CHECK (bot_api_mode IN ('official', 'self-hosted'));

ALTER TABLE telegram_settings
ADD COLUMN api_root TEXT NOT NULL DEFAULT 'https://api.telegram.org';

ALTER TABLE telegram_settings
ADD COLUMN local_mode INTEGER NOT NULL DEFAULT 0;

ALTER TABLE telegram_settings
ADD COLUMN local_file_root TEXT;
```

说明：

- `bot_api_mode` 主要用于 Web UI 展示；
- Runtime 实际以 `api_root` 为准；
- `local_file_root` 只在 `local_mode = 1` 时使用；
- Bot Token 仍保存在 Secret Store，不进入数据库；
- `api_id` 和 `api_hash` 不属于 Pi Hub 配置。

---

## 8. Web UI 设计

页面：

```text
/settings/integrations/telegram
```

### 8.1 服务类型

```text
Telegram Bot API

(●) Telegram 官方服务
( ) 自建 Bot API Server
```

### 8.2 官方服务

只展示：

```text
API 地址
https://api.telegram.org
```

字段只读。

### 8.3 自建服务

展示：

```text
Bot API Server 地址
[ https://tg-api.example.com ]

[测试连接]
```

高级设置：

```text
[ ] Bot API Server 使用 --local 模式
```

开启后显示：

```text
本地文件根目录
[ /var/lib/telegram-bot-api ]
```

提示：

```text
Pi Hub 必须能够以只读方式访问 Bot API Server 返回的绝对文件路径。
```

### 8.4 测试结果

成功：

```text
连接成功

Bot：@pi_hub_bot
服务地址：https://tg-api.example.com
模式：Long Polling
Local Mode：否
```

失败：

```text
无法连接自建 Bot API Server

请检查：
- 服务地址是否正确
- 反向代理是否可访问
- Bot Token 是否正确
- Bot 是否仍绑定在其他 Bot API Server
```

---

## 9. 连接测试

测试接口：

```http
POST /api/integrations/telegram/test
```

请求：

```json
{
  "apiRoot": "https://tg-api.example.com",
  "localMode": false
}
```

服务端使用当前已保存的 Bot Token调用：

```text
getMe
```

校验：

1. Endpoint 可连接；
2. HTTP 状态正常；
3. 返回结构包含 `ok = true`；
4. 返回 Bot ID 和 Username；
5. 不在响应中返回 Bot Token；
6. 错误信息中脱敏 Token。

如果开启 Local Mode，再进行可选文件路径能力检查，但不能为了测试而要求用户上传文件。

---

## 10. 从官方云切换到自建服务

Telegram 官方说明：为了确保 Bot 能在本地 Bot API Server 正确接收 Update，从官方云切换前需要在旧服务调用：

```text
logOut
```

迁移流程：

```text
1. 停止 Pi Hub Telegram Runtime
2. 确认没有 TelePi 或其他 Bot 进程使用该 Token
3. 在旧的 https://api.telegram.org 调用 logOut
4. 在 Pi Hub 配置自建 apiRoot
5. 测试 getMe
6. 启动 Pi Hub Telegram Runtime
7. 向 Bot 发送测试消息
```

### 10.1 Web UI 辅助

提供按钮：

```text
[从 Telegram 官方服务迁移]
```

点击后展示确认：

```text
此操作会在 Telegram 官方 Bot API 服务上调用 logOut。
完成后，该 Bot 应由配置的自建 Bot API Server 接管。

请确认自建服务已经启动。
```

用户确认后：

1. 使用官方 `apiRoot` 调用 `logOut`；
2. 保存自建 `apiRoot`；
3. 调用新 Endpoint 的 `getMe`；
4. 启动 Long Polling。

不得在普通的“测试连接”操作中自动调用 `logOut`。

---

## 11. 从一个自建服务切换到另一个

推荐流程：

```text
1. 停止旧 Pi Hub Telegram Runtime
2. 在旧 Bot API Server 调用 logOut
3. 修改 apiRoot
4. 在新 Bot API Server 调用 getMe
5. 启动 Long Polling
```

如果用户需要完整迁移 Bot API Server 内部状态，应在 Bot API Server 运维层完成，不属于 Pi Hub 的职责。

---

## 12. Long Polling

Long Polling 逻辑不因自建服务发生变化。

```ts
await bot.start({
  drop_pending_updates: true,
});
```

Pi Hub 仍然保留：

- Runtime Lease；
- 单进程轮询；
- 409 Conflict 检测；
- Update 时间校验；
- 优雅停止；
- 用户白名单；
- Conversation 隔离；
- Agent Session Lock。

### 12.1 409 Conflict

出现 409 时提示：

```text
当前 Bot Token 正被其他 Long Polling 或 Webhook 客户端使用。
```

可能来源：

- TelePi 仍在运行；
- 另一个 Pi Hub 实例；
- 另一个 Bot 程序；
- 旧 Bot API Server 上仍有实例接收 Update。

更换 `apiRoot` 不会自动解决同一 Token 的多消费者问题。

---

## 13. HTTP、HTTPS 与反向代理

Telegram 官方开源 Bot API Server 默认提供 HTTP 服务，默认端口通常为：

```text
8081
```

### 13.1 同机或内网

允许：

```text
http://127.0.0.1:8081
http://telegram-bot-api:8081
```

### 13.2 跨主机或公网

推荐在 Bot API Server 前使用：

- Nginx；
- Caddy；
- Traefik；
- 云负载均衡。

对外暴露：

```text
https://tg-api.example.com
```

不建议通过公网明文 HTTP 传输 Bot Token 和消息内容。

### 13.3 网络超时

建议：

```text
普通请求：30 秒
getUpdates：由 Long Polling Timeout 决定
文件下载：5 分钟
```

---

## 14. API 设计调整

### 14.1 获取配置

```http
GET /api/integrations/telegram/config
```

返回：

```json
{
  "botApi": {
    "mode": "self-hosted",
    "apiRoot": "https://tg-api.example.com",
    "localMode": false,
    "localFileRoot": null
  },
  "tokenConfigured": true
}
```

不返回 Token。

### 14.2 更新配置

```http
PUT /api/integrations/telegram/config
```

```json
{
  "botApi": {
    "mode": "self-hosted",
    "apiRoot": "https://tg-api.example.com",
    "localMode": false
  }
}
```

修改成功后：

1. 保存配置；
2. 停止旧 Runtime；
3. 测试新 Endpoint；
4. 测试成功后启动新 Runtime；
5. 测试失败则保持 Runtime 停止并返回明确错误。

不自动调用旧 Endpoint 的 `logOut`，除非走明确的迁移接口。

### 14.3 迁移接口

```http
POST /api/integrations/telegram/migrate-bot-api-server
```

请求：

```json
{
  "from": "official",
  "toApiRoot": "https://tg-api.example.com"
}
```

该接口必须由 Owner 明确确认后调用。

---

## 15. 模块调整

在原 Telegram 模块中增加：

```text
modules/telegram/
├── telegram-config.ts
├── telegram-bot-client.ts
├── telegram-transport.ts
├── telegram-files.ts
├── telegram-runtime.ts
└── telegram-bot-api-migration.ts
```

职责：

### `telegram-bot-client.ts`

- 使用 Token 和 `apiRoot` 创建 Grammy Bot；
- 不包含业务命令；
- 提供 `getMe` 测试。

### `telegram-transport.ts`

- 发送消息；
- 编辑消息；
- Callback Query；
- Chat Action；
- 统一使用配置的 `apiRoot`。

### `telegram-files.ts`

- 非 Local Mode：使用 `apiRoot` 构造文件下载地址；
- Local Mode：读取经过安全校验的绝对路径；
- 限制大小和临时文件生命周期。

### `telegram-bot-api-migration.ts`

- 显式执行 `logOut`；
- 从官方云切换到自建服务；
- 从旧自建服务切换到新服务；
- 不参与日常 Bot 运行。

---

## 16. 安全要求

- Bot Token 不能出现在 `apiRoot` 中；
- API 和日志不得返回 Token；
- 自建 Endpoint 变更只允许 Owner；
- 公网自建 Endpoint 必须提示使用 HTTPS；
- 允许内网 HTTP，但 Web UI 必须标注为内网部署；
- `localMode` 默认关闭；
- Local Mode 只允许读取 `localFileRoot` 下的文件；
- 必须解析符号链接后再校验目录边界；
- Pi Hub 对共享 Bot API 文件目录只需要只读权限；
- 不在 Pi Hub 中保存 Telegram `api_id` 和 `api_hash`；
- 不在普通测试请求中自动调用 `logOut`；
- Endpoint 修改后必须重新验证 Bot 身份；
- 自建域名的 TLS 校验默认不能关闭。

---

## 17. 错误码

| 错误码 | 含义 |
|---|---|
| `TELEGRAM_API_ROOT_INVALID` | Bot API Server 地址格式无效 |
| `TELEGRAM_API_ROOT_UNREACHABLE` | 无法连接 Bot API Server |
| `TELEGRAM_API_ROOT_AUTH_FAILED` | Token 在该服务上验证失败 |
| `TELEGRAM_API_ROOT_RESPONSE_INVALID` | 服务返回了无效 Bot API 响应 |
| `TELEGRAM_BOT_API_MIGRATION_REQUIRED` | Bot 尚未从旧服务退出 |
| `TELEGRAM_BOT_API_LOGOUT_FAILED` | 旧服务 `logOut` 失败 |
| `TELEGRAM_LOCAL_FILE_UNAVAILABLE` | Local Mode 文件路径不可访问 |
| `TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT` | 文件不在允许根目录中 |
| `TELEGRAM_TOKEN_IN_USE` | Token 正被其他消费者使用 |
| `TELEGRAM_TLS_ERROR` | 自建 HTTPS Endpoint 证书验证失败 |

---

## 18. 测试设计

### 18.1 单元测试

- 默认 `apiRoot`；
- 自建 `apiRoot` 规范化；
- 去除末尾 `/`；
- 拒绝带 Token 的 URL；
- Grammy Client 使用正确 `apiRoot`；
- 文件下载使用自建域名；
- Local Mode 绝对路径；
- Local Mode 路径越界；
- 符号链接越界；
- Token 脱敏；
- 迁移操作只在明确调用时执行。

### 18.2 集成测试

使用 Mock Bot API Server 验证：

- `getMe` 请求发送到自建域名；
- `getUpdates` 请求发送到自建域名；
- `sendMessage` 请求发送到自建域名；
- `getFile` 请求发送到自建域名；
- 文件下载不访问 `api.telegram.org`；
- Runtime 修改 Endpoint 后正确重启；
- 409 状态正确显示；
- Local Mode 读取共享文件；
- `logOut` 在旧 Endpoint 上执行。

### 18.3 真实环境验证

至少验证：

```text
Telegram 官方云端
    +
自建 tdlib/telegram-bot-api 标准模式
    +
自建 tdlib/telegram-bot-api --local 模式
```

部署组合：

```text
Pi Hub 与 Bot API Server 同机
Pi Hub 与 Bot API Server 分离容器但共享文件卷
Pi Hub 通过 HTTPS 域名访问 Bot API Server
```

---

## 19. 验收标准

1. 默认不配置时继续使用 `https://api.telegram.org`；
2. 用户可以在 Web UI 选择“自建 Bot API Server”；
3. 用户只需配置自建服务根地址；
4. Bot Token 不需要改变；
5. `getMe`、Long Polling、发消息和 Callback 全部使用自建地址；
6. 图片和语音文件下载也使用自建地址；
7. 不存在业务代码硬编码 `api.telegram.org`；
8. 自建服务不可用时给出明确错误；
9. 从官方云迁移时可以显式执行 `logOut`；
10. 修改地址不会隐式执行迁移操作；
11. 未启用 `--local` 时，不需要额外文件配置；
12. 启用 `--local` 时可以安全读取共享目录；
13. Local Mode 路径越界会被拒绝；
14. 现有 Telegram 命令、Session 和定时任务逻辑无需区分官方或自建服务；
15. 不增加第三方兼容协议和 Provider Adapter；
16. 不修改 Pi Session JSONL 格式；
17. 不影响 pi-web 上游功能。

---

## 20. 最终结论

对于 Telegram 官方开源 Bot API Server，用户的判断是正确的：

> 绝大部分接入工作就是把 `https://api.telegram.org` 替换成自建服务域名。

Pi Hub 的实现重点只有三个：

1. Grammy Client 的 `apiRoot` 可配置；
2. 文件下载也必须使用同一个 `apiRoot`，不能硬编码官方域名；
3. 如果 Bot API Server 启用了 `--local`，额外处理 `getFile` 返回的绝对本地路径。

除此之外，Telegram 命令、用户配对、Session、定时任务、通知、Long Polling 和 Agent 执行逻辑全部保持一致，不建立第二套兼容架构。

## 21. 参考资料

- Telegram 官方开源 Bot API Server：`https://github.com/tdlib/telegram-bot-api`
- Telegram Bot API：`https://core.telegram.org/bots/api`
- Grammy Local Bot API Server：`https://grammy.dev/guide/api.html`
