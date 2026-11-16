# 测试与浏览器验收门禁

文档日期：2026-11-16。范围：固定检查、Playwright 生命周期门禁、独立测试基线维护与当前平台局限。

## 1. 分层与职责

验证分两层，缺一不可：

1. **固定可信检查**（禁网只读快照）：`typecheck`、`node:test`、`build`。它们在完全禁网、源/测试/配置只读的 `sandbox-exec` 快照中运行，不使用浏览器。
2. **浏览器验收门禁**（`runBrowserGate`）：父控制器启动固定候选产物的本机静态 HTTP 服务，浏览器测试子进程在**另一个** `sandbox-exec` profile 中运行。它只放行该次候选的本机固定端口，禁止公网、其他本机端口、敏感文件读与源/测试/配置写，不接受任意外站 URL。

两层都通过才允许继续 `commit/push/PR`（Worker 路径）或 `healthCheck/switchPreview/markDeployed`（合并构建路径）。

## 2. 依赖与浏览器准备

- Node 版本锁定 `24.x`，实测 `v24.15.0`。安装阶段可能因宿主默认 Node 版本不同出现 `EBADENGINE` 警告，自测请固定用 `/Users/sunpcm/.nvm/versions/node/v24.15.0/bin`。
- `@playwright/test` 锁定 `1.65.1`，其匹配的 Chromium revision 为 `1255`。**不要假设本地旧缓存 `chromium-1234` 匹配**；版本以 `@playwright/test` 锁定的 revision 为准。
- 门禁走 Playwright 默认 headless shell（`chromium_headless_shell-1255`）与配套 `ffmpeg-1013`，**不要求 full Chromium `chromium.executablePath()` 存在**，也不因外层 Seatbelt 已强制的 `--no-sandbox` 而宣称取消外层隔离。

准备阶段安装（只需 headless shell，避免下载完整 Chromium CFT 约 191MB）：

```bash
npx playwright install chromium --only-shell --no-remove
```

安装依赖（受控，验证阶段不下载浏览器）：

```bash
npm install --ignore-scripts --no-audit --no-fund
```

`package-lock.json` 由安装进程独占生成，安装期间不要同时编辑或再次安装。

## 3. 运行命令

固定检查：

```bash
npm run typecheck
npm test
npm run build
```

浏览器验收（**必须先构建**产物，且与生命周期门禁共用同一受控沙箱入口，不接受裸跑 `playwright test` 或任意外站 URL）：

```bash
npm run build
npm run test:e2e          # 等价 node orchestrator/browser-gate-cli.ts counter
npm run build:panel
npm run test:e2e:panel    # 等价 node orchestrator/browser-gate-cli.ts panel
```

用户直接执行 `npm run test:e2e*` 也必须经过 `orchestrator/browser-gate-cli.ts` → `runBrowserGate` 的同一 sandbox-exec 门禁；脚本不裸调 Playwright。

## 4. 隔离边界

门禁沙箱 profile 关键约束：

- `deny network*`，随后仅放行 `(allow network-outbound (remote tcp4 "localhost:<port>"))` 唯一本机端口。写法必须是 `tcp4` + `localhost` + 固定端口；`127.0.0.1` 或 `remote tcp "127.0.0.1:port"` 会编译失败（host 必须为 `*` 或 `localhost`）。
- 浏览器缓存目录精确放行读取，不放开整个真实 `HOME`；源/测试/配置只读，仅作业临时目录可写。
- 所有 `runDir/suiteDir/HOME/TMPDIR/profile` 与返回日志路径统一经 `resolveSeatbeltPath` 落到真实路径；macOS 下 `os.tmpdir()` 返回 `/var/folders/...` 别名时必须匹配 `/private/var/folders/...`，不放开父目录、不移除隔离、不重用原 HOME。
- 环境白名单仅 `PATH/LANG/LC_ALL/NO_COLOR`，注入 `SPEC_LOOP_E2E_BASE_URL`、`SPEC_LOOP_E2E_VERSION`、`SPEC_LOOP_E2E_REPORT_DIR`、`PLAYWRIGHT_BROWSERS_PATH`；不带 GitHub/模型凭据、代理变量或 `.env`。
- 静态服务只暴露当前候选 `artifactDir`，拒绝兄弟 `release` 目录与 symlink 逃逸；Host 固定本机，不提供控制器 API。

