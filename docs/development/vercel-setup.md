# Vercel 静态前端部署

本配置把 Vite 前端作为纯静态站点发布。它只提供页面展示，不包含 Spec Loop 控制器、Pi Worker、GitHub 写操作、飞书长连接或任何 Vercel Functions。

## 固定构建配置

- [vercel.json](../../vercel.json) 固定 Framework Preset 为 Vite，构建命令为 `npm run build`，输出目录为 `dist`。
- `package.json` 的 `engines.node` 固定为 `24.x`，避免沿用项目面板中的其他 Node 版本。
- [.vercelignore](../../.vercelignore) 使用根目录允许清单，仅允许 `src/`、`index.html`、`package.json`、`package-lock.json`、Vite/TypeScript 配置及 Vercel 配置进入 Vercel 上传集合。模型、飞书、GitHub 等本地配置目录与秘密文件不在清单内。
- 仓库没有 `api/`、`functions/` 或其他服务端入口，构建结果只有 HTML、CSS、JavaScript 和静态 `version.json`。

`.vercelignore` 是 Vercel 部署输入过滤，不是秘密扫描器，也不是源码保密边界。使用 Git 集成时，Vercel 仍会基于完整 Git commit 创建部署；任何已经提交到仓库的源码或秘密仍会存在于构建环境和 Git 历史中。`.env*`、`.orchestrator/`、`.review/`、模型 key、飞书 secret 与 GitHub token 不得提交。Vercel 项目也不需要配置这些秘密。

## 首次连接

1. 在 Vercel 导入 `sunpcm/spec-loop`，将 Root Directory 保持为仓库根目录。
2. Framework Preset 选择 Vite；若仓库内 `vercel.json` 已生效，应显示同一构建命令与输出目录。
3. 确认 Node.js Version 使用 24.x。`package.json` 的 `engines.node` 会覆盖面板中的其他版本。
4. Production Branch 选择 `main`，不要为本地运行配置 `FEISHU_*`、`PI_*`、`SPEC_LOOP_PI_API_KEY`、GitHub token 或本地 `.orchestrator` 路径。
5. 第一次 PR 生成 Preview URL；由用户检查页面和 `/version.json`。任何 Agent 都不得未经用户确认自主 Merge PR；受管 PR 可按 [飞书受控确认合并 PR](feishu-merge-plan.md) 执行，其他 PR 仍需人工 Merge 到 `main` 后，Vercel 才会生成 production deployment。

当前 Vercel CLI 不进入 Demo 主链路，控制器不调用 Vercel。仓库 `.gitignore` 忽略本地 `.vercel/` 链接目录。

## 版本与健康标识

`vite.config.ts` 写入 `__APP_VERSION__`，并在构建产物生成格式固定的 `dist/version.json`：

```json
{
  "version": "<version>"
}
```

版本选择顺序为：

1. `SPEC_LOOP_VERSION`
2. `VERCEL_GIT_COMMIT_SHA`
3. `dev`

本地控制器构建继续注入需求 Merge SHA、`SPEC_LOOP_ASSET_BASE=/releases/<sha>/` 与自定义 `SPEC_LOOP_OUT_DIR`；Vercel 构建强制资源 base 为 `/`，输出目录为 `dist`。因此本地稳定预览继续检查 `/__version`，Vercel 静态站检查 `/version.json`。

`version.json` 不是云端 Ready 证明。它只表示该静态构建包含哪个版本标签；仍需在 Vercel 控制台或部署详情核对目标 commit 的 deployment 状态。

## 本地公网入口回执

Vercel production URL 确定后，只在本地 `.env.local` 增加非秘密配置：

```dotenv
SPEC_LOOP_PUBLIC_URL=https://spec-loop.vercel.app
```

加载配置时会校验 URL：非空值必须使用 `https`，且不得包含用户名或口令；无效值会让控制器在启动时明确失败。

之后每次本地部署通过构建与 HTTP 健康检查，飞书成功通知和 Issue 部署回执会附：

```text
🚀 本地已部署：<SHA>（健康检查通过）
公网入口（Vercel独立发布）：https://spec-loop.vercel.app/
```

`status:done` 的判定仍是本地发布健康检查，不代表 Vercel 已部署或 Ready 当前 SHA。Vercel URL 缺失或无法访问不会改变本地部署结果，URL 存在也不会把本地部署失败改成成功。

## 运行边界

电脑关机后，Vercel 上的静态页面仍可访问，但以下能力全部停止：

- 本地控制器对账与部署；
- Pi Planner/Worker 执行；
- 飞书长连接、命令与通知；
- `http://127.0.0.1:4000` 控制接口；
- `http://127.0.0.1:5173` 本地稳定预览。

如果后续闭环 B 需要关机后继续触发和观察任务，必须新增公网控制 API、认证授权、幂等、审计和敏感凭据隔离方案；不能把本地控制端口直接暴露到公网。
