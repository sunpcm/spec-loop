import { createHash, randomBytes } from 'node:crypto';
import type { FeishuActorContext } from './feishu-contract.ts';
import type { GitClient } from './git.ts';
import { extractMeta, type GhResult, type GithubClient } from './github.ts';
import { redact, type Logger } from './log.ts';
import { parseSpecs } from './specs.ts';
import type { StateStore } from './state.ts';
import type {
  JobState,
  MergePrType,
  MergeRequestStage,
  MergeRequestState,
  Spec,
} from './types.ts';
import { buildWorkerBranchName } from './worker.ts';

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/i;
const CODE_RE = /^[0-9a-f]{8}$/;
const MAX_ERROR_LENGTH = 320;
const TARGET_SPEC_PATH = 'docs/specs/counter.md';
const MERGED_RESULT = '已合并，后续编码/部署处理中';
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headRef: string;
  headSHA: string;
  headRepo: string;
  baseRef: string;
  baseSHA: string;
  baseRepo: string;
  mergeCommitSha?: string;
  url: string;
  changedFiles: number;
}

interface PullFile {
  filename: string;
  status: string;
  previousFilename?: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface RawDiffEntry {
  oldMode: string;
  newMode: string;
  status: string;
  path: string;
}

interface CheckEvidence {
  summary: string;
  localValidation: string;
  zeroRemoteChecks: boolean;
}

interface ManagedEvidence {
  type: MergePrType;
  checks: CheckEvidence;
}

interface CurrentSpecSnapshot {
  mainSha: string;
  specs: Spec[];
}

export interface MergeServiceDeps {
  repo: string;
  repoDir: string;
  mainBranch?: string;
  state: StateStore;
  git: GitClient;
  github: GithubClient;
  logger: Logger;
  notify?: (text: string) => Promise<void>;
  now?: () => number;
  confirmationCodeFactory?: () => string;
}

class MergeEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeEvidenceError';
  }
}

class ChecksRejectedError extends MergeEvidenceError {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksRejectedError';
  }
}