## 5. 验收契约与报告

- 契约文件 `tests/e2e/contracts/counter.json` 含 `reqId/specPath/specHash/caseIds`；`panel.json` 仅 `caseIds`（无 `specHash`）。
- counter 契约用 `parseSpecs` 核对候选 `counter.md` 哈希与契约，过期/不匹配 fail closed，文案“验收基线待独立维护”。
- 报告读 `reportDir/results.json`（HTML 与 trace 也保留）；单次只跑一个 project。用例标题从 `spec.title` 提取前导 case ID（`test` 对象无 title）。
- 门禁要求非零用例、零 skip/flaky/unexpected/error，且**每条实际 result 均 `passed` 且 `retry=0`，`expectedStatus` 不为 `failed`**；`expected`（预期失败）不视为验收成功。实际执行的 `caseIds` 集合必须与契约完全一致。
- 每次执行使用唯一子目录（`run-<时间戳>-<序号>`），避免误读历史 `results.json`，同时保留旧 attempt 证据。
- 每次实际运行写 `browser-gate-receipt.json`，绑定 `project`、`reqId/specHash`（可得时）、`displayVersion`、套件指纹、Node/platform、结果与报告/日志路径。`displayVersion` 只表示构建展示版本，不代替候选代码 `candidateTreeSha` 或 `sourceMainSha`。
- Worker 在浏览器成功后、`commit/push/createPR` 前再做一次 fresh `checkCurrent`；浏览器执行期间 `origin/main` 漂移会返回 `stale`，不发布过期代码。
- Worker 的浏览器证据放在独立持久目录 `runDir/browser/worker/<jobId>`，成功清理临时作业后报告、回执和冻结套件仍可读；PR 验证项包含 `browser`，并带该报告路径。独立 Worker 证据 `browser-gate.json` 保留 `candidateTreeSha` 与 `sourceMainSha`。临时 `HOME/TMPDIR`、模型 agent 目录与缓存仍随作业清理。

## 6. 独立测试基线维护与恢复

- Worker 仅保留 `src/**` 写权限；可信验收套件来自**已部署控制器的受管 `tests/e2e` 与固定 `playwright.config.ts`**（`WorkerDeps.browserE2eRoot`，默认当前控制器工作树），不是候选 `sourceMainSha` 快照，避免把测试基线锁死在旧请求 SHA。
- 候选构建与需求文档来自固定代码快照；两者来源分离。
- docs-only 需求合入 `main` 使 `counter.md` 哈希变化后，需由独立测试作者维护 `tests/e2e/contracts/counter.json` 的 `specHash/caseIds` 并更新控制器版本，再显式 retry 原请求；固定候选 `sourceMainSha` 不变也能采用新审查的验收资产。
- 不自动生成或刷新预期哈希。基线恢复以测试作者提供的契约为准；控制器只核对并记录指纹（`computeE2eSuiteFingerprint`），不代写。

## 7. 当前平台局限

- 隔离依赖 macOS `sandbox-exec`；缺失隔离、缺失浏览器缓存、缺失 `@playwright/test` CLI 或 `playwright.config.ts` 时明确 fail closed，不退回无隔离执行。
- 原生工具外层默认 sandbox `EPERM` 属环境限制，保留失败；真实受控验收由主 Agent 在授权环境代跑。
- 浏览器验证仅在准备阶段下载匹配 revision，验证阶段不下载；缺匹配 revision 时报告等待主 Agent 受控安装。
