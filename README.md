# Spec Loop

Spec Loop 是一个本地文档驱动开发演示：`origin/main` 上的 `docs/specs/*.md` 描述产品行为，控制器把需求变化同步为 GitHub Issue，Pi Worker 生成只修改 `src/` 的代码 PR，人工 Merge 后构建并切换到本地稳定预览。

第一轮覆盖阶段 1～4：基础环境与计数器、飞书通知、文档到 Worker PR（闭环 A）、人工 Merge 到本地部署（闭环 C）。错误驱动修订与自动修复（闭环 B）后置。

Vercel 只承载由 `dist/` 生成的静态前端；电脑关机后页面仍可访问，但本地控制器、Pi Worker 与飞书任务会停止。配置方法见 [Vercel 静态前端部署](docs/development/vercel-setup.md)。

当前隔离实现依赖 macOS 的 `sandbox-exec`；不可用时拒绝运行 Agent。项目固定使用 Node 24。

## 当前验收边界

- 前端计数与空步长错误、真实产品 Pi runner、真实 Worker + Git 夹具已通过本地或夹具验收。
- 飞书真实认证、单聊通知、WebSocket 启动与关闭已通过；人工发送 `状态` 并收到回复仍待用户在线验收。
- 真实远端闭环 A/C 尚未完整验收，仍需先人工 Merge 基础实现 PR，再人工 Merge Worker 代码 PR；当前不能表述为全链路成功。

## 最短启动

详细配置、阶段命令和验收证据见 [第一轮启动与验收指南](docs/development/demo-runbook.md)。先在 GitHub 由用户人工 Merge 基础实现 PR，再进入仓库 root checkout 按顺序执行：

```bash
git switch main
git pull --ff-only origin main
npm ci
cp -n .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local 后再执行：
export SPEC_LOOP_ENV_FILE="$PWD/.env.local"
npm run demo:init
npm run demo
```

`npm run demo` 提供控制 API `http://127.0.0.1:4000`。只有 `demo:init` 成功完成初始基线构建并写入健康发布指针后，才验收稳定预览 `http://127.0.0.1:5173`；否则停在阶段 1 排障。Vite 开发页 `5174` 需另开终端运行 `npm run dev`。

保持 `demo` 运行后再修改 `docs/specs/counter.md`，commit 并 push 到 `origin/main`，等待控制器生成 Worker PR。

## 核心约束

- 需求文档只有进入 GitHub `origin/main` 后才生效；本地文件、本地 commit 和未合并 PR 都不改变现行需求。
- Planner 只计划，Worker 只请求修改 `src/**`；类型检查、测试、构建、Git 与 GitHub 操作由控制器执行。
- 基础实现 PR 和后续 Worker 代码 PR 都必须由用户人工 Merge，任何 Agent 都不得自动 Merge。
- Issue 因 `Closes #N` 关闭不代表部署完成；完成条件是对应主线版本已部署，并带有 `status:done` 与部署回执。
- `status:done` 只表示本地健康部署；`SPEC_LOOP_PUBLIC_URL` 指向的 Vercel 入口是独立静态发布，不代表当前 SHA 已在 Vercel Ready。
- 部署失败保留旧预览并只执行 `deploy-only`；其他失败的重试会重新执行本 Worker attempt。严格阶段恢复后置。

## 文档导航

[启动与验收](docs/development/demo-runbook.md) · [Vercel 静态前端](docs/development/vercel-setup.md) · [飞书配置](docs/development/feishu-setup.md) · [需求与验收](docs/development/requirements.md) · [架构与运行契约](docs/development/architecture.md)
