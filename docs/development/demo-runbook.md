# 第一轮启动与验收指南

本文覆盖 Demo 阶段 1～4 的运行与历史验收，并补充飞书结构化需求入口。阶段 1～4 已真实完成，PR #1、#3、#4 均由用户人工 Merge，`main` 406d27b 已验收。新入口启用需合并本 PR 并重启控制器；启用后，每次业务需求依次人工 Merge 文档 PR 和代码 PR。闭环 B、普通闲聊、多轮澄清编辑和 Triage 后置。

## 1. 环境与基础检查
建议使用 Node 24 或更新的兼容版本；Node 26 已用于本轮本地开发。当前物理隔离依赖 macOS 的 `sandbox-exec`，其他系统暂不支持直接运行 Agent；缺少隔离时会停止执行。在仓库根目录执行：
```bash
node --version
npm --version
git --version
gh --version
```
阶段 1～4 的依赖、初始化与运行步骤见 5.2；基线历史已固定在 `main` 406d27b。
`gh` 需要已登录，并对目标仓库拥有 Issue/PR 读写权限。安装后执行基础检查：
```bash
git remote -v
git status --short --branch
git fetch origin
git rev-parse --verify origin/main
gh auth status
npm run typecheck
npm test
SPEC_LOOP_VERIFY=1 npm test
npm run build
```
默认 `npm test` 跳过两项真实 HTTP 集成；`SPEC_LOOP_VERIFY=1 npm test` 在允许本机监听的环境中启用它们，验收时应确认没有 skip。Worker/部署的验证进程保持禁网。只检查前端自有逻辑时可运行 `node --test tests/frontend.test.ts`。以上检查报错时先修正，不进入真实需求变更或部署验收。

## 2. 本地环境文件
配置放在仓库根目录的 `.env.local`，不提交、不粘贴到聊天。创建时禁止覆盖已有内容：
```bash
cp -n .env.example .env.local
chmod 600 .env.local
```
以下值可按需覆盖；未使用项请删除整行，避免空字符串覆盖现有配置：
```dotenv
SPEC_LOOP_REPO=sunpcm/spec-loop
SPEC_LOOP_MAIN_BRANCH=main
SPEC_LOOP_HTTP_PORT=4000
SPEC_LOOP_PREVIEW_PORT=5173
SPEC_LOOP_DEV_PORT=5174
# Vercel 独立静态站正式入口；当前需账号登录
SPEC_LOOP_PUBLIC_URL=https://spec-loop-three.vercel.app/
```
加载配置的进程必须显式指定文件。每个运行 `demo:*` 的终端都执行：
```bash
export SPEC_LOOP_ENV_FILE="$PWD/.env.local"
```
多个 checkout 并行时使用目标仓库的绝对路径。`.env.local`、`.orchestrator/` 和构建产物必须保持未跟踪，可执行 `git check-ignore .env.local .orchestrator/agent/models.json` 核对。

## 3. Pi 自定义模型
Pi 固定依赖官方 registry 包 `@earendil-works/pi-coding-agent@1.5.2`。在 `.env.local` 中配置 provider、模型和私有 agent 目录：
```dotenv
PI_PROVIDER=demo-compatible
PI_MODEL=exact-model-id
PI_CODING_AGENT_DIR=/absolute/path/to/spec-loop/.orchestrator/agent
SPEC_LOOP_PI_API_KEY=只写入本地环境文件
```
`PI_CODING_AGENT_DIR` 使用绝对路径。创建私有目录：
```bash
mkdir -p .orchestrator/agent
chmod 700 .orchestrator/agent
```
在 `.orchestrator/agent/models.json` 中配置真实端点。API key 引用必须保留 `${...}` 外壳：
```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "demo-compatible": {
      "baseUrl": "https://your-provider.example/v1",
      "api": "openai-completions",
      "apiKey": "${SPEC_LOOP_PI_API_KEY}",
      "models": [{ "id": "exact-model-id" }]
    }
  }
}
```
`PI_PROVIDER` 必须匹配 provider 键，`PI_MODEL` 必须匹配模型 `id`。`api` 按真实兼容协议填写；只有 Chat Completions 兼容端点才使用 `openai-completions`。真实 key 只放在 `.env.local`，可用 `node_modules/.bin/pi --version` 核对二进制。真实产品 Pi runner 已通过；更换 provider、model、base URL 或协议后仍需重新验收。

飞书需求入口新增 `spec-author`。它沿用同一套 `--no-tools`、沙箱、环境白名单、5 分钟超时和作业内 `agentDir`，只接收 `origin/main:docs/specs/counter.md` 与用户文本，并只返回 `{summary, content}`。它不能获得 GitHub 凭据、shell 或仓库写权限；控制器验证后再写入唯一白名单文件。

## 4. 飞书本地配置

