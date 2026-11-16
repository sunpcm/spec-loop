# 测试与浏览器验收门禁

文档日期：2026-11-16。范围：固定检查、Playwright 生命周期门禁、独立测试基线维护与当前平台局限。

## 1. 分层与职责

验证分两层，缺一不可：

1. **固定可信检查**（禁网只读快照）：`typecheck`、`node:test`、`build`。它们在完全禁网、源/测试/配置只读的 `sandbox-exec` 快照中运行，不使用浏览器。
2. **浏览器验收门禁**（`runBrowserGate`）：父控制器启动固定候选产物的本机静态 HTTP 服务，浏览器测试子进程在**另一个** `sandbox-exec` profile 中运行。它只放行该次候选的本机固定端口，禁止公网、其他本机端口、敏感文件读与源/测试/配置写，不接受任意外站 URL。

两层都通过才允许继续 `commit/push/PR`（Worker 路径）或 `healthCheck/switchPreview/markDeployed`（合并构建路径）。

### 无代码变更验收（satisfied）

当 Worker 的真实候选树与固定来源 `sourceMainSha` 主线树相同（`src` 无任何变更）时，仍必须先走完固定可信检查、独立浏览器门禁与发布前 fresh 校验，全部通过后返回明确终态 `satisfied`，不调用 `commit/push/createPR`，也不做空提交伪造代码交付。该终态不等于已部署的 `done`：

- 持久记录 `reqId/specHash/sourceMainSha/candidateTreeSha` 与本次可信检查/浏览器证据，不能仅凭模型 summary 判成功。
- 无代码变更成功前及浏览器门禁后均 fresh `fetch origin main`；`origin/main` 完整 SHA 必须等于固定 `sourceMainSha`，候选树必须等于 `sourceMainSha^{tree}`。任一步失败或相同需求内容的主线漂移都返回失败/过期。
- 通过 `status:satisfied` 标签与幂等评论回执表示“已验收无需代码变更”，不关闭 Issue、不改 `deploy.activeSha`、不伪造 PR/发布回执。
- satisfied 状态与 `sync-satisfied-receipt` 待补标志必须在同一次 StateStore 更新中落盘，再发外部标签/回执；回执成功后才清除标志。重载后可重查绑定 `reqId/specHash/sourceMainSha/candidateTreeSha` 的幂等评论，响应丢失时补发不重复评论、不重跑 Pi。
- `commands.retry` 对 satisfied 返回中文成功说明，明确没有代码 PR/部署及回执是否待补；面板保留代码确认节待补状态，构建显示无需部署，不把回执未完成显示成已部署。
- 旧 revision 不污染新 revision；新需求仍正常接续。

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

浏览器验收默认只在失败时保留录屏（`SPEC_LOOP_E2E_VIDEO=retain-on-failure`）。需要显式保留成功录屏时加 `--record`，等价 `SPEC_LOOP_E2E_VIDEO=on`；CLI 只接受 `--record`，未知参数直接拒绝。该模式由受控参数注入，父进程任意环境变量都不能悄悄改变它。

```bash
npm run test:e2e -- --record        # counter 成功也保留录屏
npm run test:e2e:panel -- --record  # panel 成功也保留录屏
```

## 4. 隔离边界

门禁沙箱 profile 关键约束：

- `deny network*`，随后仅放行 `(allow network-outbound (remote tcp4 "localhost:<port>"))` 唯一本机端口。写法必须是 `tcp4` + `localhost` + 固定端口；`127.0.0.1` 或 `remote tcp "127.0.0.1:port"` 会编译失败（host 必须为 `*` 或 `localhost`）。
- 浏览器缓存目录精确放行读取，不放开整个真实 `HOME`；源/测试/配置只读，仅作业临时目录可写。
- 所有 `runDir/suiteDir/HOME/TMPDIR/profile` 与返回日志路径统一经 `resolveSeatbeltPath` 落到真实路径；macOS 下 `os.tmpdir()` 返回 `/var/folders/...` 别名时必须匹配 `/private/var/folders/...`，不放开父目录、不移除隔离、不重用原 HOME。
- 环境白名单仅 `PATH/LANG/LC_ALL/NO_COLOR`，注入 `SPEC_LOOP_E2E_BASE_URL`、`SPEC_LOOP_E2E_VERSION`、`SPEC_LOOP_E2E_REPORT_DIR`、`SPEC_LOOP_E2E_VIDEO`（取值固定为 `retain-on-failure` 或 `on`）、`PLAYWRIGHT_BROWSERS_PATH`；不带 GitHub/模型凭据、代理变量或 `.env`，父进程同名环境变量不能覆盖这些受控注入值。
- 静态服务只暴露当前候选 `artifactDir`，拒绝兄弟 `release` 目录与 symlink 逃逸；Host 固定本机，不提供控制器 API。

## 5. 验收契约与报告

