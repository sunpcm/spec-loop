# 第一轮启动与验收指南

本文覆盖 Demo 阶段 1～4：基础环境与计数器、飞书接入、文档变更到真实 Worker PR（闭环 A）、人工 Merge 到本地部署（闭环 C）。闭环 B、严格阶段续跑和高级恢复后置。

## 1. 环境与基础检查
建议使用 Node 24 或更新的兼容版本；Node 26 已用于本轮本地开发。当前物理隔离依赖 macOS 的 `sandbox-exec`，其他系统暂不支持直接运行 Agent；缺少隔离时会停止执行。在仓库根目录执行：
```bash
node --version
npm --version
git --version
gh --version
```
依赖安装在基础实现 PR 人工 Merge、root 更新后执行，见 5.2。
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

## 4. 飞书本地配置

按 [飞书配置](feishu-setup.md) 启用机器人、订阅 `im.message.receive_v1` 长连接并发布应用。本地至少填写：
```dotenv
FEISHU_ENABLED=true
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=只写入本地环境文件
FEISHU_CHAT_ID=oc_xxx
FEISHU_ALLOWED_USER_IDS=ou_user1,ou_user2
```
`FEISHU_CHAT_ID` 是唯一绑定会话 ID，可填单聊或群聊；本轮实际复用“小虾子”单聊。白名单为空时拒绝所有命令，但仍可向绑定会话发通知。真实认证、单聊通知、WebSocket 启动与关闭已通过；最后的人工 `状态` 命令及回复需用户在线验收。

## 5. 启动阶段 1：先合并基础实现，再初始化

### 5.1 人工 Merge 与刷新 root

基础实现 PR 必须先由用户在 GitHub 人工 Merge。若它尚未成为 `origin/main` 的祖先，停止；本地提交或未合并分支不能作为启动基线。在主 checkout 执行：
```bash
git fetch origin
git switch main
git pull --ff-only origin main
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

## 6. 闭环 A：文档变更到 Worker PR

仅在第 5 节完成、`demo` 保持运行后，修改 `docs/specs/counter.md` 表达新行为，不预先修改 `src/`。检查并推送：
```bash
git diff --check
git diff -- docs/specs/counter.md
git add docs/specs/counter.md
git commit -m "docs(REQ-CNT-01): update counter behavior"
git push origin main
```
保持 `demo` 运行，等待控制器创建或更新 Issue，再由真实 Pi Worker 生成 PR。验收条件是：

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

由用户在 GitHub 人工 Merge Worker 代码 PR。控制器识别 Merge 后 fetch `origin/main`、构建新版本、执行健康检查并切换 5173；失败时保留旧预览。
```bash
curl --fail --silent --show-error http://127.0.0.1:5173/__version
npm run demo:status
gh issue view <Issue编号> --repo sunpcm/spec-loop
gh pr view <PR编号> --repo sunpcm/spec-loop --json state,mergeCommit
```
确认 `/__version` 的 SHA、页面显示的 `__APP_VERSION__` 和部署回执一致，Issue 带有 `status:done`，并重新验收本轮要求的行为。GitHub 因 `Closes #N` 自动关闭 Issue 不代表部署完成。

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
- 飞书绑定会话内可使用 `状态` 或 `重试 #<Issue编号>`；命令仍受绑定会话和白名单限制。

当前不承诺 `plan/write/verify/commit/publish` 的严格单阶段续跑。需要精确上下文恢复时，另行实施并验收高级恢复能力。

## 9. 验收记录

记录日期与运行人员、Node/npm/Pi 版本、仓库和 `main` SHA、基础实现 PR 与 Merge SHA、需求 ID/路径/哈希、Issue 与 Worker PR、部署 SHA 和 `/__version`、页面与飞书证据、失败与重试结果、仍未验证项。真实远端 A/C 在两次人工 Merge 前不能报告全链路成功。

闭环 B 在 A/C 的真实远端流程稳定后另行启动。