按 [飞书配置](feishu-setup.md) 启用机器人、订阅 `im.message.receive_v1` 长连接并发布应用。本地至少填写：
```dotenv
FEISHU_ENABLED=true
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=只写入本地环境文件
FEISHU_CHAT_ID=oc_xxx
FEISHU_ALLOWED_USER_IDS=ou_user1,ou_user2
```
`FEISHU_CHAT_ID` 是唯一绑定会话 ID，可填单聊或群聊；本轮实际复用“小虾子”单聊。白名单为空时拒绝所有命令，但仍可向绑定会话发通知。真实认证、单聊通知、WebSocket 启停和人工 `状态` 往返均已通过。

## 5. 启动已验收基线

### 5.1 确认历史基线并刷新 root

阶段 1～4 对应 PR #1、#3、#4 均已由用户人工 Merge，`main` 406d27b 是历史真实验收基线。若 406d27b 不是当前 `origin/main` 的祖先，停止并核对远端历史；不要用本地提交或未合并分支替代已验收主线。在主 checkout 执行：
```bash
git fetch origin
git switch main
git pull --ff-only origin main
git merge-base --is-ancestor 406d27b origin/main
git rev-parse --short HEAD
git show origin/main:src/counter.ts >/dev/null
git show origin/main:tests/frontend.test.ts >/dev/null
```

### 5.2 安装、初始化与启动

按第 2～4 节准备配置，然后在 root checkout 按顺序执行：
```bash
npm ci
cp -n .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local 后：
export SPEC_LOOP_ENV_FILE="$PWD/.env.local"
npm run demo:init
npm run demo
```
`npm run demo` 保持前台运行并监听控制 API `http://127.0.0.1:4000`。只有 `demo:init` 已成功完成初始基线构建并写入健康发布指针后，才能检查稳定预览；否则停在阶段 1 排障，暂不修改需求。
```bash
curl --fail --silent --show-error http://127.0.0.1:4000/api/health
```
健康发布指针存在时再执行：
```bash
curl --fail --silent --show-error http://127.0.0.1:5173/__version
```
此时在 5173 验收初始基线：值从 `0` 开始、步长为 `1`；步长 `2` 时增加得到 `2`；重置后归零并保留 `2`；空步长时计数不变并显示可恢复错误。需要人工开发页时，另开终端运行 `npm run dev` 并访问 `5174`；`demo` 不启动 5174。

## 6. 闭环 A：飞书业务需求入口

入口启用后，每次业务需求执行两次人工 Merge：先人工 Merge docs-only 文档 PR，再人工 Merge 自动产生的代码 PR。

阶段 1～4 的已验收路径是人工修改 `docs/specs/counter.md`、push `main`，随后由控制器生成 Worker PR。飞书结构化入口把第一段改为受控 docs PR：

1. 白名单操作者在唯一绑定会话发送单条 `需求：描述` 或 `/require 描述`，长度 1～2000 字符。
2. 服务快速 ACK 并进入全局串行队列；`spec-author` 只生成 `counter.md` 中现有 `REQ-CNT-01` 的候选变化。
3. 控制器检查 JSON、路径、大小、既有需求块保留、格式和实际变化，在确定性分支 `pi/spec-<请求ID>` 上提交唯一文件，创建带 `spec-patch` 标签的 docs-only PR。
4. 用户人工 Merge 文档 PR。文档进入 `main` 后才自动触发现有编码闭环，产生只修改 `src/**` 的代码 PR。
5. 用户再次人工 Merge 代码 PR，进入第 7 节部署。

未启用新入口时，可继续使用人工文档路径验证既有 A/C 闭环。人工路径的基线命令为：
```bash
git diff --check
git diff -- docs/specs/counter.md
git add docs/specs/counter.md
git commit -m "docs(REQ-CNT-01): update counter behavior"
git push origin main
```
飞书入口实现后的核对命令：
```bash
gh pr list --repo sunpcm/spec-loop --state all --label spec-patch --limit 20
gh pr diff <文档PR编号> --repo sunpcm/spec-loop --name-only
gh pr view <文档PR编号> --repo sunpcm/spec-loop --json number,state,labels,body,files
gh pr list --repo sunpcm/spec-loop --state open --limit 20
```

验收条件是：

- ACK 只表示收到；通知包含稳定请求 ID 和后续恢复方式。
- 文档 PR 只修改 `docs/specs/counter.md`，保留现有 `REQ-CNT-01`，并带 `spec-patch` 标签与确定性元数据；不得使用 `Closes`。
- 同一飞书 `messageId`、重复描述和进程重启不重复调用 Pi/建 PR；冲突请求返回现有请求链接。
- 当前 `main` 与原请求 `baseSHA` 不一致时 fail closed，提示基于新主重新提需求。
- 文档 PR 由用户人工 Merge；Merge 后自动触发的代码 PR 只修改 `src/**`，仍等待人工 Merge。
- Issue 进入处理中及 review 状态，并记录需求 ID、需求哈希和来源 `main` SHA。
- PR 只修改 `src/**`，等待人工审查，不自动 Merge。
- 飞书收到对应阶段通知。通知失败不回滚 GitHub 主链路。

