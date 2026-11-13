# 实施与演示计划

文档日期：2026-11-14。状态：开发设计草案，未开始实施。

当前以 [飞书 Demo 开发计划](demo-plan.md) 作为范围和开发顺序入口。本文件保留完整方案参考，不要求先完成所有扩展设计再开始 Demo。

本计划依据 [需求与验收](requirements.md) 和 [架构与运行契约](architecture.md)。当前只有文档，下面的 npm 命令均为待实现接口，不能直接作为现有功能执行。

## 1. 目标文件结构

在用户给定的最小结构上补充测试、恢复与隔离模块，避免把真实闭环依赖隐藏在 Prompt 中：

```text
.
├── AGENTS.md
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── .gitignore
├── orchestrator.config.example.json
├── docs/
│   ├── development/
│   │   ├── requirements.md
│   │   ├── architecture.md
│   │   └── implementation-plan.md
│   └── specs/
│       └── counter.md
├── src/
│   ├── main.ts
│   ├── counter.ts
│   ├── error-boundary.ts
│   ├── error-reporter.ts
│   ├── style.css
│   └── counter.test.ts
├── orchestrator/
│   ├── index.ts
│   ├── init.ts
│   ├── specs.ts
│   ├── reconciler.ts
│   ├── github.ts
│   ├── git.ts
│   ├── state.ts
│   ├── scheduler.ts
│   ├── pi-runner.ts
│   ├── sandbox.ts
│   ├── error-server.ts
│   ├── triage.ts
│   ├── deploy.ts
│   ├── log.ts
│   ├── extensions/role-tools.ts
│   └── prompts/
│       ├── planner.md
│       ├── worker.md
│       └── triage.md
└── tests/
    ├── specs.test.ts
    ├── reconciliation.test.ts
    ├── isolation.test.ts
    ├── recovery.test.ts
    ├── error-server.test.ts
    ├── deployment.test.ts
    └── fixtures/
```

根 `AGENTS.md` 保留中文、需求权威顺序、三角色禁止项、无自动 Merge、失败不静默、不得改依赖与验证配置，以及实现/独立评审分离。角色 Prompt 引用这些规则，但具体产品行为仍只能来自需求文档。

## 2. 预期脚本接口

| 命令 | 行为 | 是否可能写 GitHub |
| --- | --- | --- |
| `npm run demo:init` | 预检、选择/绑定已有远程、创建所需标签、隔离探针、Pi 真实小型冒烟、初次构建 | 是：创建缺失标签；不改需求或建任务 |
| `npm run demo` | 同时启动编排器、错误 HTTP、稳定预览服务；首次执行 bootstrap | 是：按三个闭环运行 |
| `npm run dev` | 人工开发用 Vite，端口 5174 | 否 |
| `npm run typecheck` | 检查前端及编排器类型 | 否 |
| `npm test` | Node 原生测试及受控临时仓库检查，默认禁止真实外部写入 | 否 |
| `npm run build` | 构建前端静态产物 | 否 |
| `npm run demo:status` | 展示绑定仓库、游标、作业、PR、部署 SHA、待同步失败 | 否 |
| `npm run demo:retry -- --issue N` | 读取失败阶段，按执行预算重试该阶段；部署失败只重试部署 | 是 |
| `npm run demo:recover` | 检查旧进程、远端操作与未完成作业，恢复安全的本地索引 | 可能：补写已确定操作的状态 |

`demo:init` 至少执行 `gh auth status`、`pi --version`，并核对仓库权限、默认分支、工具白名单、模型配置与调用可用性。检查不通过给出具体缺项，不偷偷安装全局软件、创建仓库或更换模型。

标签初始化只创建缺失项，已有标签保持；重复执行无重复标签。首次模型冒烟使用微小固定输入，会消耗已配置模型额度，输出成功/失败，不打印凭据。

## 3. 实施阶段与出口

### P0：验证关键依赖

先验证 Pi 安装版本、无头输出与角色工具机制，建立当前 macOS 的物理隔离最小探针。核对 git/gh 及用户指定远程。新增临时假命令适配器，用于自动化测试，不触发真实 GitHub 写入。

出口：Pi 能通过受控工具执行合法动作；Planner/Worker/Triage 交叉越权写入均失败；验证子进程无法修改宿主其他目录；真实 provider/model 冒烟可用。

若隔离或 Pi API 不满足，停在明确的技术阻塞，并修订设计。不能先把后续功能写完，再把安全要求降级为 Prompt。

### P1：仓库基础与前端夹具

建立 package/lock、固定脚本、忽略规则、全局行为约束与计数器需求。前端提供正常计数、可复现非法步长错误、恢复入口、自动上报、部署版本展示。

出口：类型检查、合法路径行为测试、构建通过；非法输入能确定触发统一上报，网络失败不会递归报错。

### P2：需求解析与 GitHub 对账

