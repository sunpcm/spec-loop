import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createCommands } from './commands.ts';
import type { Config } from './config.ts';
import { deployOnce, type DeployDeps, type DeployResult } from './deploy.ts';
import type { FeishuCommands } from './feishu-contract.ts';
import { GitClient } from './git.ts';
import { encodeMetaBlock, GithubClient } from './github.ts';
import { createLogger, type Logger } from './log.ts';
import { Notifier } from './notifier.ts';
import { deriveIssueBody } from './planner.ts';
import { buildRequirementMeta } from './reconciler.ts';
import { createStaticServer, extractAssetRefs } from './preview.ts';
import { buildIsolationPaths, type SandboxProfileSpec } from './sandbox.ts';
import {
  applyReconciliation,
  planForMain,
  STATUS_LABELS,
  type ReconcileContext,
  type ReconcileSummary,
} from './scheduler.ts';
import { StateStore } from './state.ts';
import type { JobState, ManagedPR, Spec } from './types.ts';
import {
  buildVerifierEnv,
  defaultVerificationCommands,
  makeSandboxedRunner,
  runVerification,
  verificationPassed,
  type CommandRunner,
} from './validate.ts';
import { runWorkerJob, type WorkerDeps, type WorkerInput, type WorkerOutcome } from './worker.ts';

export type WorkerJobRunner = (deps: WorkerDeps, input: WorkerInput) => Promise<WorkerOutcome>;

export interface Core {
  config: Config;
  logger: Logger;
  state: StateStore;
  git: GitClient;
  github: GithubClient;
  notifier: Notifier;
  commands: FeishuCommands;
  workerDeps: WorkerDeps;
  deployDeps: DeployDeps;
  reconcileContext: ReconcileContext;
  planner: ((spec: Spec) => Promise<string | null>) | null;
  repo: string | null;
  workerRunner?: WorkerJobRunner;
}

