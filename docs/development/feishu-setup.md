# 飞书自建应用配置

本文只覆盖 Demo 第一轮的最小配置。应用由用户自行在飞书开放平台创建和配置，secret 只写入本地 `.env.local`，不要粘贴到聊天、Issue 或 PR。

## 1. 创建自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)，进入「开发者后台」。
2. 创建「企业自建应用」，记录 `App ID` 和 `App Secret`。
3. 在「应用能力 → 添加应用能力」中启用「机器人」。

## 2. 最短权限

在「权限管理」中只开通以下权限：

| 权限 | 用途 |
| --- | --- |
| `im:message` | 机器人读取群消息事件、发送文本消息 |

第一轮不需要通讯录、日历、云文档或其他业务权限。后续扩展时再按实际功能单独追加。

## 3. 事件订阅

1. 进入「事件与回调 → 事件配置」。
2. 订阅方式选择「使用长连接接收事件」（Demo 使用官方 Node SDK 的长连接，不暴露公网回调地址）。
3. 添加事件：`im.message.receive_v1`（接收消息）。
4. 在「应用发布」中创建版本并发布；未发布的应用版本无法在正式群里收到事件。

### 复用现有应用的限制

同一自建应用的多个独立长连接客户端由飞书随机分流事件，不能同时在线运行 OpenClaw 与本 Demo：一方收到消息时另一方收不到。若现有 OpenClaw 服务必须继续在线，请为本 Demo 单独创建一个应用；若改为本 Demo 独占该应用，请先确认 OpenClaw 已停用。

## 4. 群聊与白名单

1. 把机器人加入用于 Demo 的群聊。
2. 获取群聊 `chat_id`（通常以 `oc_` 开头）：可在开发者后台「开发者工具 → API 调试台」调用 `im.chat.list`，或从事件调试日志的 `message.chat_id` 读取。
3. 获取允许发命令成员的 `open_id`（通常以 `ou_` 开头）：可通过 `im.chat.members.list` 调试，或从 `im.message.receive_v1` 事件日志的 `sender.sender_id.open_id` 读取。
4. 将机器人加入群后，在群里发一条消息确认事件日志能看到该消息。

白名单为空时模块会拒绝所有命令（默认拒绝），但阶段通知仍会发送到 `FEISHU_CHAT_ID`。

命令只在 `FEISHU_CHAT_ID` 指定的这一个群内生效：即使机器人在其他群，或白名单用户在其他群发消息，都不会执行命令。

## 5. 本地配置

```bash
cp .env.example .env.local
```

然后编辑 `.env.local`：

```dotenv
FEISHU_ENABLED=true
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=你的AppSecret
FEISHU_CHAT_ID=oc_xxx
FEISHU_ALLOWED_USER_IDS=ou_user1,ou_user2
```

`.env.local` 已被 `.gitignore` 排除；如果本地尚未排除，请先补充忽略规则再填写 secret。

## 6. 支持的命令

| 命令 | 行为 |
| --- | --- |
| `/status` | 返回当前 Demo 状态 |
| `状态` | 等同 `/status` |
| `/retry <Issue编号>` | 对指定 Issue 重试当前失败阶段 |
| `重试 #<Issue编号>` | 等同 `/retry <Issue编号>` |

命令先收到快速 ACK，再异步执行并回执结果；重复消息按 `message_id` 去重，不会重复执行。
