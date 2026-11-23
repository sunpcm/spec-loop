# Playwright 独立验收

`counter` project 验收 `REQ-CNT-01`。`panel` project 当前只回归既有浏览器内合成演示和测试证据详情，并绑定已确认的 `REQ-PANEL-01`、路径 `docs/specs/pending/panel.md` 与需求块哈希。这里的 `PANEL-DEMO-*`、`PANEL-EVIDENCE-*` 不代表 #19 的等待说明已经实施或通过；把这些既有回归归入面板套件是为了让框架选择、契约和产物连续性可核验，等待说明的实际 A1～A8 用例仍待 #19 排期后由独立测试作者补充。

合同 `contracts/counter.json` 与 `contracts/panel.json` 都必须绑定当前需求标识、路径和需求块哈希。规格确认提交、运行来源 SHA 和候选树属于每次执行的证据，不写入需求契约。需求变化后须由维护者更新验收基线，测试不能自动刷新哈希。

面板业务门禁还要求可选 `acceptanceCases` 把所选规格的每条验收 A1…An 映射到真实执行的 caseId。不同验收可以复用同一个真实 caseId，同一验收的数组内不得重复。手动或框架冒烟可以只运行 `caseIds`，但 Worker 与合并构建的业务门禁在映射缺失、覆盖规格外验收、未覆盖规格验收项或映射用例没有真实通过时必须 fail closed。当前真实 `panel.json` 保留已确认哈希和既有冒烟 caseIds，不预填尚不存在的 #19 A1～A8 映射，因此本轮的冒烟套件不能单独把面板需求标成业务成功。

协调器启动静态测试服务后，通过 `SPEC_LOOP_E2E_BASE_URL` 提供本机 IPv4 地址及端口，地址可含 `/releases/<sha>/`；各项 `page.goto('./')` 使用相对路径保留前缀。两个项目分别由协调器提供对应 artifact。`SPEC_LOOP_E2E_VERSION` 为计数器页面的预期版本，`SPEC_LOOP_E2E_REPORT_DIR` 保存顶层 JSON、HTML、截图和失败 trace；协调器每次只选择一个 project，并为各项目使用独立报告目录。

配置只使用 Chromium 和 `127.0.0.1`，拒绝无端口地址、IPv6、公网地址及 URL 凭据；单 worker、零重试，固定 `retries=0`、`workers=1`、`forbidOnly=true`、`failOnFlakyTests=true`，设置全局、单测、动作及导航超时；不设 `webServer`。trace 和截图仅保留失败证据；视频默认 `retain-on-failure`，只有受控环境显式设置 `SPEC_LOOP_E2E_VIDEO=on` 时全程录制，其他值在启动测试前拒绝；配置读取自身不触发录屏。面板测试先进入合成模式、再监听操作期间的请求，不把提前拦截 API 当作不发 API 的证据。测试证据用例使用明确标记的固定 API 响应校验展示状态，并用真实服务响应核对附件；不将夹具称为已执行 run。面板索引页本身无法证明首页所链接的版本化页面，需由协调器独立核对。