export async function resolveRepoFromOrigin(git: GitClient, repoDir: string): Promise<string | null> {
  try {
    const url = (await git.raw(['remote', 'get-url', 'origin'], repoDir)).trim();
    const m = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function symlinkNodeModules(repoDir: string, workDir: string): void {
  const source = join(repoDir, 'node_modules');
  const target = join(workDir, 'node_modules');
  if (existsSync(source) && !existsSync(target)) {
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      // Optional convenience; verification still resolves modules from the parent where possible.
    }
  }
}

async function listenOnEphemeralPort(server: import('node:http').Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

export type HttpGet = (url: string) => Promise<{ status: number; body: string }>;

const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;

/** 纯逻辑：给定 base URL 与版本，验证 /__version、首页与版本化资源真实可服务。 */
export async function checkReleaseHttp(base: string, sha: string, get: HttpGet = httpGet): Promise<boolean> {
  const baseWithoutSlash = base.endsWith('/') ? base.slice(0, -1) : base;
  const versionRes = await get(`${baseWithoutSlash}/__version`);
  if (versionRes.status !== 200) return false;
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(versionRes.body) as { version?: unknown };
  } catch {
    return false;
  }
  if (parsed.version !== sha) return false;

  const indexPath = new URL(`${baseWithoutSlash}/`);
  const indexRes = await get(indexPath.toString());
  if (indexRes.status !== 200 || indexRes.body.trim().length === 0) return false;

  const assets = extractAssetRefs(indexRes.body);
  if (assets.length === 0) return false;
  for (const asset of assets.slice(0, 4)) {
    // extractAssetRefs 会去掉开头斜杠；恢复绝对引用，避免把生产 HTML 的
    // /releases/<sha>/assets 错误解析到版本 base 之下。
    const ref = asset.startsWith('releases/') ? `/${asset}` : asset;
    const assetUrl = new URL(ref, indexPath);
    if (RELEASE_SHA_RE.test(sha) && !assetUrl.pathname.startsWith(`/releases/${sha}/`)) return false;
    const assetRes = await get(assetUrl.toString());
    if (assetRes.status !== 200 || assetRes.body.trim().length === 0) return false;
  }
  return true;
}

/**
 * 真实 HTTP 健康检查：临时启动候选发布目录的静态服务，验证 /__version 精确匹配、
 * 首页可服务、版本化资源可访问，再允许切换预览。
 */
export async function verifyReleaseOverHttp(releaseDir: string, sha: string): Promise<boolean> {
  const server = createStaticServer(releaseDir, sha, createLogger('HEALTH'));
  let port = 0;
  try {
    port = await listenOnEphemeralPort(server);
    const base = `http://127.0.0.1:${port}/releases/${sha}`;
    return await checkReleaseHttp(base, sha);
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function readReleaseFiles(releaseDir: string): string[] {
  const result: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  walk(releaseDir);
  return result;
}

export function releaseContainsVersion(releaseDir: string, sha: string): boolean {
  if (!existsSync(join(releaseDir, 'index.html'))) return false;
  for (const file of readReleaseFiles(releaseDir)) {
    try {
      if (readFileSync(file, 'utf8').includes(sha)) return true;
    } catch {
      // Skip unreadable files.
    }
  }
  return false;
}

export function createBuild(
  config: Config,
  git: GitClient,
  runnerOverride?: CommandRunner,
): (sha: string) => Promise<{ ok: boolean; detail: string }> {
  return async (sha: string) => {
    const outDir = join(config.runDir, 'releases', sha);
    const snapshotDir = join(config.runDir, 'build', sha);
    const jobTmp = join(config.runDir, 'tmp', sha);
    try {
      rmSync(outDir, { recursive: true, force: true });
      // Vite 不负责创建输出目录祖先；在沙箱生效前创建受控输出根，
      // 避免只读验证环境内因 EPERM 无法创建 releases/<sha>。
      mkdirSync(outDir, { recursive: true });
      rmSync(snapshotDir, { recursive: true, force: true });
      mkdirSync(jobTmp, { recursive: true });
      await git.archive(config.repoDir, sha, snapshotDir);
      symlinkNodeModules(config.repoDir, snapshotDir);

      const isolation = buildIsolationPaths(config.repoDir);
      const spec: SandboxProfileSpec = {
        writableDirs: [outDir, jobTmp],
        writableLiterals: ['/dev/null'],
        denyReadDirs: isolation.denyReadDirs,
        denyReadLiterals: isolation.denyReadLiterals,
        allowReadDirs: isolation.allowReadDirs,
        sensitiveDenyDirs: [
          ...isolation.sensitiveDenyDirs,
          config.piAgentDir,
          join(config.runDir, 'jobs'),
        ],
        sensitiveDenyLiterals: isolation.sensitiveDenyLiterals,
        denyNetwork: true,
      };
      const runner = runnerOverride ?? makeSandboxedRunner(spec, { timeoutMs: config.buildTimeoutMs });
      const results = await runVerification(
        defaultVerificationCommands(),
        snapshotDir,
        runner,
        buildVerifierEnv(
          {
            SPEC_LOOP_OUT_DIR: outDir,
            SPEC_LOOP_VERSION: sha,
            SPEC_LOOP_ASSET_BASE: `/releases/${sha}/`,
          },
          jobTmp,
        ),
      );
      if (!verificationPassed(results)) {
        return {
          ok: false,
          detail: results
            .filter((r) => !r.ok)
            .map((r) => `${r.name}: ${r.stderr.trim() || r.stdout.trim()}`)
            .join('\n'),
        };
      }
      return { ok: true, detail: '构建成功' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function createCore(
  config: Config,
  repo: string | null,
  notify?: (text: string) => Promise<void>,
): Core {
  const logger = createLogger('INIT');
  const state = new StateStore(config.stateFile);
  state.load();
  const git = new GitClient();
  const github = new GithubClient(repo ?? '');
  const notifier = new Notifier(null, logger);
  const emitNotify = async (text: string): Promise<void> => {
    const notifyFn = notify;
    if (!notifyFn) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => notifyFn(text)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('通知发送超时（5000ms）')), 5_000);
        }),
      ]);
    } catch (error) {
      logger.warn(
        `通知发送失败（best-effort）: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const workerDeps: WorkerDeps = {
    repoDir: config.repoDir,
    runDir: config.runDir,
    git,
    github,
    logger: createLogger('WORKER'),
    notify: emitNotify,
    mainBranch: config.mainBranch,
    piProvider: config.piProvider,
    piModel: config.piModel,
    piAgentDir: config.piAgentDir,
    piTimeoutMs: config.piTimeoutMs,
    piGraceMs: config.piGraceMs,
    verifyTimeoutMs: config.verifyTimeoutMs,
  };

  const build = createBuild(config, git);

  const deployDeps: DeployDeps = {
    repoDir: config.repoDir,
    runDir: config.runDir,
    git,
    github,
    state,
    logger: createLogger('DEPLOY'),
    notify: emitNotify,
    mainBranch: config.mainBranch,
    build,
    healthCheck: async (sha) => verifyReleaseOverHttp(join(config.runDir, 'releases', sha), sha),
    switchPreview: async (sha, releaseDir) => {
      await state.update((s) => {
        s.deploy.activeSha = sha;
        s.deploy.releaseDir = releaseDir;
        return undefined;
      });
    },
  };

  const reconcileContext: ReconcileContext = {
    repoDir: config.repoDir,
    git,
    github,
    state,
    logger: createLogger('RECONCILER'),
    mainBranch: config.mainBranch,
  };

  // 先建立可变的 core 引用，供 retryWorker 闭包回指统一作业生命周期。
  const core: Core = {
    config,
    logger,
    state,
    git,
    github,
    notifier,
    commands: null as unknown as FeishuCommands,
    workerDeps,
    deployDeps,
    reconcileContext,
    planner: null,
    repo,
    workerRunner: runWorkerJob,
  };

  const commands = createCommands({
    repoDir: config.repoDir,
    state,
    github,
    git,
    logger: createLogger('FEISHU'),
    deploy: deployDeps,
    worker: workerDeps,
    mainBranch: config.mainBranch,
    retryWorker: (input) => runOneWorkerForInput(core, input),
  });

  const plannerEnabled = Boolean(config.piProvider && config.piModel);
  const planner = plannerEnabled
    ? (spec: Spec): Promise<string | null> =>
        deriveIssueBody(spec, {
          repoDir: config.repoDir,
          runDir: config.runDir,
          provider: config.piProvider,
          model: config.piModel,
          agentDir: config.piAgentDir,
          timeoutMs: config.piTimeoutMs,
          graceMs: config.piGraceMs,
          logger: createLogger('PLANNER'),
        })
    : null;

  core.commands = commands;
  core.planner = planner;

  return core;
}

/** 组合 planForMain/applyReconciliation，在确定性对账前用 Planner 派生正文（失败回退确定性正文）。 */
export async function reconcileWithPlanner(
  ctx: ReconcileContext,
  planner: ((spec: Spec) => Promise<string | null>) | null,
): Promise<ReconcileSummary | null> {
  const summary = await planForMain(ctx);
  if (!summary) return null;
  if (planner) {
    for (const op of summary.ops) {
      if ((op.kind === 'create' || op.kind === 'update') && op.spec) {
        const body = await planner(op.spec);
        if (body) {
          const meta = encodeMetaBlock(buildRequirementMeta(op.spec, summary.targetMainSha));
          op.issueBody = `${body}\n\n${meta}`;
        }
      }
    }
  }
  await applyReconciliation(ctx, summary.ops, summary.targetMainSha);
  return summary;
}

export interface WorkerTarget {
  reqId: string;
  issueNumber: number;
  spec: Spec;
  sourceMainSha: string;
  attempt: number;
}

/**
 * 只在当前 revision（specHash + sourceMainSha）内取该需求最新 attempt 的作业。
 * 旧 revision 的高 attempt（如 attempt 3）不能遮盖新 revision 的 attempt 1。
 */
function latestJobForRevision(
  state: ReturnType<StateStore['snapshot']>,
  reqId: string,
  specHash: string,
  sourceMainSha: string,
): JobState | undefined {
  let latest: JobState | undefined;
  for (const job of Object.values(state.jobs)) {
    if (job.reqId !== reqId || job.specHash !== specHash || job.sourceMainSha !== sourceMainSha) continue;
    if (!latest || job.attempt > latest.attempt || (job.attempt === latest.attempt && job.updatedAt >= latest.updatedAt)) {
      latest = job;
    }
  }
  return latest;
}

export function pickWorkerTargets(state: ReturnType<StateStore['snapshot']>, specs: Spec[]): WorkerTarget[] {
  const specById = new Map(specs.map((s) => [s.id, s]));
  const targets: WorkerTarget[] = [];
  for (const [reqId, req] of Object.entries(state.requirements)) {
    const spec = specById.get(reqId);
    if (!spec) continue;
    const job = latestJobForRevision(state, reqId, spec.hash, req.sourceMainSha);
    if (job && (job.status === 'processing' || job.status === 'in-review' || job.status === 'done' || job.status === 'failed')) {
      continue;
    }
    const attempt = (job ? job.attempt : 0) + 1;
    targets.push({ reqId, issueNumber: req.issueNumber, spec, sourceMainSha: req.sourceMainSha, attempt });
  }
  return targets;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueLink(core: Core, number: number): string {
  return core.repo ? `https://github.com/${core.repo}/issues/${number}` : `Issue #${number}`;
}

function prLink(core: Core, number: number): string {
  return core.repo ? `https://github.com/${core.repo}/pull/${number}` : `PR #${number}`;
}

function truncateIssueText(text: string): string {
  const max = 4000;
  if (text.length <= max) return text;
  const marker = '…(已截断)';
  return text.slice(0, max - marker.length) + marker;
}

async function notifyBestEffort(core: Core, text: string): Promise<void> {
  try {
    await core.workerDeps.notify?.(text);
  } catch {
    // 通知是旁路，不改变 GitHub/本地作业结果。
  }
}

async function syncIssueStatus(
  core: Core,
  issueNumber: number,
  status: 'processing' | 'in-review' | 'failed',
): Promise<void> {
  await core.github.removeLabels(issueNumber, STATUS_LABELS);
  await core.github.addLabels(issueNumber, ['pi-task', `status:${status}`]);
}

async function markSyncStatusFailed(core: Core, jobId: string): Promise<void> {
  await core.state.update((s) => {
    const job = s.jobs[jobId];
    if (job) {
      job.failureStage = 'sync-status-label';
      job.resumeAction = 'sync-status-label';
      // processing 同步失败发生在 Worker 执行前，本地必须进入 failed，
      // 否则 pickWorkerTargets/retry 都会把它当作仍在处理而永久卡住。
      if (job.status === 'processing') job.status = 'failed';
      job.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
}

async function markWorkerOutcome(core: Core, jobId: string, outcome: WorkerOutcome): Promise<void> {
  const now = new Date().toISOString();
  await core.state.update((s) => {
    const job = s.jobs[jobId];
    if (!job) return undefined;
    job.updatedAt = now;
    if (outcome.status === 'published') {
      job.status = 'in-review';
      job.prNumber = outcome.prNumber;
      return undefined;
    }
    job.status = 'failed';
    job.failureStage = outcome.failureStage;
    job.resumeAction = outcome.resumeAction;
    return undefined;
  });
}

function isCurrentRemoteDelivery(pr: ManagedPR, input: WorkerInput): boolean {
  const meta = pr.meta as Record<string, unknown>;
  return (
    meta?.kind === 'code-pr' &&
    meta.reqId === input.reqId &&
    meta.specHash === input.spec.hash &&
    meta.sourceMainSha === input.sourceMainSha &&
    (pr.state === 'open' || pr.merged)
  );
}

async function findExistingDelivery(core: Core, input: WorkerInput): Promise<ManagedPR | null> {
  const matches = (await core.github.listPRs()).filter((pr) => isCurrentRemoteDelivery(pr, input));
  if (matches.length > 1) {
    throw new Error(`远程存在多个当前 revision 交付 PR: ${matches.map((pr) => `#${pr.number}`).join(', ')}`);
  }
  return matches[0] ?? null;
}

async function markExistingDelivery(core: Core, jobId: string, pr: ManagedPR): Promise<void> {
  await core.state.update((s) => {
    const job = s.jobs[jobId];
    if (job) {
      job.status = 'in-review';
      job.prNumber = pr.number;
      job.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
}

/** 每轮先补同步关键 GitHub 标签；已发布 PR 只补回执，不重新进入 Pi。 */
export async function syncPendingStatusLabels(core: Core): Promise<void> {
  const pending = Object.values(core.state.snapshot().jobs).filter(
    (job) => job.failureStage === 'sync-status-label' || job.resumeAction === 'sync-status-label',
  );
  for (const job of pending) {
    const requirement = core.state.snapshot().requirements[job.reqId];
    if (
      !requirement ||
      requirement.issueNumber !== job.issueNumber ||
      requirement.specHash !== job.specHash ||
      requirement.sourceMainSha !== job.sourceMainSha
    ) {
      await core.state.update((s) => {
        const target = s.jobs[job.jobId];
        if (target) {
          target.failureStage = undefined;
          target.resumeAction = undefined;
          target.updatedAt = new Date().toISOString();
        }
        return undefined;
      });
      continue;
    }

    await syncIssueStatus(core, job.issueNumber, job.status === 'in-review' ? 'in-review' : 'failed');
    await core.state.update((s) => {
      const target = s.jobs[job.jobId];
      if (target) {
        target.failureStage = undefined;
        target.resumeAction = undefined;
        target.updatedAt = new Date().toISOString();
      }
      return undefined;
    });
  }
}

/** 统一 Worker 生命周期：本地状态、GitHub 标签、失败评论与通知保持同一条状态机。 */
export async function runOneWorkerForInput(core: Core, input: WorkerInput): Promise<WorkerOutcome> {
  const jobId = input.jobId;
  const requirement = core.state.snapshot().requirements[input.reqId];
  // 新 revision 已接管该 Issue 时，旧作业不再写 GitHub，避免把新需求标成 failed。
  if (
    !requirement ||
    requirement.issueNumber !== input.issueNumber ||
    requirement.specHash !== input.spec.hash ||
    requirement.sourceMainSha !== input.sourceMainSha
  ) {
    const stale: WorkerOutcome = {
      status: 'stale',
      error: `需求 ${input.reqId} 版本已变化，取消过期间望作业`,
      failureStage: 'publish',
    };
    const now = new Date().toISOString();
    await core.state.update((s) => {
      s.jobs[jobId] = {
        jobId,
        reqId: input.reqId,
        issueNumber: input.issueNumber,
        specHash: input.spec.hash,
        sourceMainSha: input.sourceMainSha,
        attempt: input.attempt,
        status: 'failed',
        failureStage: 'publish',
        startedAt: now,
        updatedAt: now,
      };
      return undefined;
    });
    await markWorkerOutcome(core, jobId, stale);
    await notifyBestEffort(core, `⏭️ ${issueLink(core, input.issueNumber)} 需求版本已变化，旧作业停止`);
    return stale;
  }

  await core.state.update((s) => {
    s.jobs[jobId] = {
      jobId,
      reqId: input.reqId,
      issueNumber: input.issueNumber,
      specHash: input.spec.hash,
      sourceMainSha: input.sourceMainSha,
      attempt: input.attempt,
      status: 'processing',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return undefined;
  });

  const issueUrl = issueLink(core, input.issueNumber);
  let existingPr: ManagedPR | null;
  try {
    existingPr = await findExistingDelivery(core, input);
  } catch (error) {
    await core.state.update((s) => {
      const job = s.jobs[jobId];
      if (job) {
        job.status = 'failed';
        job.failureStage = 'remote-delivery-check';
        job.resumeAction = 'remote-delivery-check';
        job.updatedAt = new Date().toISOString();
      }
      return undefined;
    });
    await notifyBestEffort(core, `⚠️ ${issueUrl} 远端交付预检失败：${errorText(error)}`);
    throw error;
  }
  if (existingPr) {
    await markExistingDelivery(core, jobId, existingPr);
    try {
      await syncIssueStatus(core, input.issueNumber, 'in-review');
    } catch (error) {
      await markSyncStatusFailed(core, jobId);
      await notifyBestEffort(core, `⚠️ ${issueUrl} 同步 in-review 标签失败：${errorText(error)}`);
      throw error;
    }
    const prUrl = prLink(core, existingPr.number);
    await notifyBestEffort(core, `🔎 ${issueUrl} 已存在当前版本交付：${prUrl}`);
    return {
      status: 'published',
      prNumber: existingPr.number,
      branch: existingPr.headRefName,
    };
  }

  try {
    await syncIssueStatus(core, input.issueNumber, 'processing');
  } catch (error) {
    await markSyncStatusFailed(core, jobId);
    await notifyBestEffort(core, `⚠️ ${issueUrl} 同步 processing 标签失败：${errorText(error)}`);
    throw error;
  }
  await notifyBestEffort(
    core,
    `🚧 开始处理 ${issueUrl}（attempt ${input.attempt}）：${input.spec.title}`,
  );

  const runner = core.workerRunner ?? runWorkerJob;
  const outcome = await runner(core.workerDeps, input);
  await markWorkerOutcome(core, jobId, outcome);

  if (outcome.status === 'stale') {
    await notifyBestEffort(core, `⏭️ ${issueUrl} ${outcome.error ?? '作业已过期'}`);
    return outcome;
  }

  if (outcome.status === 'published') {
    try {
      await syncIssueStatus(core, input.issueNumber, 'in-review');
    } catch (error) {
      await markSyncStatusFailed(core, jobId);
      await notifyBestEffort(core, `⚠️ ${issueUrl} 同步 in-review 标签失败：${errorText(error)}`);
      throw error;
    }
    const prUrl = outcome.prNumber === undefined ? 'PR 未返回编号' : prLink(core, outcome.prNumber);
    await notifyBestEffort(core, `🔎 ${issueUrl} 已进入审查：${prUrl}`);
    return outcome;
  }

  try {
    await syncIssueStatus(core, input.issueNumber, 'failed');
  } catch (error) {
    await markSyncStatusFailed(core, jobId);
    await notifyBestEffort(core, `⚠️ ${issueUrl} 同步 failed 标签失败：${errorText(error)}`);
    throw error;
  }

  const summary = `❌ Worker 失败（阶段 ${outcome.failureStage ?? 'unknown'}）：${outcome.error ?? outcome.status}`;
  const safeSummary = truncateIssueText(summary);
  try {
    await core.github.comment(input.issueNumber, safeSummary);
  } catch {
    // 评论尽力而为；关键 failed 标签已成功，不伪造部署/Worker 成功。
  }
  await notifyBestEffort(core, `🔧 ${issueUrl} ${safeSummary}`);
  return outcome;
}

export async function runOneWorker(core: Core, target: WorkerTarget): Promise<WorkerOutcome> {
  const input: WorkerInput = {
    jobId: `job-${target.reqId}-${target.attempt}-${Date.now()}`,
    reqId: target.reqId,
    issueNumber: target.issueNumber,
    spec: target.spec,
    sourceMainSha: target.sourceMainSha,
    attempt: target.attempt,
  };
  return runOneWorkerForInput(core, input);
}

export async function runOnce(core: Core): Promise<{
  summary: ReconcileSummary | null;
  workers: WorkerOutcome[];
  deploy: DeployResult;
}> {
  await syncPendingStatusLabels(core);
  // applyReconciliation 关键操作失败会抛错（不推进游标），此处不捕获：
  // 异常向上传播，跳过 Worker 派发与部署，等待下轮重放差量。
  const summary = await reconcileWithPlanner(core.reconcileContext, core.planner);
  const workers: WorkerOutcome[] = [];
  if (summary) {
    const targets = pickWorkerTargets(core.state.snapshot(), summary.specs);
    for (const target of targets) {
      workers.push(await runOneWorker(core, target));
    }
  }
  const deploy = await deployOnce(core.deployDeps);
  return { summary, workers, deploy };
}