实现远端快照、diff、严格 ID 解析、Open/Closed 分页索引、Planner 受控操作、标签状态、操作日志与游标补偿。先验证 create/update/delete/move 及重复事件。

出口：临时仓库/模拟 gh 检查通过；真实 GitHub 上一个示例需求只对应一个主 Issue，重复对账不额外写入。

### P3：Worker 与代码 PR

实现作业 worktree、REQ/Issue 锁、300 秒超时、取消、固定验证、路径门禁、代码提交/push/PR 及失败评论。不同需求也使用全局串行限制，先保证正确性。

出口：真实 Worker 生成只改 `src/` 的 PR，含 `Closes` 和来源证据；修改需求能取消旧作业，过期结果不能发布。

### P4：错误接收与 Triage

实现接收校验、持久入队、去重、错误族预算、部署版本映射、Triage 分类、docs-only PR 与修复子任务。保留无法判断时的人工分诊路径。

出口：相同错误不会批量消耗模型或重复建单；文档缺失走 `spec-patch`，代码违约直接走修复 Issue；不让模型用改文档掩盖实现缺陷。

### P5：人工合并与部署恢复

实现受管 PR 合并轮询、独立构建、release 切换、版本健康检查、失败回滚、done 回执、重启补偿和 `deploy-only` 重试。

出口：守护进程停止期间合并也能补偿；GitHub 已自动关单不影响部署发现；失败不替换旧预览、不重新调度 Worker。

### P6：独立评审与真实演示

实施者提交改动和原始检查证据，独立评审者核对实际代码、路径隔离、状态转换与重启结果，复跑与风险相匹配的测试。评审不以 Agent 自报成功为依据。

真实演示使用用户指定的演示仓库，保留 Issue/PR URL 和 SHA。用户负责人工 Merge。全部验收完成前，不将“本地测试通过”写成“三个闭环已经跑通”。

## 4. 必要检查矩阵

| 检查 | 核心断言 | 对应验收 |
| --- | --- | --- |
| 解析新增/修改/删除/移动 | 只改变目标 REQ，文件移动不重建任务 | AC-02～04 |
| 围栏示例、重复 ID、坏 Markdown | 无假需求、无误删除、整轮阻断 | AC-04 |
| 首次启动、多提交、历史重写 | 无游标也能重建；最终有效快照不漏需求、不按临时快照误建单 | AC-02、10 |
| Issue 超过默认数量、Closed 映射 | 不漏任务；需求修订复用原 Issue | AC-03、08 |
| gh 创建成功后模拟断线 | 从操作键恢复，无重复 Issue/PR/评论 | AC-09、10 |
| 双守护进程、同 REQ 父子任务 | 无并发写入；PID 复用不误抢锁 | AC-10 |
| Worker 超时并残留子进程 | 终止后代才释放锁，Issue 有失败摘要 | AC-09、10 |
| Worker 写 docs、Planner 写 src | 执行前阻断，仓内/宿主文件不变 | AC-11 |
| `../`、绝对路径、symlink 与特殊文件 | 不能逃出作业允许目录 | AC-11 |
| src 测试尝试写宿主目录 | 验证进程同样被隔离 | AC-11 |
| 中途修改需求、旧 PR 误合并 | 不发布过期作业，不标最新版本 done | AC-03、08 |
| 重复错误、边界与全局双捕获 | 同部署一次活动分诊，计数合并 | AC-05 |
| 新版本相同错误、超过修订预算 | 可记录回归；修订预算不因 SHA 重置 | AC-05、09 |
| 非法 HTTP、外部 Origin、大包、队列满 | 对应错误响应，不调用 Pi | AC-09 |
| Triage 缺证据、弱化原验收 | 转人工，不修改有效需求 | AC-05、07 |
| 文档机器人 PR Merge | 触发正常对账，不能被作者过滤 | AC-06 |
| GitHub `Closes` 提前关单 | 仍发现 Merge 并部署，失败可 reopen | AC-08、09 |
| 文档 PR、拒绝 PR | 不产生错误部署或自动重开同 PR | AC-06、09 |
| 部署构建失败、切换后健康失败 | 旧 release 继续服务，重试仅部署 | AC-08、09 |
| 停机期间 Merge、部署后评论前崩溃 | 恢复回执，部署 SHA 一致，无重复动作 | AC-08、10 |
| 主线已满足需求且无源文件差异 | 固定验收和部署证据齐全才走 already-satisfied，不造空 PR | AC-02、10 |

自动化测试默认使用 Node 原生测试、临时 Git 仓库、可控子进程及模拟 gh/Pi。物理隔离探针必须真实执行；GitHub + Pi 冒烟单独显式运行，不能混入每次单元测试。

## 5. 实施后的启动步骤

以下步骤是未来 Runbook；脚本落地后再按实际 CLI 校正，不表示现在能够启动。

### Step 1：准备本地与远程仓库

