# Spec Loop

基于 GitHub + Pi Coding Agent 的本地文档驱动开发演示：需求文档变更生成任务，Agent 编码并提 PR，前端报错推动文档修订或代码修复，人工合并后自动部署本地预览。

目标 GitHub 仓库：[sunpcm/spec-loop](https://github.com/sunpcm/spec-loop)，clone URL：`https://github.com/sunpcm/spec-loop.git`。仓库已由用户指定，尚未配置本地 origin。

**当前阶段：已选择飞书，按 Demo 计划推进，尚未开始编码。应用、守护进程及 npm 脚本均未实现。**

## 开发文档

| 文档 | 内容 |
| --- | --- |
| [飞书 Demo 开发计划（当前入口）](docs/development/demo-plan.md) | 最小范围、六个开发阶段、第一个可展示里程碑与完整 Demo 验收 |
| [需求与验收](docs/development/requirements.md) | 目标、三个闭环、需求文档格式、演示场景、验收标准 |
| [架构与运行契约](docs/development/architecture.md) | Agent 权限、GitHub 映射、状态机、幂等恢复、错误接收、部署 |
| [实施与演示计划](docs/development/implementation-plan.md) | 文件职责、阶段划分、检查矩阵、实施后的启动与录屏步骤 |

先读飞书 Demo 开发计划；原三份文档作为需求和扩展设计参考。

## 文档边界

- 实施后，`docs/specs/*.md` 是前端产品行为的唯一事实来源；Issue 和 PR 只承载执行任务与证据。
- `docs/development/` 描述系统如何运行，不作为 Planner 的产品需求输入。
- 当前设计中的默认选择属于实施建议，不代表已完成实现或真实链路验收。
- 本轮只新增开发文档；未初始化 Git、创建远程仓库、调用 Pi 或写入 GitHub。

首次检查时，当前目录为空且未初始化 Git，shell 未找到 `pi`；能够找到 Node、npm、git 和 gh。现已写入开发文档，并只读确认目标 GitHub 仓库默认分支名为 main、Issues 已启用、分支列表为空。本地 gh 登录、Git 关联、Pi 模型与认证仍需在实施阶段检查。