- 契约文件 `tests/e2e/contracts/counter.json` 含 `reqId/specPath/specHash/caseIds`；`panel.json` 仅 `caseIds`（无 `specHash`）。
- counter 契约用 `parseSpecs` 核对候选 `counter.md` 哈希与契约，过期/不匹配 fail closed，文案“验收基线待独立维护”。
- 报告读 `reportDir/results.json`（HTML 与 trace 也保留）；单次只跑一个 project。用例标题从 `spec.title` 提取前导 case ID（`test` 对象无 title）。
- 门禁要求非零用例、零 skip/flaky/unexpected/error，且**每条实际 result 均 `passed` 且 `retry=0`，`expectedStatus` 不为 `failed`**；`expected`（预期失败）不视为验收成功。实际执行的 `caseIds` 集合必须与契约完全一致。
- 每次执行使用唯一子目录（`run-<时间戳>-<序号>`），避免误读历史 `results.json`，同时保留旧 attempt 证据。
- 每次实际运行写 `browser-gate-receipt.json`，绑定 `project`、`reqId/specHash`（可得时）、`displayVersion`、套件指纹、Node/platform、结果与报告/日志路径。`displayVersion` 只表示构建展示版本，不代替候选代码 `candidateTreeSha` 或 `sourceMainSha`。
- Worker 在浏览器成功后、`commit/push/createPR` 前再做一次 fresh `checkCurrent`；浏览器执行期间 `origin/main` 漂移会返回 `stale`，不发布过期代码。
- 无代码变更且固定/浏览器/fresh 校验全部通过时返回 `satisfied`，不建 PR；固定或浏览器失败仍返回 `failed`，同需求内容的 `origin/main` 漂移返回 `stale`，均不得伪造 `satisfied`。
- Worker 的浏览器证据放在独立持久目录 `runDir/browser/worker/<jobId>`，成功清理临时作业后报告、回执和冻结套件仍可读；PR 验证项包含 `browser`，并带该报告路径。独立 Worker 证据 `browser-gate.json` 保留 `candidateTreeSha` 与 `sourceMainSha`。临时 `HOME/TMPDIR`、模型 agent 目录与缓存仍随作业清理。
- 固定 `node:test` 与浏览器门禁还会向 `runDir/test-runs`（或面板状态文件目录旁的 `.orchestrator/test-runs`）写入受控 `test-run.json` 证据索引，供本机面板只读展示。记录仅包含索引、摘要、SHA、用例和附件入口；附件按文件名扩展名归类为 `screenshot`、`video`、`trace`、`json`，不读取业务日志或任意外部路径。
- 证据索引与附件有硬性容量/扫描边界：索引最多保留 100 条运行记录、扫描最多 2000 条目录项且深度最多 8 层、单个附件最大 512MiB、单次运行附件预算 1GiB、每个 run 最多 1000 条用例、每份附件列表最多 256 项。附件必须来自本次 report 目录内的普通文件（拒绝 symlink 逃逸与越界路径），复制失败不会留下可点击死链。
- `node:test` 摘要同时支持 Node 24 spec reporter 的 Unicode `ℹ tests/pass/fail/...` 统计块与可选 TAP `#` 统计块，包括 `duration_ms`；只在同一 formatter 的连续 footer 块内读取六个计数，不跨截断或混合块拼凑。计数必须为安全非负整数并满足 `total = pass + fail + cancelled + skipped + todo`；缺字段、零实际用例、unsafe 值或解析失败保持 `unknown`，不得伪补 0 或猜绿。记录索引保留生产者的 unknown，扫描边界内按记录时间选最近项后再应用展示数量。
- 浏览器门禁失败时 `runBrowserGate` 会在 summary 解析前返回；失败详情改从该 attempt 自己的 `results.json` 读取，不依赖不存在的 `gateResult.summary`。门禁的非零退出、缺报告、校验失败和超时仍判失败，同时尽可能写出对应 `test-run.json`。

## 6. 独立测试基线维护与恢复

- Worker 仅保留 `src/**` 写权限；可信验收套件来自**已部署控制器的受管 `tests/e2e` 与固定 `playwright.config.ts`**（`WorkerDeps.browserE2eRoot`，默认当前控制器工作树），不是候选 `sourceMainSha` 快照，避免把测试基线锁死在旧请求 SHA。
- 候选构建与需求文档来自固定代码快照；两者来源分离。
- docs-only 需求合入 `main` 使 `counter.md` 哈希变化后，需由独立测试作者维护 `tests/e2e/contracts/counter.json` 的 `specHash/caseIds` 并更新控制器版本，再显式 retry 原请求；固定候选 `sourceMainSha` 不变也能采用新审查的验收资产。
- 不自动生成或刷新预期哈希。基线恢复以测试作者提供的契约为准；控制器只核对并记录指纹（`computeE2eSuiteFingerprint`），不代写。

## 7. 当前平台局限

- 隔离依赖 macOS `sandbox-exec`；缺失隔离、缺失浏览器缓存、缺失 `@playwright/test` CLI 或 `playwright.config.ts` 时明确 fail closed，不退回无隔离执行。
- 原生工具外层默认 sandbox `EPERM` 属环境限制，保留失败；真实受控验收由主 Agent 在授权环境代跑。
- 浏览器验证仅在准备阶段下载匹配 revision，验证阶段不下载；缺匹配 revision 时报告等待主 Agent 受控安装。
