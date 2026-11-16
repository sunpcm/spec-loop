# Playwright 独立验收

`counter` project 验收 `REQ-CNT-01`，`panel` project 验收浏览器内合成演示。合同 `contracts/counter.json` 只列计数器 caseId，并绑定当前需求标识、路径和需求块哈希；`contracts/panel.json` 只列面板演示 caseId，不带规格哈希。需求变化后须由维护者更新验收基线，测试不能自动刷新哈希。

协调器启动静态测试服务后，通过 `SPEC_LOOP_E2E_BASE_URL` 提供本机 IPv4 地址及端口，地址可含 `/releases/<sha>/`；各项 `page.goto('./')` 使用相对路径保留前缀。两个项目分别由协调器提供对应 artifact。`SPEC_LOOP_E2E_VERSION` 为计数器页面的预期版本，`SPEC_LOOP_E2E_REPORT_DIR` 保存顶层 JSON、HTML、截图和失败 trace；协调器每次只选择一个 project，并为各项目使用独立报告目录。

配置只使用 Chromium 和 `127.0.0.1`，拒绝无端口地址、IPv6、公网地址及 URL 凭据；单 worker、零重试，固定 `retries=0`、`workers=1`、`forbidOnly=true`、`failOnFlakyTests=true`，设置全局、单测、动作及导航超时；不设 `webServer`。面板测试先进入合成模式、再监听操作期间的请求，不把提前拦截 API 当作不发 API 的证据。面板索引页本身无法证明首页所链接的版本化页面，需由协调器独立核对。