逐项核对：
```bash
gh issue list --repo sunpcm/spec-loop --state all --limit 20
gh pr list --repo sunpcm/spec-loop --state open --limit 20
gh pr diff <PR编号> --repo sunpcm/spec-loop --name-only
```

## 7. 闭环 C：人工 Merge 到部署

由用户在 GitHub 人工 Merge 代码 PR。对飞书需求入口而言，这是继文档 PR 后的第二次人工 Merge。控制器识别 Merge 后 fetch `origin/main`、构建新版本、执行健康检查并切换 5173；失败时保留旧预览。
```bash
curl --fail --silent --show-error http://127.0.0.1:5173/__version
npm run demo:status
gh issue view <Issue编号> --repo sunpcm/spec-loop
gh pr view <PR编号> --repo sunpcm/spec-loop --json state,mergeCommit
```
确认 `/__version` 的 SHA、页面显示的 `__APP_VERSION__` 和部署回执一致，Issue 带有 `status:done`，并重新验收本轮要求的行为。GitHub 因 `Closes #N` 自动关闭 Issue 不代表部署完成。

### 7.1 Vercel 静态前端（可选）

Vercel 部署只承载纯静态前端，配置步骤见 [Vercel 静态前端部署](vercel-setup.md)。正式地址是 <https://spec-loop-three.vercel.app/>，当前需账号登录。PR 先生成 Vercel Preview；只有人工 Merge 到 `main` 后，Vercel 的 production deployment 才按该 Merge commit 运行构建。控制器不调用 Vercel，也不能把 Vercel deployment 的成功、URL 存在或登录页当作本地部署成功。Vercel Ready 只代表静态前端云端就绪，不代表控制器、Pi 或飞书入口部署在云上。

本地 `status:done` 始终表示本机完成了构建、HTTP 健康检查和预览切换。配置合法的 `SPEC_LOOP_PUBLIC_URL` 后，本地部署成功的飞书通知和 Issue 回执会附“公网入口（Vercel独立发布）”，该链接不代表 Vercel 已部署或 Ready 当前 SHA。

Vercel 构建产物中的 `version.json` 固定为 `{ "version": "<版本>" }`；版本优先取 `SPEC_LOOP_VERSION`，其次取 Vercel 的 `VERCEL_GIT_COMMIT_SHA`，本地普通开发回退为 `dev`。本地稳定预览继续使用 `/__version`，Vercel 静态站使用 `/version.json`。

电脑关机后，已上线的 Vercel 页面仍可查看，但本地控制器、Pi Worker、飞书命令和本地稳定预览都会停止。当前 Vercel 站点没有后端 API；闭环 B 如需云端调用，必须另行设计公网 API 与服务端安全边界。

## 8. 状态、重试与失败处理
```bash
export SPEC_LOOP_ENV_FILE="$PWD/.env.local"
npm run demo:status
npm run demo:recover
npm run demo:retry -- --issue <Issue编号>
```
- 非部署失败：恢复 `demo` 运行后，`demo:retry` 重新执行当前 Worker attempt，并产生新的作业尝试。
- 部署失败：仅当 `resumeAction` 为 `deploy-only` 时重新构建和部署，不重新调度 Worker。
- `demo:recover`：控制器异常退出后重新对账远端需求，并把中断的 `processing` 作业标为可显式重试的失败状态。
- 需求已变化、来源 SHA 不一致或作业不属于当前需求时，不重试旧结果。
- 飞书绑定会话内可使用 `状态` 查看需求请求 ID、阶段、文档 PR/代码 PR 与错误摘要。
- `重试需求 <请求ID>` 只恢复对应 spec 请求中未完成的阶段；已有有效文档、commit、push、PR 或标签不能重复创建。
- `重试 #<Issue编号>` 继续用于原有 Worker 交付，与需求请求重试相互独立。
- `帮助`、`/help` 和未知文本返回中文帮助；未知文本不会进入需求生成或闲聊。所有命令仍受绑定会话和白名单限制。

飞书需求入口要求先落盘阶段再产生外部效果，`runOnce`、`状态` 和显式重试先做无 Pi 的远端对账。远端读取失败时 fail closed；已合并或已关闭的 PR 不重新创建。既有 Planner/Worker 的更细阶段恢复仍按自身契约单独验收，不能由本次文档入口测试推定完成。

## 9. 验收记录

历史阶段 1～4 已记录并通过：PR #1、#3、#4 均由用户人工 Merge，`main` 406d27b 已验收。飞书需求入口的验收进度与证据要求见 [需求入口计划](feishu-intake-plan.md)。闭环 B 在结构化需求入口稳定后另行启动；普通闲聊、多轮澄清和多轮编辑继续暂缓。
