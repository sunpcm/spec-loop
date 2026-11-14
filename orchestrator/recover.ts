import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { GitClient } from './git.ts';
import { acquireInstanceLock } from './lock.ts';
import { createCore, resolveRepoFromOrigin } from './runtime.ts';
import { reconcileOnce, type ReconcileSummary } from './scheduler.ts';
import type { OrchestratorState } from './types.ts';

/** 将残留 processing 作业标记为 failed，等待显式重试；返回被标记数量。 */
export function markInterruptedJobsFailed(state: OrchestratorState): number {
  let invalidated = 0;
  for (const job of Object.values(state.jobs)) {
    if (job.status === 'processing') {
      job.status = 'failed';
      job.failureStage = 'recover';
      job.resumeAction = 'worker';
      job.updatedAt = new Date().toISOString();
      invalidated += 1;
    }
  }
  return invalidated;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const git = new GitClient();
  const repo = config.repo ?? (await resolveRepoFromOrigin(git, config.repoDir));

  const lock = acquireInstanceLock(join(config.runDir, 'daemon.lock'));
  if (!lock.acquired) {
    process.stderr.write(`无法恢复：${lock.reason ?? '已有实例运行'}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    if (!repo) {
      process.stderr.write('未绑定仓库，无法恢复\n');
      process.exitCode = 1;
      return;
    }

    const core = createCore(config, repo);

    const existingRepo = core.state.snapshot().repo;
    if (existingRepo && existingRepo !== repo) {
      core.logger.error(`状态文件已绑定仓库 ${existingRepo}，与目标 ${repo} 不一致，拒绝恢复`);
      process.exitCode = 1;
      return;
    }

    let summary: ReconcileSummary | null;
    try {
      summary = await reconcileOnce(core.reconcileContext);
    } catch (error) {
      core.logger.error(`对账失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    if (!summary) {
      core.logger.error('本轮未能完成对账（需求解析失败、游标不可解析或网络不可用），未执行作业失效标记');
      process.exitCode = 1;
      return;
    }
    core.logger.info(`对账完成，主线 SHA: ${summary.targetMainSha}，操作数: ${summary.ops.length}`);

    const { result } = await core.state.update((s) => {
      const invalidated = markInterruptedJobsFailed(s);
      return { invalidated };
    });
    core.logger.info(`已标记 ${result.invalidated} 个中断作业为 failed（可显式重试）`);
  } finally {
    lock.release();
  }
}

if (import.meta.main) void main();
