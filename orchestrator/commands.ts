import { retryDeployForIssue, type DeployDeps } from './deploy.ts';
import type { FeishuActorContext, FeishuCommands } from './feishu-contract.ts';
import { HELP_TEXT } from './feishu-help.ts';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import { redact, type Logger } from './log.ts';
import type { MergeService } from './merge.ts';
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
  requireSpec?: (description: string, messageId: string) => Promise<string>;
  retrySpec?: (requestId: string) => Promise<string>;
  mergeService?: Pick<MergeService, 'preflight' | 'confirm'> | null;
}

export function createCommands(deps: CommandsDeps): FeishuCommands {
  const mainBranch = deps.mainBranch ?? 'main';

  return {
    async status(): Promise<string> {
      const state = deps.state.snapshot();
      const jobs = Object.values(state.jobs)
        .map((j) => `#${j.issueNumber}:${j.status}`)
        .join(', ');
      const specLines = Object.values(state.specRequests ?? {})
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .slice(0, 5)
        .map((r) => {
          const next =
            r.stage === 'stale'
              ? ' 请重新发送需求'
              : r.stage === 'failed' || r.stage === 'pi' || r.stage === 'write' || r.stage === 'push' || r.stage === 'pr'
                ? ` 恢复命令:重试需求 ${r.requestId}`
                : '';
          const error = r.error ? ` 错误:${boundedStatusText(r.error)}` : '';
          return `请求 ${r.requestId} ${r.stage}${r.prUrl ? ` ${r.prUrl}` : ''}${error}${next}`;
        })
        .join('\n');
      const latestMerge = Object.values(state.mergeRequests ?? {})
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .at(0);
      return [
        `仓库: ${state.repo ?? '未绑定'}`,
        `游标 SHA: ${state.cursorMainSha ?? '-'}`,
        `部署 SHA: ${state.deploy.activeSha ?? '-'}`,
        `需求任务: ${Object.keys(state.requirements).length}`,
        `作业: ${jobs || '-'}`,
        specLines ? `需求请求:\n${specLines}` : '需求请求: -',
        latestMerge
          ? `最近合并: PR #${latestMerge.prNumber} ${latestMerge.stage}${latestMerge.result ? ` ${latestMerge.result}` : ''}`
          : '最近合并: -',
      ].filter(Boolean).join('\n');
    },

    async help(): Promise<string> {
      return HELP_TEXT;
    },

    async require(description: string, messageId?: string): Promise<string> {
      if (!deps.requireSpec) {
        return '需求入口尚未接线，等待 runtime 接入';
      }
      return deps.requireSpec(description, messageId ?? '');
    },

    async retryRequirement(requestId: string): Promise<string> {
      if (!deps.retrySpec) {
        return '需求重试尚未接线，等待 runtime 接入';
      }
      return deps.retrySpec(requestId);
    },

    async merge(prNumber: number, context?: FeishuActorContext): Promise<string> {
      if (!deps.mergeService) {
        return '合并入口尚未接线，等待 runtime 接入';
      }
      return deps.mergeService.preflight(prNumber, context);
    },

    async confirmMerge(
      prNumber: number,
      confirmationCode: string,
      context?: FeishuActorContext,
    ): Promise<string> {
      if (!deps.mergeService) {
        return '合并入口尚未接线，等待 runtime 接入';
      }
      return deps.mergeService.confirm(prNumber, confirmationCode, context);
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

function boundedStatusText(text: string): string {
  const safe = redact(text).replace(/\s+/g, ' ').trim();
  return safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
}
