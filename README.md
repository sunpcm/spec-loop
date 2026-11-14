# Spec Loop

Spec Loop 是一个本地文档驱动开发演示：`origin/main` 上的 `docs/specs/*.md` 描述产品行为，控制器把已验证的需求变化同步为 GitHub Issue，Pi Worker 生成只修改 `src/` 的代码 PR，人工 Merge 后构建并切换到本地稳定预览。

第一轮阶段 1～4 已完成真实链路验收：基础环境与计数器、飞书通知与状态、文档到 Worker PR（闭环 A）、人工 Merge 到本地部署（闭环 C）。PR #1、#3、#4 均已由用户人工 Merge；`main` 406d27b 是已验收基线。错误驱动修订与自动修复（闭环 B）后置。

本分支新增飞书结构化需求入口；新入口启用需合并本 PR 并重启控制器。入口接受白名单操作者在绑定会话发送 `需求：描述` 或 `/require 描述`，描述限制 1～2000 字符；`spec-author` 只生成 `docs/specs/counter.md` 中现有 `REQ-CNT-01` 的更新，控制器创建带 `spec-patch` 标签的 docs-only PR，之后依次由用户人工 Merge 业务文档 PR 和代码 PR。当前验收进度见 [飞书需求入口计划](docs/development/feishu-intake-plan.md)。

Vercel 只承载由 `dist/` 生成的静态前端；正式地址是 [https://spec-loop-three.vercel.app/](https://spec-loop-three.vercel.app/)，当前需账号登录。Vercel Ready 只表示静态前端在云端部署成功，不代表控制器、Pi Worker 或飞书入口运行在云上。电脑关机后静态页面仍可访问，但本地控制器、Pi Worker 与飞书任务会停止。配置方法见 [Vercel 静态前端部署](docs/development/vercel-setup.md)。

当前隔离实现依赖 macOS 的 `sandbox-exec`；不可用时拒绝运行 Agent。项目固定使用 Node 24。

## 已验收基线

- 阶段 1～4 已完成本地、GitHub、Pi、浏览器与部署的真实验收；当前已验收主线为 406d27b。
- Vercel 正式入口可访问但受登录保护，未登录设备不能据此验收页面内容。
- 普通闲聊、无命令自然语言、多轮澄清或多轮编辑、其他需求块和其他文档写入均暂缓。

## 最短启动

详细配置、阶段命令和验收证据见 [第一轮启动与验收指南](docs/development/demo-runbook.md)。进入包含已验收基线的 root checkout 后按顺序执行：

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git merge-base --is-ancestor 406d27b origin/main
npm ci
cp -n .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local 后再执行：
export SPEC_LOOP_ENV_FILE="$PWD/.env.local"
npm run demo:init
npm run demo
```

`npm run demo` 提供控制 API `http://127.0.0.1:4000`。只有 `demo:init` 成功完成初始基线构建并写入健康发布指针后，才验收稳定预览 `http://127.0.0.1:5173`；否则停在阶段 1 排障。Vite 开发页 `5174` 需另开终端运行 `npm run dev`。

入口启用后，保持 `demo` 运行并在绑定飞书会话发送结构化需求：控制器先生成只修改 `docs/specs/counter.md` 的文档 PR；用户人工 Merge 文档 PR 后才进入 Worker，代码 PR 仍须人工 Merge。

## 核心约束

- 需求文档只有进入 GitHub `origin/main` 后才生效；本地文件、本地 commit 和未合并 PR 都不改变现行需求。
- `spec-author` 只输出 `{summary, content}`，不能调用工具或直接写仓库；控制器只允许写入 `docs/specs/counter.md`，并校验现有 `REQ-CNT-01` 保留且确有变化。
- Planner 只计划，Worker 只请求修改 `src/**`；类型检查、测试、构建、Git 与 GitHub 操作由控制器执行。
- 每次业务需求的文档 PR 和代码 PR 都必须由用户人工 Merge，任何 Agent 都不得自动 Merge。
- 飞书 `messageId` 持久去重；同一 `counter.md` 目标只允许一个未结束请求或 PR。主线漂移、远端状态不明或没有显式 `重试需求 <请求ID>` 时 fail closed。
- Issue 因 `Closes #N` 关闭不代表部署完成；完成条件是对应主线版本已部署，并带有 `status:done` 与部署回执。
- `status:done` 只表示本地健康部署；`SPEC_LOOP_PUBLIC_URL` 指向的 Vercel 入口是独立静态发布，不代表当前 SHA 已在 Vercel Ready。
- 部署失败保留旧预览并只执行 `deploy-only`；需求入口按已落盘阶段恢复，已有有效文档/commit/PR 不重复生成。既有 Planner/Worker 的更细阶段恢复仍按各自契约验收。

## 文档导航

[启动与验收](docs/development/demo-runbook.md) · [飞书需求入口计划](docs/development/feishu-intake-plan.md) · [Vercel 静态前端](docs/development/vercel-setup.md) · [飞书配置](docs/development/feishu-setup.md) · [需求与验收](docs/development/requirements.md) · [架构与运行契约](docs/development/architecture.md)
