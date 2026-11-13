import { retryDeployForIssue, type DeployDeps } from './deploy.ts';
import type { FeishuCommands } from './feishu-contract.ts';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import type { Logger } from './log.ts';
import { parseSpecs } from './specs.ts';
import type { StateStore } from './state.ts';
import type { WorkerDeps, WorkerInput, WorkerOutcome } from './worker.ts';

export interface CommandsDeps {
  repoDir: string;
  state: StateStore;
  github: GithubClient;
  git: GitClient;
  logger: Logger;
  deploy: DeployDeps;
  worker: WorkerDeps;
  /**
   * 重试的统一作业生命周期入口（由 runtime 接到 runOneWorker）。
   * 未接线时 Worker 重试明确拒绝，避免绕过 job/PR 状态管理直接重跑。
   */
  retryWorker?: (input: WorkerInput) => Promise<WorkerOutcome>;
  mainBranch?: string;
}

export function createCommands(deps: CommandsDeps): FeishuCommands {
  const mainBranch = deps.mainBranch ?? 'main';

  return {
    async status(): Promise<string> {
      const s = deps.state.snapshot();
      const jobs = Object.values(s.jobs)
        .map((j) => `#${j.issueNumber}:${j.status}`)
        .join(', ');
      return [
        `仓库: ${s.repo ?? '未绑定'}`,
        `游标 SHA: ${s.cursorMainSha ?? '-'}`,
        `部署 SHA: ${s.deploy.activeSha ?? '-'}`,
        `需求任务: ${Object.keys(s.requirements).length}`,
        `作业: ${jobs || '-'}`,
      ].join('\n');
    },

    async retry(issueNumber: number): Promise<string> {
      const s = deps.state.snapshot();
      const reqEntry = Object.entries(s.requirements).find(([, r]) => r.issueNumber === issueNumber);
      const jobsForIssue = Object.values(s.jobs).filter((j) => j.issueNumber === issueNumber);
      // 只在当前需求版本（specHash+sourceMainSha 一致）内挑 latest job；
      // attempt 在新版本会重置，跨版本按 attempt 比较会让旧版本遮盖新版本。
      const currentJobs = reqEntry
        ? jobsForIssue.filter(
            (j) => j.specHash === reqEntry[1].specHash && j.sourceMainSha === reqEntry[1].sourceMainSha,
          )
        : jobsForIssue;
      const job = currentJobs
        .sort((a, b) => a.attempt - b.attempt || (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
        .at(-1);

      if (!job) return `#${issueNumber} 无失败任务记录，不重跑`;
      if (job.status !== 'failed') {
        return `#${issueNumber} 当前状态 ${job.status}，仅失败任务可重试`;
      }

      if (job.failureStage === 'deploy' && job.resumeAction === 'deploy-only') {
        const res = await retryDeployForIssue(deps.deploy, issueNumber, job.prNumber);
        return res.status === 'deployed'
          ? `已重新部署 #${issueNumber}`
          : `重试部署 #${issueNumber} 失败: ${res.error ?? '无待部署合并'}`;
      }

      if (!reqEntry) return `#${issueNumber} 无受管任务，不当作代码任务重跑`;
      if (!deps.retryWorker) {
        return `#${issueNumber} Worker 重试生命周期未接线，拒绝直接重跑，等待 runtime 接入统一作业入口`;
      }

      const [reqId, req] = reqEntry;
      await deps.git.fetch(deps.repoDir, mainBranch);
      const files = await deps.git.readSpecSnapshot(deps.repoDir, `origin/${mainBranch}`);
      const parsed = parseSpecs(files);
      const spec = parsed.specs.find((sp) => sp.id === reqId);
      if (!spec) return `#${issueNumber} 需求快照不存在`;
      if (spec.hash !== req.specHash || req.specHash !== job.specHash || req.sourceMainSha !== job.sourceMainSha) {
        return `#${issueNumber} 需求版本与任务基线不一致，等待对账后重试`;
      }

      const jobId = `retry-${issueNumber}-${Date.now()}`;
      const input: WorkerInput = {
        jobId,
        reqId,
        issueNumber,
        spec,
        sourceMainSha: req.sourceMainSha,
        attempt: job.attempt + 1,
      };
      const outcome = await deps.retryWorker(input);
      return outcome.status === 'published'
        ? `#${issueNumber} 已重新进入 review（PR #${outcome.prNumber}）`
        : `#${issueNumber} 重试失败: ${outcome.error ?? outcome.status}`;
    },
  };
}
