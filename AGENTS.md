# 项目协作与运行约束

始终使用中文沟通。当前范围：`docs/development/demo-plan.md` 的第一轮阶段 1～4；暂不实现 Triage/错误自愈。

## 权威与角色

- 前端产品行为唯一来源为已推送 main 的 `docs/specs/*.md`；Issue/PR 是派生执行记录。
- 主 Agent 负责架构、独立评审、Git 集成与真实链路验收；实施子 Agent 负责其任务说明指定的代码、测试和交付报告。
- 实施节点仅修改指定 worktree 和文件范围；不 commit/push/merge、不操作远端、不读取凭据，不自行扩大范围。
- 运行时 Planner 只输出任务计划，Worker 只输出 src 文件变更；控制器验证路径、需求版本和检查结果后执行 git/gh。任何 Agent 不得自动 Merge。
- 模型路由按用户本次授权：workbuddy/deepseek-v4-pro、workbuddy/deepseek-v4.1-flash、zcode/GLM-5.3、zcode/GLM-5.3-Flash；四者均失败才回退内置 GPT。调用失败不丢弃 WIP，后续有界复检、可用后切回。

## 第一轮最小保障

- 单仓库、单操作者、单 Pi 作业；同需求最多一个活动交付；状态更新串行落盘。
- 子进程使用环境白名单；测试/构建不获得 GitHub/模型凭据；Pi 不获得 GitHub 凭据。
- 不以 Prompt 或 worktree 单独宣称物理隔离；真实启动验证隔离能力，不可用时明确停止 Agent 执行。
- 需求更新使旧交付过期；固定主线与需求版本，不发布过期代码。
- 模型输出不等于执行成功；固定类型检查、测试、构建及部署健康检查通过后才记录完成。
- `Closes #N` 合并自动关闭 Issue 不代表部署成功；部署失败保留旧预览，重试只恢复失败阶段。
- 原始秘密、`.env`、运行缓存和评审目录不得入 Git。飞书通知失败不得打断 GitHub 主链路。

## 检查与证据

实施交付需明确源码范围、实际执行的命令/退出码、失败及未验证外部依赖。主 Agent 独立执行 `npm run typecheck`、`npm test`、`npm run build` 并核对关键权限/版本/恢复路径。

没有数据库或外部业务测试库；测试使用临时 Git 仓库及模拟 gh/Pi/飞书。真实 GitHub/Pi/飞书验收由主 Agent 在本任务授权范围执行，人工 Merge 由用户完成。

评审提示与报告保存在 `.review/`，不被 Git 跟踪；实施时遵循任务说明的文件所有权，不读取其他节点私有评审探针。
