import { loadConfig } from './config.ts';
import { latestDispatchRevision } from './dispatch-task.ts';
import { GitClient } from './git.ts';
import { createCore, resolveRepoFromOrigin } from './runtime.ts';
import type { OrchestratorState } from './types.ts';

/** 展示每张任务卡当前冻结的最后一个版本，旧版本仍保留在 state 历史中。 */
export function dispatchRevisionStatus(state: OrchestratorState): string {
  const reqIds = Object.keys(state.requirements).sort();
  if (reqIds.length === 0) return '当前任务版本: -';
  const lines = reqIds.map((reqId) => {
    try {
      const revision = latestDispatchRevision(state, reqId);
      if (!revision) return `- ${reqId}: 未冻结（兼容旧交付）`;
      const published = revision.publishedAt ? ` · 发布 ${revision.publishedAt}` : '';
      return [
        `- ${reqId}: r${revision.revision}`,
        `Issue #${revision.issueNumber}`,
        `规格 ${revision.specHash.slice(0, 8)}`,
        `来源 ${revision.sourceMainSha.slice(0, 8)}${published}`,
      ].join(' · ');
    } catch {
      return `- ${reqId}: 版本记录非法，暂停交付`;
    }
  });
  return `当前任务版本:\n${lines.join('\n')}`;
}

export function appendDispatchRevisionStatus(
  statusText: string,
  state: OrchestratorState,
): string {
  return `${statusText.trimEnd()}\n${dispatchRevisionStatus(state)}\n`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const git = new GitClient();
  const repo = config.repo ?? (await resolveRepoFromOrigin(git, config.repoDir));
  const core = createCore(config, repo);
  const text = await core.commands.status();
  process.stdout.write(appendDispatchRevisionStatus(text, core.state.snapshot()));
}

if (import.meta.main) void main();