function boundedError(error: unknown): string {
  const text = redact(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MergeEvidenceError(`${label} 响应不是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MergeEvidenceError(`${label} 缺失或格式非法`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new MergeEvidenceError(`${label} 缺失或格式非法`);
  return value;
}

function requiredInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new MergeEvidenceError(`${label} 缺失或不是有效整数`);
  }
  return value as number;
}

function sha(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!SHA_RE.test(text)) throw new MergeEvidenceError(`${label} 不是完整 40 位 SHA`);
  return text.toLowerCase();
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function mergeKey(repo: string, prNumber: number, context: FeishuActorContext): string {
  return createHash('sha256')
    .update(`${repo}\0${prNumber}\0${context.actorId}\0${context.chatId}\0${context.messageId}`)
    .digest('hex')
    .slice(0, 24);
}

function normalizeContext(context: FeishuActorContext | undefined): FeishuActorContext {
  if (!context) {
    throw new MergeEvidenceError('缺少可信飞书事件上下文，拒绝合并命令');
  }
  const messageId = context.messageId.trim();
  const actorId = context.actorId.trim();
  const chatId = context.chatId.trim();
  if (!messageId || !actorId || !chatId || context.senderType !== 'user') {
    throw new MergeEvidenceError('飞书事件上下文不完整或发送者不是真实 user，拒绝合并命令');
  }
  return { messageId, actorId, chatId, senderType: 'user' };
}

function parsePull(value: unknown, expectedNumber: number): PullRequestDetail {
  const raw = recordValue(value, 'PR');
  const number = requiredInteger(raw.number, 'PR.number', 1);
  if (number !== expectedNumber) throw new MergeEvidenceError(`GitHub 返回了 PR #${number}，不是请求的 #${expectedNumber}`);
  const head = recordValue(raw.head, 'PR.head');
  const base = recordValue(raw.base, 'PR.base');
  const headRepo = recordValue(head.repo, 'PR.head.repo');
  const baseRepo = recordValue(base.repo, 'PR.base.repo');
  const state = requiredString(raw.state, 'PR.state');
  if (state !== 'open' && state !== 'closed') throw new MergeEvidenceError('PR.state 不是 open/closed');
  const mergeable = raw.mergeable === null || typeof raw.mergeable === 'boolean' ? raw.mergeable : undefined;
  if (mergeable === undefined) throw new MergeEvidenceError('PR.mergeable 缺失或格式非法');
  return {
    number,
    title: requiredString(raw.title, 'PR.title'),
    body: typeof raw.body === 'string' ? raw.body : '',
    state,
    draft: requiredBoolean(raw.draft, 'PR.draft'),
    merged: requiredBoolean(raw.merged, 'PR.merged'),
    mergeable,
    mergeableState: requiredString(raw.mergeable_state, 'PR.mergeable_state').toLowerCase(),
    headRef: requiredString(head.ref, 'PR.head.ref'),
    headSHA: sha(head.sha, 'PR.head.sha'),
    headRepo: requiredString(headRepo.full_name, 'PR.head.repo.full_name'),
    baseRef: requiredString(base.ref, 'PR.base.ref'),
    baseSHA: sha(base.sha, 'PR.base.sha'),
    baseRepo: requiredString(baseRepo.full_name, 'PR.base.repo.full_name'),
    mergeCommitSha: SHA_RE.test(optionalString(raw.merge_commit_sha) ?? '')
      ? optionalString(raw.merge_commit_sha)?.toLowerCase()
      : undefined,
    url: requiredString(raw.html_url, 'PR.html_url'),
    changedFiles: requiredInteger(raw.changed_files, 'PR.changed_files'),
  };
}

function parsePullFile(value: unknown): PullFile {
  const raw = recordValue(value, 'PR 文件');
  return {
    filename: requiredString(raw.filename, 'PR 文件 filename'),
    status: requiredString(raw.status, 'PR 文件 status').toLowerCase(),
    previousFilename: optionalString(raw.previous_filename),
  };
}

function parseTreeEntry(value: unknown): TreeEntry {
  const raw = recordValue(value, 'Git tree');
  return {
    path: requiredString(raw.path, 'Git tree path'),
    mode: requiredString(raw.mode, 'Git tree mode'),
    type: requiredString(raw.type, 'Git tree type'),
    sha: requiredString(raw.sha, 'Git tree sha'),
  };
}

function parseRawDiff(output: string): RawDiffEntry[] {
  const parts = output.split('\0');
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const metadata = parts[index] ?? '';
    if (!metadata) break;
    if (!metadata.startsWith(':')) throw new MergeEvidenceError('raw git diff 输出格式非法');
    const path = parts[index + 1];
    if (!path) throw new MergeEvidenceError('raw git diff 缺少文件路径');
    const fields = metadata.slice(1).split(' ');
    if (fields.length !== 5) throw new MergeEvidenceError('raw git diff 元数据字段不完整');
    const [oldMode, newMode, _oldSha, _newSha, status] = fields;
    entries.push({
      oldMode: oldMode ?? '',
      newMode: newMode ?? '',
      status: status ?? '',
      path,
    });
    index += 1;
  }
  return entries;
}

export class MergeService {
  private readonly repo: string;
  private readonly repoDir: string;
  private readonly mainBranch: string;
  private readonly state: StateStore;
  private readonly git: GitClient;
  private readonly github: GithubClient;
  private readonly logger: Logger;
  private readonly notify?: (text: string) => Promise<void>;
  private readonly now: () => number;
  private readonly confirmationCodeFactory: () => string;

  constructor(deps: MergeServiceDeps) {
    this.repo = deps.repo.trim();
    this.repoDir = deps.repoDir;
    this.mainBranch = deps.mainBranch ?? 'main';
    this.state = deps.state;
    this.git = deps.git;
    this.github = deps.github;
    this.logger = deps.logger;
    this.notify = deps.notify;
    this.now = deps.now ?? Date.now;
    this.confirmationCodeFactory =
      deps.confirmationCodeFactory ?? (() => randomBytes(4).toString('hex'));
  }

  async preflight(prNumber: number, rawContext?: FeishuActorContext): Promise<string> {
    let context: FeishuActorContext;
    try {
      context = normalizeContext(rawContext);
      if (!Number.isInteger(prNumber) || prNumber <= 0) throw new MergeEvidenceError('PR 编号必须是正整数');
      if (!this.repo) throw new MergeEvidenceError('仓库未绑定');
    } catch (error) {
      return `拒绝合并：${boundedError(error)}`;
    }

    const existingForMessage = this.recordsForPr(prNumber).find(
      (record) =>
        record.operatorId === context.actorId &&
        record.chatId === context.chatId &&
        record.preflightMessageIds.includes(context.messageId),
    );
    if (existingForMessage) return await this.replayPreflight(existingForMessage);

    const active = this.recordsForPr(prNumber).filter(
      (record) => record.stage === 'confirmable' || record.stage === 'attempted' || record.stage === 'unknown',
    );
    const pending = active.at(-1);
    if (pending) {
      if (pending.operatorId !== context.actorId || pending.chatId !== context.chatId) {
        return this.reject(
          prNumber,
          '该 PR 已有待确认的合并请求，确认码只允许原操作者在绑定会话中使用',
        );
      }
      if (pending.stage !== 'confirmable') return await this.reconcile(pending);
      if (this.isExpired(pending)) {
        await this.markExpired(pending);
        return this.expiredMessage(pending);
      }
      await this.rememberPreflightMessage(pending, context.messageId);
      return this.preflightMessage(pending);
    }

    const merged = this.recordsForPr(prNumber).filter((record) => record.stage === 'merged').at(-1);
    if (merged) return await this.verifyAndReturnMerged(merged);

    try {
      const pr = await this.getPull(prNumber);
      if (pr.merged) {
        await this.validateManagedEvidence(pr, undefined, 'merged');
        this.logger.info(
          `[MERGE] PR #${prNumber} 已合并，受管绑定复核通过 head=${pr.headSHA.slice(0, 8)}`,
        );
        return MERGED_RESULT;
      }
      const current = await this.currentSpecSnapshot();
      const evidence = await this.validateManagedEvidence(pr, current, 'active');
      const finalPr = await this.getPull(prNumber);
      this.assertEvidenceSnapshot(pr, finalPr);

      const code = this.uniqueConfirmationCode();
      const createdAtMs = this.now();
      const createdAt = new Date(createdAtMs).toISOString();
      const record: MergeRequestState = {
        requestId: mergeKey(this.repo, prNumber, context),
        repo: this.repo,
        prNumber,
        prTitle: pr.title,
        prUrl: pr.url,
        type: evidence.type,
        headSHA: pr.headSHA,
        baseSHA: pr.baseSHA,
        operatorId: context.actorId,
        chatId: context.chatId,
        originalMessageId: context.messageId,
        preflightMessageIds: [context.messageId],
        confirmationMessageIds: [],
        confirmationCode: code,
        checksSummary: evidence.checks.summary,
        localValidation: evidence.checks.localValidation,
        stage: 'confirmable',
        createdAt,
        expiresAt: new Date(createdAtMs + CONFIRM_TTL_MS).toISOString(),
        updatedAt: createdAt,
      };

      await this.insertRecord(record);
      this.logger.info(
        `[MERGE] PR #${prNumber} ${evidence.type} 预检通过 head=${pr.headSHA.slice(0, 8)} base=${pr.baseSHA.slice(0, 8)}`,
      );
      return this.preflightMessage(record);
    } catch (error) {
      this.logger.warn(`[MERGE] PR #${prNumber} 预检拒绝 ${boundedError(error)}`);
      return this.reject(prNumber, boundedError(error));
    }
  }

  async confirm(
    prNumber: number,
    rawCode: string,
    rawContext?: FeishuActorContext,
  ): Promise<string> {
    let context: FeishuActorContext;
    try {
      context = normalizeContext(rawContext);
      if (!Number.isInteger(prNumber) || prNumber <= 0) throw new MergeEvidenceError('PR 编号必须是正整数');
      if (!CODE_RE.test(rawCode.toLowerCase())) {
        throw new MergeEvidenceError('确认码必须是 8 位十六进制');
      }
    } catch (error) {
      return `拒绝合并：${boundedError(error)}`;
    }
    const code = rawCode.toLowerCase();
    const record = Object.values(this.state.snapshot().mergeRequests ?? {}).find(
      (candidate) =>
        candidate.repo.toLowerCase() === this.repo.toLowerCase() &&
        candidate.prNumber === prNumber &&
        candidate.confirmationCode === code,
    );
    if (!record) {
      return this.reject(prNumber, '确认码无效或与 PR 不匹配，未执行合并');
    }
    if (record.operatorId !== context.actorId || record.chatId !== context.chatId) {
      return this.reject(prNumber, '确认码绑定其他操作者或会话，拒绝跨人/跨会话使用');
    }
    if (record.stage === 'merged') return await this.verifyAndReturnMerged(record);
    if (record.stage === 'attempted' || record.stage === 'unknown') {
      return await this.reconcile(record);
    }
    if (record.stage === 'failed' || record.stage === 'invalidated') {
      return this.reject(prNumber, record.error ?? '该确认码已失效，请重新预检');
    }
    if (record.stage === 'expired') return this.expiredMessage(record);
    if (this.isExpired(record)) {
      await this.markExpired(record);
      return this.expiredMessage(record);
    }

    let initialEvidence: ManagedEvidence;
    let initialPull: PullRequestDetail;
    try {
      initialPull = await this.getPull(prNumber);
      if (initialPull.merged) {
        this.assertRecordHead(record, initialPull);
        await this.validateManagedEvidence(
          initialPull,
          undefined,
          'merged',
          record.baseSHA,
        );
        if (!initialPull.mergeCommitSha) throw new MergeEvidenceError('已合并 PR 缺少有效 merge commit SHA');
        return await this.finishMerged(record, initialPull.mergeCommitSha);
      }
      const current = await this.currentSpecSnapshot();
      this.assertRecordSnapshot(record, initialPull, current.mainSha);
      initialEvidence = await this.validateManagedEvidence(initialPull, current, 'active');
      if (initialEvidence.type !== record.type) {
        throw new MergeEvidenceError('PR 受管类型与预检记录不一致');
      }
    } catch (error) {
      const message = boundedError(error);
      if (this.looksLikeDrift(error)) {
        await this.markTerminal(record, 'invalidated', message);
      } else {
        await this.rememberAttemptError(record, message);
      }
      this.logger.warn(`[MERGE] PR #${prNumber} 确认前复检拒绝 ${message}`);
      return this.reject(prNumber, `${message}；未执行合并，请重新预检`);
    }

    try {
      await this.markAttempted(record, context.messageId);
    } catch (error) {
      this.logger.error(`[MERGE] PR #${prNumber} attempted 状态落盘失败，拒绝 PUT`);
      return this.reject(
        prNumber,
        `合并尝试状态落盘失败，未调用 GitHub（${boundedError(error)}）`,
      );
    }
    const attempted = this.state.snapshot().mergeRequests?.[record.requestId] ?? record;

    try {
      const finalPull = await this.getPull(prNumber);
      if (finalPull.merged) {
        this.assertRecordHead(attempted, finalPull);
        await this.validateManagedEvidence(
          finalPull,
          undefined,
          'merged',
          attempted.baseSHA,
        );
        if (!finalPull.mergeCommitSha) {
          throw new MergeEvidenceError('已合并 PR 缺少有效 merge commit SHA');
        }
        return await this.finishMerged(attempted, finalPull.mergeCommitSha);
      }
      const finalCurrent = await this.currentSpecSnapshot();
      this.assertRecordSnapshot(attempted, finalPull, finalCurrent.mainSha);
      const finalEvidence = await this.validateManagedEvidence(finalPull, finalCurrent, 'active');
      if (finalEvidence.type !== attempted.type) {
        throw new MergeEvidenceError('PR 受管类型在确认时发生变化');
      }
    } catch (error) {
      const message = boundedError(error);
      if (this.looksLikeDrift(error)) {
        await this.markTerminal(attempted, 'invalidated', message);
      } else {
        // 当前进程已明确知道尚未调用 PUT；恢复可重试状态不会制造重复写。
        // 只有进程在 attempted 落盘与 PUT 之间崩溃时，重启才需按未知结果对账。
        await this.restoreConfirmable(attempted, message);
      }
      this.logger.warn(`[MERGE] PR #${prNumber} PUT 前最终检查失败 ${message}`);
      return this.reject(prNumber, `${message}；未调用 GitHub`);
    }

    const result = await this.github.runApi([
      'api',
      '--method',
      'PUT',
      `repos/${this.repo}/pulls/${prNumber}/merge`,
      '-f',
      `sha=${attempted.headSHA}`,
      '-f',
      'merge_method=merge',
    ]);

    return await this.reconcileAfterPut(attempted, result);
  }

  /** 每轮只读对账 attempted/unknown；不发送任何 PUT，TTL 不阻止恢复旧尝试。 */
  async reconcilePending(): Promise<void> {
    const pending = Object.values(this.state.snapshot().mergeRequests ?? {}).filter(
      (record) => record.stage === 'attempted' || record.stage === 'unknown',
    );
    for (const record of pending) {
      try {
        await this.reconcile(record);
      } catch (error) {
        this.logger.warn(`[MERGE] PR #${record.prNumber} 后台对账失败 ${boundedError(error)}`);
      }
    }
  }

  private recordsForPr(prNumber: number): MergeRequestState[] {
    return Object.values(this.state.snapshot().mergeRequests ?? {})
      .filter(
        (record) =>
          record.prNumber === prNumber &&
          record.repo.toLowerCase() === this.repo.toLowerCase(),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async replayPreflight(record: MergeRequestState): Promise<string> {
    if (record.stage === 'confirmable') {
      if (this.isExpired(record)) {
        await this.markExpired(record);
        return this.expiredMessage(record);
      }
      return this.preflightMessage(record);
    }
    if (record.stage === 'attempted' || record.stage === 'unknown' || record.stage === 'merged') {
      return await this.reconcile(record);
    }
    if (record.stage === 'expired') return this.expiredMessage(record);
    return this.reject(record.prNumber, record.error ?? '该预检记录已失效，请重新发送合并预检');
  }

  private async verifyAndReturnMerged(record: MergeRequestState): Promise<string> {
    try {
      const pr = await this.getPull(record.prNumber);
      this.assertRecordHead(record, pr);
      if (!pr.merged) {
        throw new MergeEvidenceError('已合并记录对应的 PR 当前回读仍为 open，拒绝改写历史合并结论');
      }
      await this.validateManagedEvidence(pr, undefined, 'merged', record.baseSHA);
      return MERGED_RESULT;
    } catch (error) {
      this.logger.warn(`[MERGE] PR #${record.prNumber} 已合并幂等复核失败 ${boundedError(error)}`);
      return this.reject(record.prNumber, `已合并记录无法通过受管绑定复核：${boundedError(error)}`);
    }
  }

  private async reconcile(record: MergeRequestState): Promise<string> {
    try {
      const pr = await this.getPull(record.prNumber);
      this.assertRecordHead(record, pr);
      if (pr.merged) {
        await this.validateManagedEvidence(pr, undefined, 'merged', record.baseSHA);
        if (!pr.mergeCommitSha) throw new MergeEvidenceError('已合并 PR 缺少有效 merge commit SHA');
        return await this.finishMerged(record, pr.mergeCommitSha);
      }
      if (pr.state === 'closed') {
        await this.markTerminal(record, 'failed', 'PR 已关闭但未合并，请重新创建或重新预检');
        return this.reject(record.prNumber, 'PR 已关闭但未合并，不能重发原合并请求');
      }
      await this.markUnknown(record, '远端 PR 仍为 open，之前尝试的结果无法确定；系统不会自动重发 PUT');
      return `合并结果未确定，PR #${record.prNumber} 仍为 open。系统已保留 attempted 记录，只做只读对账，不会重发合并请求。\n${record.prUrl}`;
    } catch (error) {
      const message = boundedError(error);
      await this.markUnknown(record, message);
      this.logger.warn(`[MERGE] PR #${record.prNumber} 只读对账失败 ${message}`);
      return `合并结果暂无法确认，PR #${record.prNumber} 的 attempted 记录已保留；系统只会继续只读对账。\n${record.prUrl}`;
    }
  }

  private async reconcileAfterPut(record: MergeRequestState, result: GhResult): Promise<string> {
    const callTimedOut =
      result.code === 124 ||
      /timeout|timed out|超时/i.test(`${result.stderr}\n${result.stdout}`);
    let response: Record<string, unknown> | null = null;
    let responseError = '';
    if (result.stdout.trim()) {
      try {
        response = recordValue(JSON.parse(result.stdout) as unknown, 'merge');
      } catch (error) {
        responseError = boundedError(error);
      }
    }
    if (result.code !== 0 && !responseError) {
      responseError = this.githubResultError(result);
    }
    const explicitRejection = this.explicitMergeRejection(result, response);

    let pull: PullRequestDetail;
    try {
      pull = await this.getPull(record.prNumber);
      this.assertRecordHead(record, pull);
    } catch (error) {
      const message = responseError || boundedError(error);
      await this.markUnknown(record, message);
      this.logger.warn(`[MERGE] PR #${record.prNumber} PUT 后回读失败 ${message}`);
      return `合并请求已记录为 attempted，但 GitHub 结果回读失败；系统不会重发 PUT。\n${record.prUrl}`;
    }

    if (pull.merged) {
      try {
        await this.validateManagedEvidence(pull, undefined, 'merged', record.baseSHA);
        if (!pull.mergeCommitSha) throw new MergeEvidenceError('已合并 PR 缺少有效 merge commit SHA');
        const responseMerged = response?.merged === true;
        const responseSha = optionalString(response?.sha)?.toLowerCase();
        if (responseMerged && responseSha !== pull.mergeCommitSha) {
          throw new MergeEvidenceError('merge API 响应 SHA 与 PR 回读不一致，结果记为 unknown');
        }
        return await this.finishMerged(record, pull.mergeCommitSha);
      } catch (error) {
        const message = boundedError(error);
        await this.markUnknown(record, message);
        return `GitHub 显示 PR 已合并，但受管绑定仍未完成复核；系统会继续只读对账。\n${record.prUrl}`;
      }
    }

    if (pull.state === 'closed') {
      await this.markTerminal(record, 'failed', 'PR 已关闭但未合并');
      return this.reject(record.prNumber, 'PR 已关闭但未合并，请重新预检');
    }
    if (response?.merged === true) {
      const responseSha = optionalString(response.sha)?.toLowerCase();
      const message =
        !responseSha || !SHA_RE.test(responseSha)
          ? 'merge API 返回 merged=true 但缺少有效 merge sha'
          : 'merge API 返回 merged=true，但 PR 回读仍为 open';
      await this.markUnknown(record, message);
      return `${message}；系统不会重发 PUT，只会继续只读对账。\n${record.prUrl}`;
    }
    if (explicitRejection) {
      await this.markTerminal(record, 'failed', explicitRejection);
      return this.reject(
        record.prNumber,
        `${explicitRejection}；GitHub 已明确拒绝，未重复发送 PUT，请修复后重新预检`,
      );
    }
    if (callTimedOut || response === null || result.code !== 0) {
      const message = responseError || (callTimedOut ? '同步 gh API 调用超时' : 'merge API 响应不完整');
      await this.markUnknown(record, message);
      return `合并结果未确定，PR #${record.prNumber} 仍为 open；系统不会重发 PUT，只会只读对账。\n${record.prUrl}`;
    }

    const message =
      responseError ||
      optionalString(response.message) ||
      (response.merged === false ? 'GitHub 明确拒绝合并' : 'GitHub 未返回 merged=true');
    await this.markTerminal(record, 'failed', message);
    return this.reject(
      record.prNumber,
      `${message}；未重复发送 PUT，请根据 GitHub 提示修复后重新预检`,
    );
  }

  private async validateManagedEvidence(
    pr: PullRequestDetail,
    current: CurrentSpecSnapshot | undefined,
    mode: 'active' | 'merged',
    mergedBaseSHA?: string,
  ): Promise<ManagedEvidence> {
    const stateRepo = this.state.snapshot().repo;
    if (!stateRepo || !sameRepo(stateRepo, this.repo)) {
      throw new MergeEvidenceError('state 仓库绑定与当前控制器仓库不一致');
    }
    if (!sameRepo(pr.headRepo, this.repo) || !sameRepo(pr.baseRepo, this.repo)) {
      throw new MergeEvidenceError('拒绝 fork 或跨仓 PR，head/base 必须属于当前仓库');
    }
    if (pr.baseRef !== this.mainBranch) {
      throw new MergeEvidenceError(`PR base 必须是 ${this.mainBranch}`);
    }
    if (mode === 'active') {
      if (!current) throw new MergeEvidenceError('活动 PR 缺少本地 origin/main 快照');
      if (pr.state !== 'open') throw new MergeEvidenceError('PR 不是 open');
      if (pr.draft) throw new MergeEvidenceError('draft PR 不允许合并');
      if (pr.mergeable !== true) throw new MergeEvidenceError('PR mergeable 不是 true');
      if (pr.mergeableState !== 'clean') {
        throw new MergeEvidenceError(`PR mergeable_state=${pr.mergeableState}，只允许 clean`);
      }
      if (!sameRepo(current.mainSha, pr.baseSHA)) {
        throw new MergeEvidenceError('PR base SHA 与本地 origin/main 不一致，请重新预检');
      }
    } else {
      if (!pr.merged) throw new MergeEvidenceError('PR 尚未合并');
      if (!pr.mergeCommitSha) throw new MergeEvidenceError('已合并 PR 缺少有效 merge commit SHA');
    }

    const meta = extractMeta(pr.body);
    if (!meta || meta.system !== 'spec-loop') throw new MergeEvidenceError('PR 缺少有效 spec-loop 元数据');
    const branchType: MergePrType | null = pr.headRef.startsWith('pi/spec-')
      ? 'docs'
      : pr.headRef.startsWith('pi/req-')
        ? 'code'
        : null;
    const metaType: MergePrType | null =
      meta.kind === 'spec-request' ? 'docs' : meta.kind === 'code-pr' ? 'code' : null;
    if (!branchType) throw new MergeEvidenceError('PR head 不是受管的 pi/spec-* 或 pi/req-* 分支');
    if (!metaType || metaType !== branchType) {
      throw new MergeEvidenceError('PR branch 类型与 spec-loop 元数据 kind 不一致');
    }
    const evidenceBaseSHA =
      mode === 'active'
        ? pr.baseSHA
        : mergedBaseSHA ?? sha(meta.sourceMainSha, 'PR 元数据 sourceMainSha');

    const localValidation =
      branchType === 'docs'
        ? this.validateDocsBinding(pr, meta, current, mode, evidenceBaseSHA)
        : await this.validateCodeBinding(pr, meta, current, mode, evidenceBaseSHA);

    const [files, tree, rawDiff] = await Promise.all([
      this.listPullFiles(pr.number),
      this.readTree(pr.headSHA),
      this.rawDiff(pr, evidenceBaseSHA),
    ]);
    this.validateChangedFiles(pr, branchType, files, tree, rawDiff);
    if (branchType === 'docs') {
      await this.verifyDocContent(pr, files[0]!, tree);
    }

    if (mode === 'merged') {
      return {
        type: branchType,
        checks: {
          summary: 'PR 已合并，不再依赖确认时远端检查',
          localValidation,
          zeroRemoteChecks: false,
        },
      };
    }

    const checks = await this.collectChecks(pr.headSHA);
    if (checks.zeroRemoteChecks && !localValidation) {
      throw new MergeEvidenceError('远端没有检查且未找到可信的本地验证记录');
    }
    return {
      type: branchType,
      checks: {
        ...checks,
        localValidation,
      },
    };
  }

  private validateDocsBinding(
    pr: PullRequestDetail,
    meta: Record<string, unknown>,
    current: CurrentSpecSnapshot | undefined,
    mode: 'active' | 'merged',
    evidenceBaseSHA: string,
  ): string {
    const requests = Object.values(this.state.snapshot().specRequests ?? {}).filter(
      (request) => request.prNumber === pr.number,
    );
    if (requests.length !== 1) throw new MergeEvidenceError('找不到唯一绑定的 state 文档请求');
    const request = requests[0]!;
    const allowedStages =
      mode === 'active'
        ? new Set(['pr-open'])
        : new Set(['pr-open', 'pr-merged', 'review', 'failed', 'stale']);
    if (!allowedStages.has(request.stage)) {
      throw new MergeEvidenceError(`文档请求阶段 ${request.stage} 不允许当前操作`);
    }
    if (
      meta.kind !== 'spec-request' ||
      meta.requestId !== request.requestId ||
      meta.specPath !== TARGET_SPEC_PATH ||
      meta.sourceMainSha !== request.baseSHA
    ) {
      throw new MergeEvidenceError('PR 元数据与 state 文档请求绑定不一致');
    }
    if (
      request.branch !== pr.headRef ||
      request.commitSHA !== pr.headSHA ||
      request.baseSHA !== evidenceBaseSHA
    ) {
      throw new MergeEvidenceError('PR head/base 与 state 文档请求不一致');
    }
    if (!request.hasValidDoc || !request.docContent) {
      throw new MergeEvidenceError('state 文档请求缺少已验证 docContent');
    }
    if (mode === 'active' && (!current || !sameRepo(current.mainSha, request.baseSHA))) {
      throw new MergeEvidenceError('文档请求 base 已漂移，请重新预检');
    }
    if (request.prUrl && request.prUrl !== pr.url) {
      throw new MergeEvidenceError('PR URL 与 state 文档请求不一致');
    }
    const currentCounter = current?.specs.find((spec) => spec.id === request.targetReqId);
    if (mode === 'merged' && currentCounter && currentCounter.path !== TARGET_SPEC_PATH) {
      throw new MergeEvidenceError('当前 counter 需求路径与受管绑定不一致');
    }
    return '文档请求 pr-open、commitSHA、baseSHA 与已验证 docContent';
  }

  private async validateCodeBinding(
    pr: PullRequestDetail,
    meta: Record<string, unknown>,
    current: CurrentSpecSnapshot | undefined,
    mode: 'active' | 'merged',
    evidenceBaseSHA: string,
  ): Promise<string> {
    const reqId = requiredString(meta.reqId, 'PR 元数据 reqId');
    const specHash = requiredString(meta.specHash, 'PR 元数据 specHash');
    const sourceMainSha = requiredString(meta.sourceMainSha, 'PR 元数据 sourceMainSha');
    const jobId = requiredString(meta.jobId, 'PR 元数据 jobId');
    const attempt = requiredInteger(meta.attempt, 'PR 元数据 attempt', 1);
    const state = this.state.snapshot();
    const requirement = state.requirements[reqId];
    const job: JobState | undefined = state.jobs[jobId];
    if (!job) throw new MergeEvidenceError('找不到绑定的 state job');
    const persistedHead = job.headSHA?.trim().toLowerCase();
    if (!persistedHead || !SHA_RE.test(persistedHead)) {
      throw new MergeEvidenceError('state job 缺少持久验证的完整 headSHA，拒绝合并');
    }
    if (persistedHead !== pr.headSHA) {
      throw new MergeEvidenceError('PR head SHA 与 state job 持久验证 headSHA 不一致，拒绝合并');
    }
    if (
      job.reqId !== reqId ||
      job.jobId !== jobId ||
      job.attempt !== attempt ||
      job.specHash !== specHash ||
      job.sourceMainSha !== sourceMainSha ||
      job.prNumber !== pr.number ||
      evidenceBaseSHA !== sourceMainSha
    ) {
      throw new MergeEvidenceError('PR 元数据与 state job/requirement/specHash 绑定不一致');
    }
    if (requirement && requirement.issueNumber !== job.issueNumber) {
      throw new MergeEvidenceError('state requirement 与 job 的 issue 绑定不一致');
    }
    const activeStatuses = new Set(['in-review']);
    const mergedStatuses = new Set(['in-review', 'done', 'failed']);
    if (!(mode === 'active' ? activeStatuses : mergedStatuses).has(job.status)) {
      throw new MergeEvidenceError(`本地 job 状态 ${job.status} 不允许当前操作`);
    }
    const expectedBranch = buildWorkerBranchName(
      reqId,
      job.issueNumber,
      specHash,
      sourceMainSha,
      attempt,
    );
    if (pr.headRef !== expectedBranch) {
      throw new MergeEvidenceError('PR head 分支不是受控 Worker 生成分支');
    }
    if (mode === 'active') {
      if (!requirement || !current) {
        throw new MergeEvidenceError('活动代码 PR 缺少 state requirement 或本地 origin/main');
      }
      if (
        requirement.specHash !== specHash ||
        requirement.sourceMainSha !== sourceMainSha ||
        !sameRepo(current.mainSha, sourceMainSha)
      ) {
        throw new MergeEvidenceError('requirement/job/meta/当前 main 的 revision 绑定不一致');
      }
      const currentSpec = current.specs.find((spec) => spec.id === reqId);
      if (!currentSpec || currentSpec.hash !== requirement.specHash || currentSpec.hash !== specHash) {
        throw new MergeEvidenceError('当前 origin/main 需求哈希与 state/PR specHash 不一致');
      }
      if (!(await this.git.hasBranch(this.repoDir, expectedBranch))) {
        throw new MergeEvidenceError('受控 Worker 本地分支不存在，无法确认持久 headSHA');
      }
      const localHead = (await this.git.revParse(this.repoDir, `refs/heads/${expectedBranch}`))
        .trim()
        .toLowerCase();
      if (localHead !== persistedHead) {
        throw new MergeEvidenceError('受控 Worker 本地分支 SHA 与持久 headSHA 不一致');
      }
    }
    return mode === 'active'
      ? `job ${jobId} 处于 in-review，PR/本地分支 head、attempt/specHash/sourceMainSha 全匹配`
      : `历史 job ${jobId} 的 PR/持久 head、attempt/specHash/sourceMainSha 全匹配`;
  }

  private async listPullFiles(prNumber: number): Promise<PullFile[]> {
    const result = await this.github.runApi([
      'api',
      '--paginate',
      '--slurp',
      `repos/${this.repo}/pulls/${prNumber}/files?per_page=100`,
    ]);
    if (result.code !== 0) throw new MergeEvidenceError(`读取 PR 文件失败：${this.githubResultError(result)}`);
    let pages: unknown;
    try {
      pages = JSON.parse(result.stdout);
    } catch {
      throw new MergeEvidenceError('PR 文件分页响应不是合法 JSON');
    }
    if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
      throw new MergeEvidenceError('PR 文件分页结构不完整，拒绝合并');
    }
    const files = pages.flat().map(parsePullFile);
    const names = new Set(files.map((file) => file.filename));
    if (names.size !== files.length) throw new MergeEvidenceError('PR 文件分页存在重复路径，拒绝合并');
    return files;
  }

  private async readTree(shaValue: string): Promise<TreeEntry[]> {
    const response = await this.apiJson(`repos/${this.repo}/git/trees/${shaValue}?recursive=1`);
    const raw = recordValue(response, 'Git tree');
    if (raw.truncated !== false) throw new MergeEvidenceError('Git tree 被截断，无法确认完整变更');
    if (!Array.isArray(raw.tree)) throw new MergeEvidenceError('Git tree 缺少 entries');
    const entries = raw.tree.map(parseTreeEntry);
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
      throw new MergeEvidenceError('Git tree 存在重复路径，无法确认完整变更');
    }
    return entries;
  }

  private async rawDiff(pr: PullRequestDetail, baseSHA: string): Promise<RawDiffEntry[]> {
    if (!(await this.git.hasCommit(this.repoDir, pr.headSHA))) {
      const remoteRef = `refs/remotes/origin/spec-loop-merge-pr-${pr.number}`;
      await this.git.raw(
        ['fetch', 'origin', `+refs/pull/${pr.number}/head:${remoteRef}`],
        this.repoDir,
      );
      const fetched = (await this.git.revParse(this.repoDir, remoteRef)).trim();
      if (fetched.toLowerCase() !== pr.headSHA) {
        throw new MergeEvidenceError('拉取 PR head 后 SHA 不一致');
      }
    }
    const output = await this.git.raw(
      [
        'diff-tree',
        '--no-commit-id',
        '--raw',
        '--no-renames',
        '-r',
        '-z',
        baseSHA,
        pr.headSHA,
      ],
      this.repoDir,
    );
    return parseRawDiff(output);
  }

  private validateChangedFiles(
    pr: PullRequestDetail,
    type: MergePrType,
    files: PullFile[],
    tree: TreeEntry[],
    rawDiff: RawDiffEntry[],
  ): void {
    if (pr.changedFiles <= 0) throw new MergeEvidenceError('PR 没有变更文件');
    if (files.length !== pr.changedFiles) {
      throw new MergeEvidenceError(
        `PR changed_files=${pr.changedFiles}，分页文件数=${files.length}，数据不完整`,
      );
    }
    if (rawDiff.length !== pr.changedFiles) {
      throw new MergeEvidenceError('raw git diff 数量与 changed_files 不一致');
    }
    const filePaths = new Set(files.map((file) => file.filename));
    const rawPaths = new Set(rawDiff.map((entry) => entry.path));
    if (
      filePaths.size !== rawPaths.size ||
      [...filePaths].some((path) => !rawPaths.has(path))
    ) {
      throw new MergeEvidenceError('REST 文件清单与 raw git diff 路径不一致');
    }
    const treeByPath = new Map(tree.map((entry) => [entry.path, entry]));
    const rawByPath = new Map(rawDiff.map((entry) => [entry.path, entry]));

    if (type === 'docs') {
      if (files.length !== 1 || files[0]?.filename !== TARGET_SPEC_PATH) {
        throw new MergeEvidenceError(`文档 PR 必须且只能修改 ${TARGET_SPEC_PATH}`);
      }
      const file = files[0]!;
      if (file.status !== 'modified' || file.previousFilename) {
        throw new MergeEvidenceError('文档 PR 文件状态必须是普通 modified，拒绝 rename');
      }
      const raw = rawDiff[0]!;
      if (raw.oldMode !== '100644' || raw.newMode !== '100644' || raw.status !== 'M') {
        throw new MergeEvidenceError('文档文件旧/新 mode 必须均为 100644');
      }
      const entry = treeByPath.get(TARGET_SPEC_PATH);
      if (!entry || entry.mode !== '100644' || entry.type !== 'blob') {
        throw new MergeEvidenceError('文档 head tree 文件必须是 100644 普通 blob');
      }
      return;
    }

    for (const file of files) {
      if (
        !file.filename.startsWith('src/') ||
        file.previousFilename ||
        (file.status !== 'modified' && file.status !== 'added')
      ) {
        throw new MergeEvidenceError(`代码 PR 出现越权或未知文件状态：${file.filename}`);
      }
      const entry = treeByPath.get(file.filename);
      if (!entry || entry.mode !== '100644' || entry.type !== 'blob') {
        throw new MergeEvidenceError(`代码文件不是 100644 普通 blob：${file.filename}`);
      }
      const raw = rawByPath.get(file.filename);
      if (!raw) throw new MergeEvidenceError(`raw git diff 缺少文件：${file.filename}`);
      if (
        (file.status === 'added' && (raw.oldMode !== '000000' || raw.status !== 'A')) ||
        (file.status === 'modified' && (raw.oldMode !== '100644' || raw.status !== 'M'))
      ) {
        throw new MergeEvidenceError(`REST 与 raw git 文件状态/mode 不一致：${file.filename}`);
      }
    }
    for (const entry of rawDiff) {
      const oldAllowed = entry.oldMode === '100644' || entry.oldMode === '000000';
      if (
        !entry.path.startsWith('src/') ||
        !oldAllowed ||
        entry.newMode !== '100644' ||
        (entry.status !== 'M' && entry.status !== 'A')
      ) {
        throw new MergeEvidenceError(`raw git diff 出现越权路径或非 100644 mode：${entry.path}`);
      }
    }
  }

  private async verifyDocContent(pr: PullRequestDetail, file: PullFile, tree: TreeEntry[]): Promise<void> {
    const request = Object.values(this.state.snapshot().specRequests ?? {}).find(
      (candidate) => candidate.prNumber === pr.number,
    );
    if (!request?.docContent) throw new MergeEvidenceError('缺少 state 已验证 docContent');
    const entry = tree.find((candidate) => candidate.path === file.filename);
    if (!entry) throw new MergeEvidenceError('head tree 缺少文档文件');
    const raw = await this.apiJson(`repos/${this.repo}/git/blobs/${entry.sha}`);
    const blob = recordValue(raw, 'Git blob');
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new MergeEvidenceError('Git blob 不是完整的 base64 内容');
    }
    const actual = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (actual !== request.docContent) {
      throw new MergeEvidenceError('PR head 文档内容与 state 已验证 docContent 不一致');
    }
  }

  private async collectChecks(headSHA: string): Promise<Omit<CheckEvidence, 'localValidation'>> {
    const checkRuns = await this.collectCheckRuns(headSHA);
    const statuses = await this.collectCommitStatuses(headSHA);
    const zeroRemoteChecks = checkRuns.total === 0 && statuses.total === 0;
    return {
      zeroRemoteChecks,
      summary: zeroRemoteChecks
        ? '无远端检查（依赖本地可信验证记录）'
        : `${checkRuns.total} 项 check-run、${statuses.total} 项 commit status，全部通过`,
    };
  }

  private async collectCheckRuns(headSHA: string): Promise<{ total: number }> {
    const raw = await this.paginatedObjects(
      `repos/${this.repo}/commits/${headSHA}/check-runs?per_page=100`,
      'check-runs',
    );
    if (raw.length === 0) throw new MergeEvidenceError('check-runs 分页返回空，无法确认完整性');
    const totals = raw.map((page) => requiredInteger(page.total_count, 'check-runs.total_count'));
    const total = totals[0]!;
    if (totals.some((value) => value !== total)) throw new MergeEvidenceError('check-runs 分页 total_count 不一致');
    const runs: Record<string, unknown>[] = [];
    for (const page of raw) {
      if (!Array.isArray(page.check_runs)) throw new MergeEvidenceError('check-runs 分页缺少数组');
      runs.push(...page.check_runs.map((value) => recordValue(value, 'check-run')));
    }
    if (runs.length !== total) {
      throw new MergeEvidenceError(`check-runs total_count=${total}，实际=${runs.length}`);
    }
    const ids = new Set<string>();
    for (const run of runs) {
      const runSha = sha(run.head_sha, 'check-run head_sha');
      if (runSha !== headSHA.toLowerCase()) throw new MergeEvidenceError('check-run 属于其他 head');
      const id = String(run.id ?? '');
      if (!id || ids.has(id)) throw new MergeEvidenceError('check-run 分页出现缺失或重复 id');
      ids.add(id);
      const status = requiredString(run.status, 'check-run status');
      const conclusion =
        typeof run.conclusion === 'string' ? run.conclusion.trim().toLowerCase() : '';
      const name = requiredString(run.name, 'check-run name');
      if (
        status !== 'completed' ||
        !conclusion ||
        !PASSING_CHECK_CONCLUSIONS.has(conclusion)
      ) {
        throw new ChecksRejectedError(
          `check-run ${name} 状态=${status}/${conclusion || '未完成'}`,
        );
      }
    }
    return { total };
  }

  private async collectCommitStatuses(headSHA: string): Promise<{ total: number }> {
    const raw = await this.paginatedObjects(
      `repos/${this.repo}/commits/${headSHA}/status?per_page=100`,
      'commit statuses',
    );
    if (raw.length === 0) throw new MergeEvidenceError('commit status 分页返回空，无法确认完整性');
    const totals = raw.map((page) => requiredInteger(page.total_count, 'commit status total_count'));
    const total = totals[0]!;
    if (totals.some((value) => value !== total)) {
      throw new MergeEvidenceError('commit status 分页 total_count 不一致');
    }
    const statuses: Record<string, unknown>[] = [];
    const combinedStates: string[] = [];
    for (const page of raw) {
      if (sha(page.sha, 'commit status sha') !== headSHA.toLowerCase()) {
        throw new MergeEvidenceError('commit status 属于其他 head');
      }
      if (!Array.isArray(page.statuses)) throw new MergeEvidenceError('commit status 分页缺少数组');
      combinedStates.push(requiredString(page.state, 'commit status state').toLowerCase());
      statuses.push(...page.statuses.map((value) => recordValue(value, 'commit status')));
    }
    if (statuses.length !== total) {
      throw new MergeEvidenceError(`commit status total_count=${total}，实际=${statuses.length}`);
    }
    if (total > 0) {
      if (combinedStates.some((state) => state !== combinedStates[0])) {
        throw new MergeEvidenceError('commit status 分页 combined state 不一致');
      }
      const combined = combinedStates[0]!;
      if (combined !== 'success') throw new ChecksRejectedError(`combined commit status=${combined}`);
      const ids = new Set<string>();
      for (const status of statuses) {
        const state = requiredString(status.state, 'commit status state').toLowerCase();
        const context = requiredString(status.context, 'commit status context');
        const id = optionalString(String(status.id ?? ''));
        if (!id || ids.has(id)) {
          throw new MergeEvidenceError('commit status 分页出现缺失或重复 id');
        }
        ids.add(id);
        if (state !== 'success') throw new ChecksRejectedError(`commit status ${context}=${state}`);
      }
    }
    return { total };
  }

  private async paginatedObjects(path: string, label: string): Promise<Record<string, unknown>[]> {
    const result = await this.github.runApi(['api', '--paginate', '--slurp', path]);
    if (result.code !== 0) {
      throw new MergeEvidenceError(`读取 ${label} 失败：${this.githubResultError(result)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new MergeEvidenceError(`${label} 分页响应不是合法 JSON`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new MergeEvidenceError(`${label} 分页响应缺少页数组`);
    }
    return parsed.map((page) => recordValue(page, label));
  }

  private async apiJson(path: string): Promise<unknown> {
    const result = await this.github.runApi(['api', path]);
    if (result.code !== 0) {
      throw new MergeEvidenceError(`GitHub 读取失败：${this.githubResultError(result)}`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new MergeEvidenceError('GitHub 响应不是合法 JSON');
    }
  }

  private async getPull(prNumber: number): Promise<PullRequestDetail> {
    return parsePull(await this.apiJson(`repos/${this.repo}/pulls/${prNumber}`), prNumber);
  }

  private githubResultError(result: GhResult): string {
    const text = redact(
      result.stderr.trim() ||
        result.stdout.trim() ||
        (result.code === 124 ? 'gh api 超时' : `gh 退出码 ${result.code}`),
    )
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  }

  /**
   * 只有同步 REST 调用可辨识的明确拒绝才能落 failed。
   * 5xx、408 类超时、DNS/EOF/连接重置与无法解析的退出码 1 都保持 unknown。
   */
  private explicitMergeRejection(
    result: GhResult,
    response: Record<string, unknown> | null,
  ): string | null {
    const explicitStatuses = new Set([403, 405, 409, 422]);
    for (const key of ['status', 'statusCode', 'status_code']) {
      const raw = response?.[key];
      const status = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
      if (!explicitStatuses.has(status)) continue;
      const message = optionalString(response?.message);
      return message ? `GitHub HTTP ${status}：${message}` : `GitHub HTTP ${status} 明确拒绝合并`;
    }

    const text = `${result.stderr}\n${result.stdout}`;
    const match =
      /\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/i.exec(text) ??
      /\bstatus(?:Code|_code)?["']?\s*[:=]\s*["']?(\d{3})\b/i.exec(text);
    if (match) {
      const status = Number.parseInt(match[1] ?? '', 10);
      if (explicitStatuses.has(status)) {
        const message = optionalString(response?.message);
        return message ? `GitHub HTTP ${status}：${message}` : `GitHub HTTP ${status} 明确拒绝合并`;
      }
    }

    if (response?.merged === false) {
      return optionalString(response.message) ?? 'GitHub merge API 明确返回 merged=false';
    }
    return null;
  }

  private async currentSpecSnapshot(): Promise<CurrentSpecSnapshot> {
    await this.git.fetch(this.repoDir, this.mainBranch);
    const mainSha = (await this.git.revParse(this.repoDir, `origin/${this.mainBranch}`)).trim().toLowerCase();
    if (!SHA_RE.test(mainSha)) throw new MergeEvidenceError('origin/main 不是完整 SHA');
    const files = await this.git.readSpecSnapshot(this.repoDir, `origin/${this.mainBranch}`);
    const parsed = parseSpecs(files);
    return { mainSha, specs: parsed.specs };
  }

  private assertEvidenceSnapshot(first: PullRequestDetail, final: PullRequestDetail): void {
    if (
      first.number !== final.number ||
      first.headSHA !== final.headSHA ||
      first.baseSHA !== final.baseSHA ||
      first.changedFiles !== final.changedFiles ||
      first.title !== final.title
    ) {
      throw new MergeEvidenceError('预检期间 PR head/base/title/files 发生变化');
    }
    if (
      final.state !== 'open' ||
      final.draft ||
      final.mergeable !== true ||
      final.mergeableState !== 'clean'
    ) {
      throw new MergeEvidenceError('预检结束时 PR 已不再 clean/mergeable');
    }
  }

  private assertRecordSnapshot(
    record: MergeRequestState,
    pr: PullRequestDetail,
    currentMainSha: string,
  ): void {
    this.assertRecordHead(record, pr);
    if (pr.baseSHA !== record.baseSHA) {
      throw new MergeEvidenceError('PR base 已从确认码绑定 SHA 漂移，确认码作废');
    }
    if (currentMainSha !== record.baseSHA) {
      throw new MergeEvidenceError('main/base 已从确认码绑定 SHA 漂移，确认码作废');
    }
    if (pr.state !== 'open') throw new MergeEvidenceError('PR 已关闭且未合并');
  }

  private assertRecordHead(record: MergeRequestState, pr: PullRequestDetail): void {
    if (pr.headSHA !== record.headSHA) {
      throw new MergeEvidenceError('PR head 已从确认码绑定 SHA 漂移，确认码作废');
    }
  }

  private looksLikeDrift(error: unknown): boolean {
    return /漂移|head 已|base 已|发生变化/.test(boundedError(error));
  }

  private uniqueConfirmationCode(): string {
    const existing = new Set(
      Object.values(this.state.snapshot().mergeRequests ?? {}).map((record) => record.confirmationCode),
    );
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const code = this.confirmationCodeFactory().trim().toLowerCase();
      if (!CODE_RE.test(code)) throw new MergeEvidenceError('确认码生成器返回了非 8 位十六进制');
      if (!existing.has(code)) return code;
    }
    throw new MergeEvidenceError('无法生成唯一确认码，请稍后重试');
  }

  private isExpired(record: MergeRequestState): boolean {
    const expiresAt = Date.parse(record.expiresAt);
    return !Number.isFinite(expiresAt) || this.now() >= expiresAt;
  }

  private preflightMessage(record: MergeRequestState): string {
    return [
      `PR #${record.prNumber} 合并预检通过`,
      `仓库: ${record.repo}`,
      `标题: ${record.prTitle}`,
      `链接: ${record.prUrl}`,
      `类型: ${record.type === 'docs' ? '文档 PR' : '代码 PR'}`,
      `headSHA: ${record.headSHA}`,
      `目标: ${this.mainBranch} / ${record.baseSHA}`,
      `检查: ${record.checksSummary}`,
      `本地验证: ${record.localValidation}`,
      `10 分钟内发送：确认合并 #${record.prNumber} ${record.confirmationCode}`,
    ].join('\n');
  }

  private reject(prNumber: number, detail: string): string {
    return [
      `拒绝合并 PR #${prNumber}：${detail}`,
      `链接: https://github.com/${this.repo}/pull/${prNumber}`,
      `修复或更新后请重新发送“合并 PR #${prNumber}”。`,
    ].join('\n');
  }

  private expiredMessage(record: MergeRequestState): string {
    return this.reject(record.prNumber, '确认码已过期；过期只阻止尚未发起的新写，请重新预检');
  }

  private async insertRecord(record: MergeRequestState): Promise<void> {
    await this.state.update((state) => {
      state.mergeRequests ??= {};
      state.mergeRequests[record.requestId] = record;
      state.opLog.push({
        ts: record.createdAt,
        stage: 'merge-confirmable',
        operationKey: `merge:${record.prNumber}:${record.headSHA.slice(0, 8)}`,
        detail: `PR #${record.prNumber} ${record.type} 预检通过`,
      });
    });
  }

  private async rememberPreflightMessage(record: MergeRequestState, messageId: string): Promise<void> {
    if (record.preflightMessageIds.includes(messageId)) return;
    try {
      await this.state.update((state) => {
        const target = state.mergeRequests?.[record.requestId];
        if (!target) return;
        target.preflightMessageIds.push(messageId);
        target.updatedAt = this.isoNow();
      });
    } catch (error) {
      this.logger.warn(`[MERGE] PR #${record.prNumber} 预检 messageId 去重落盘失败 ${boundedError(error)}`);
    }
  }

  private async rememberAttemptError(record: MergeRequestState, message: string): Promise<void> {
    try {
      await this.state.update((state) => {
        const target = state.mergeRequests?.[record.requestId];
        if (!target || target.stage !== 'confirmable') return;
        target.error = message;
        target.updatedAt = this.isoNow();
      });
    } catch {
      // 失败说明仍通过飞书回复返回，不改变确认许可。
    }
  }

  private async markAttempted(record: MergeRequestState, messageId: string): Promise<void> {
    await this.state.update((state) => {
      const target = state.mergeRequests?.[record.requestId];
      if (!target || target.stage !== 'confirmable') {
        throw new Error('确认记录不再是 confirmable，拒绝发送 PUT');
      }
      target.stage = 'attempted';
      target.error = undefined;
      target.result = undefined;
      if (!target.confirmationMessageIds.includes(messageId)) {
        target.confirmationMessageIds.push(messageId);
      }
      target.updatedAt = this.isoNow();
      state.opLog.push({
        ts: target.updatedAt,
        stage: 'merge-attempted',
        operationKey: `merge:${target.prNumber}:${target.headSHA.slice(0, 8)}`,
        detail: `PR #${target.prNumber} 已完成本地 attempted 落盘，准备同步 PUT`,
      });
    });
  }

  private async restoreConfirmable(record: MergeRequestState, message: string): Promise<void> {
    try {
      await this.state.update((state) => {
        const target = state.mergeRequests?.[record.requestId];
        if (!target || target.stage !== 'attempted') return;
        target.stage = 'confirmable';
        target.error = message;
        target.updatedAt = this.isoNow();
      });
    } catch (error) {
      await this.markUnknown(record, message);
      this.logger.warn(`[MERGE] PR #${record.prNumber} 恢复 confirmable 失败 ${boundedError(error)}`);
    }
  }

  private async markExpired(record: MergeRequestState): Promise<void> {
    await this.markTerminal(record, 'expired', '确认码超过 10 分钟有效期');
  }

  private async markUnknown(record: MergeRequestState, message: string): Promise<void> {
    await this.markTerminal(record, 'unknown', message);
  }

  private async markTerminal(
    record: MergeRequestState,
    stage: Exclude<MergeRequestStage, 'merged'>,
    message: string,
  ): Promise<void> {
    try {
      await this.state.update((state) => {
        const target = state.mergeRequests?.[record.requestId];
        if (
          !target ||
          target.stage === 'merged'
        ) {
          return;
        }
        if (target.stage === stage) {
          target.error = message;
          target.updatedAt = this.isoNow();
          return;
        }
        target.stage = stage;
        target.error = message;
        target.result = stage === 'unknown' ? '合并结果未知，仅允许只读对账' : target.result;
        target.updatedAt = this.isoNow();
        state.opLog.push({
          ts: target.updatedAt,
          stage: `merge-${stage}`,
          operationKey: `merge:${target.prNumber}:${target.headSHA.slice(0, 8)}`,
          detail: `PR #${target.prNumber} ${stage}`,
        });
      });
    } catch (error) {
      this.logger.warn(`[MERGE] PR #${record.prNumber} 状态 ${stage} 落盘失败 ${boundedError(error)}`);
    }
  }

  private async finishMerged(record: MergeRequestState, mergeCommitSha: string): Promise<string> {
    try {
      await this.state.update((state) => {
        const target = state.mergeRequests?.[record.requestId];
        if (!target) return;
        if (target.stage === 'merged' && target.mergeCommitSha === mergeCommitSha) return;
        target.stage = 'merged';
        target.mergeCommitSha = mergeCommitSha;
        target.result = MERGED_RESULT;
        target.error = undefined;
        target.updatedAt = this.isoNow();
        state.opLog.push({
          ts: target.updatedAt,
          stage: 'merge-merged',
          operationKey: `merge:${target.prNumber}:${target.headSHA.slice(0, 8)}`,
          detail: `PR #${target.prNumber} 已合并 ${mergeCommitSha.slice(0, 8)}`,
        });
      });
    } catch (error) {
      this.logger.error(
        `[MERGE] PR #${record.prNumber} 已合并但 success state 落盘失败，保留 attempted 供恢复 ${boundedError(error)}`,
      );
    }
    try {
      await this.notify?.(`${MERGED_RESULT} ${record.prUrl}`);
    } catch (error) {
      this.logger.warn(`[MERGE] PR #${record.prNumber} 合并通知失败，不改变合并结果 ${boundedError(error)}`);
    }
    this.logger.info(`[MERGE] PR #${record.prNumber} merged ${mergeCommitSha.slice(0, 8)}`);
    return MERGED_RESULT;
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

export function createMergeService(deps: MergeServiceDeps): MergeService {
  return new MergeService(deps);
}