当前目录尚未初始化 Git。实施阶段需要准备 Node LTS、git、gh、锁定版本 Pi，以及用户指定的 GitHub 演示仓库。远程名称在当前请求中尚未提供，不自动猜测或创建。

在已完成初始化、已有 `origin/main` 的项目中检查：

```bash
cd /Users/sunpcm/code/spec-loop
node --version
npm --version
git status --short --branch
git branch --show-current
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef,url
pi --version
pi --help
```

正常路径为 `main`，远端默认分支也为 `main`。首次代码与示例需求进入远端主线后再启动业务编排，避免空仓库没有基线。

### Step 2：安装并预检

```bash
cd /Users/sunpcm/code/spec-loop
npm ci
npm run typecheck
npm test
npm run build
npm run demo:init
```

按配置示例为各角色填写明确的 provider/model，不在配置中写 API key。`demo:init` 会真实创建缺失标签并做模型冒烟；退出码非零时按缺项处理，不继续演示。

### Step 3：启动编排与预览

```bash
cd /Users/sunpcm/code/spec-loop
npm run demo
```

另开终端：

```bash
curl --fail http://127.0.0.1:4000/api/health
curl --fail http://127.0.0.1:5173/__version
npm run demo:status
```

打开 `http://127.0.0.1:5173`。页面版本须与状态输出一致。首次 bootstrap 对已有示例需求建单并可能触发 Worker；主线已满足需求时允许产出“实现已满足”的校验证据，不制造无意义代码 PR。

### Step 4：演示文档变更 → Issue → 代码 PR

修改 `docs/specs/counter.md`，例如新增明确的“减少”行为及验收，保留 ID。编辑前备份：

```bash
cp docs/specs/counter.md /tmp/spec-loop-counter-before-edit.md
```

确认修改后提交：

```bash
git diff --check
git diff -- docs/specs/counter.md
git add -- docs/specs/counter.md
git commit -m "docs: define counter decrement behavior"
git push origin main
```

显式 push 最适合首次演示；正常运行时满足安全条件的文档提交也可由守护进程推送。观察 `[RECONCILER]`、Issue todo → processing、`[WORKER]`、真实代码 PR 与 in-review。

### Step 5：演示人工 Merge → 自动部署

在 GitHub 检查 PR 的需求哈希、改动路径、测试/构建摘要，再人工 Merge。

观察 `[DEPLOY]`，确认活动页面出现新行为，`/__version` 与部署回执 SHA 一致，Issue 为 done 且关闭。不要用 Worker 临时目录的 Vite 页面代替部署结果。

### Step 6：演示边界缺失 → 文档 PR → 修复

在正式预览页面清空步长后点击增加，触发预置的非法输入异常。观察错误面板的上报状态和 `[ERROR-CATCH]`、`[TRIAGE]`。

确认只创建一个 `spec-patch` 文档 PR，且没有直接修改 src。人工审查边界候选并 Merge 后，观察 A 自动复用主 Issue、Worker 提代码 PR；再人工 Merge 代码 PR，验证新预览能友好处理空输入并保持原有合法行为。

### Step 7：演示文档已规定 → 修复子任务

保留已定义的空输入边界，以单独演示分支准备一个明确违反该条款的代码回归 PR，人工 Merge 后再触发错误。此回归夹具只用于演示，不能由 Triage 自动制造。

确认 Triage 引用现有条款，创建关联父任务的修复 Issue，不提文档补丁。Worker 修复并提 PR，人工 Merge 后独立关闭修复任务，原主任务状态不被错误覆盖。

### Step 8：演示幂等与失败恢复

重复触发相同错误，确认无重复活动 Issue/PR。用 Ctrl-C 停止守护进程，再启动，核对已存在远端对象被复用。

在受控测试模式中注入 Pi 超时、gh 断线或部署失败，检查 failed 标签与评论。恢复后执行：

```bash
npm run demo:status
npm run demo:recover
npm run demo:retry -- --issue <真实失败的Issue编号>
```

最后一行中的占位符必须替换为真实编号。恢复命令须按失败阶段工作，不能将部署失败转成重写代码。

## 6. 交付证据与当前停止点

最终交付需要分开报告：本地类型/测试/构建、独立评审、Git commit/push、真实 GitHub 建单/PR、真实 Pi 调用、人工 Merge、本地部署及浏览器结果。没有执行的项目明确标未验证。

本轮完成目标是上述开发文档。当前未创建应用、运行脚本、正式需求文件或 Agent Prompt；没有初始化 Git、安装 Pi、调用模型、创建 GitHub 对象或启动服务。

实施前需要落实的环境信息：目标 GitHub 仓库、Pi 安装/锁定版本、各角色 provider/model 与认证方式。物理隔离适配是 P0 技术门禁，尚未通过验证。此处记录依赖，不要求在本轮文档阶段逐项确认。
