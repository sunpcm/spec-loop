import { retryDeployForIssue, type DeployDeps } from './deploy.ts';
import type { FeishuActorContext, FeishuCommands } from './feishu-contract.ts';
import { HELP_TEXT } from './feishu-help.ts';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import { redact, type Logger } from './log.ts';
import type { MergeService } from './merge.ts';
import {
  retryWithBaseline,
  type RetryBaselineDeps,
  type RetryBaselineHooks,
} from './retry-baseline.ts';
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
  retryBaselineHooks?: RetryBaselineHooks;
  /** runtime 的同一生产依赖对象；显式重试、启动恢复和 runOnce 共用可信资产根。 */
  retryBaselineDeps?: RetryBaselineDeps;
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
      if (!deps.repoDir || !deps.git) {
        return `#${issueNumber} 当前控制器缺少仓库/Git 固定快照入口，拒绝未受控重试`;
      }
      const currentRequest = Object.entries(deps.state.snapshot().requirements)
        .find(([, requirement]) => requirement.issueNumber === issueNumber);
      const currentJob = currentRequest
        ? Object.values(deps.state.snapshot().jobs)
          .filter((job) =>
            job.reqId === currentRequest[0] &&
            job.issueNumber === issueNumber &&
            job.specHash === currentRequest[1].specHash &&
            job.sourceMainSha === currentRequest[1].sourceMainSha,
          )
          .sort((a, b) => a.attempt - b.attempt || (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
          .at(-1)
        : undefined;
      if (currentJob?.status === 'satisfied') {
        return `#${issueNumber} 已验收无需代码变更，未创建代码 PR、未部署；GitHub 回执${currentJob.resumeAction === 'sync-satisfied-receipt' ? '待补，控制器会恢复回执，不会重跑 Pi' : '已完成'}`;
      }
      if (
        currentJob?.status === 'failed' &&
        currentJob.failureStage === 'deploy' &&
        currentJob.resumeAction === 'deploy-only'
      ) {
        const deployResult = await retryDeployForIssue(deps.deploy, issueNumber, currentJob.prNumber);
        return deployResult.status === 'deployed'
          ? `已重新部署 #${issueNumber}`
          : `重试部署 #${issueNumber} 失败: ${deployResult.error ?? '无待部署合并'}`;
      }
      if (currentJob && currentJob.status !== 'failed') {
        return `#${issueNumber} 当前状态 ${currentJob.status}，仅失败任务可重试`;
      }
      if (!currentJob) return `#${issueNumber} 无失败任务记录，不重跑`;
      if (!deps.retryWorker) {
        return `#${issueNumber} Worker 重试生命周期未接线，拒绝直接重跑，等待 runtime 接入统一作业入口`;
      }
      if (typeof deps.github.listIssues !== 'function' ||
          typeof deps.github.listPRs !== 'function' ||
          typeof deps.github.updateIssueBody !== 'function' ||
          typeof deps.github.branchExists !== 'function') {
        return `#${issueNumber} 当前控制器缺少 Issue/PR 只读或 Issue 更新能力，拒绝未受控重试`;
      }
      const baselineDeps = deps.retryBaselineDeps ?? {
        repoDir: deps.repoDir,
        state: deps.state,
        git: deps.git,
        github: deps.github,
        logger: deps.logger,
        retryWorker: deps.retryWorker,
        // 直接 createCommands 的调用没有部署控制器资产根，准备必须 fail closed。
        retryDeploy: async () => ({ status: 'failed' as const, error: '重试部署未接线' }),
        mainBranch,
        hooks: deps.retryBaselineHooks,
      };
      let baselineMessage: string;
      try {
        baselineMessage = await retryWithBaseline(baselineDeps, issueNumber);
      } catch (error) {
        return `#${issueNumber} 重试受控准备失败: ${boundedStatusText(error instanceof Error ? error.message : String(error))}`;
      }
      return baselineMessage;
    },
  };
}

function boundedStatusText(text: string): string {
  const safe = redact(text).replace(/\s+/g, ' ').trim();
  return safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
}
