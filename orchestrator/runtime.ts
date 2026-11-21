import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  browserGateTimeoutMs,
  resolveBrowserCacheDir,
  runBrowserGate,
  readSpecFilesFromDir,
  type BrowserGateOptions,
  type BrowserGateResult,
} from './browser-gate.ts';
import { createCommands } from './commands.ts';
import type { Config } from './config.ts';
import { deployOnce, retryDeployForIssue, type DeployDeps, type DeployResult } from './deploy.ts';
import type { DispatchLabelEvent } from './dispatch-grant.ts';
import { evaluateDispatchClaim } from './dispatch-task.ts';
import type { FeishuCommands } from './feishu-contract.ts';
import { GitClient } from './git.ts';
import { encodeMetaBlock, GithubClient } from './github.ts';
import { createLogger, type Logger } from './log.ts';
import { MergeService } from './merge.ts';
import { Notifier } from './notifier.ts';
import { deriveDispatchTask, deriveIssueBody } from './planner.ts';
import { buildRequirementMeta } from './reconciler.ts';
import {
  hasActiveRetryBaseline,
  resumeRetryBaselines,
  type RetryBaselineDeps,
} from './retry-baseline.ts';
import { createStaticServer, extractAssetRefs } from './preview.ts';
import { buildIsolationPaths, type SandboxProfileSpec } from './sandbox.ts';
import {
  applyReconciliation,
  planForMain,
  publishDispatchRevision,
  reconcileWithDispatch,
  STATUS_LABELS,
  type DispatchReconcileDeps,
  type ReconcileContext,
  type ReconcileSummary,
} from './scheduler.ts';
import { parseSpecs } from './specs.ts';
import { StateStore } from './state.ts';
import type { DispatchGrant, DispatchRevision, JobState, ManagedIssue, ManagedPR, OrchestratorState, Spec } from './types.ts';
import {
  buildVerifierEnv,
  defaultVerificationCommands,
  makeSandboxedRunner,
  runVerification,
  verificationPassed,
  type CommandRunner,
} from './validate.ts';
import { createNodeTestRunRecord } from './test-evidence-node.ts';
import { writeTestRunRecord } from './test-evidence.ts';
import {
  checkSatisfiedRevisionCurrent,
  runWorkerJob,
  validateSatisfiedOutcome,
  type WorkerDeps,
  type WorkerInput,
  type WorkerOutcome,
} from './worker.ts';
import {
  reconcileSpecRequests,
  retrySpecRequirement,
  submitSpecRequirement,
  type SpecIntakeDeps,
} from './spec-intake.ts';

export type WorkerJobRunner = (deps: WorkerDeps, input: WorkerInput) => Promise<WorkerOutcome>;

export interface Core {
  config: Config;
  logger: Logger;
  state: StateStore;
  git: GitClient;
  github: GithubClient;
  notifier: Notifier;
  commands: FeishuCommands;
  mergeService: MergeService | null;
  workerDeps: WorkerDeps;
  deployDeps: DeployDeps;
  reconcileContext: ReconcileContext;
  specIntakeDeps: SpecIntakeDeps;
  retryBaselineDeps?: RetryBaselineDeps;
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
  browserGateOverride?: (opts: BrowserGateOptions) => Promise<BrowserGateResult>,
): (sha: string) => Promise<{ ok: boolean; detail: string }> {
  return async (sha: string) => {
    const outDir = join(config.runDir, 'releases', sha);
    const snapshotDir = join(config.runDir, 'build', sha);
    const jobTmp = join(config.runDir, 'tmp', sha);
    const browserJobTmp = join(config.runDir, 'browser', sha);
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
      const buildTestResult = results.find((item) => item.name === 'test');
      if (buildTestResult) {
        try {
          writeTestRunRecord(
            join(config.runDir, 'test-runs'),
            createNodeTestRunRecord({
              stage: 'build',
              version: sha,
              startedAt: null,
              finishedAt: new Date().toISOString(),
              jobId: null,
              reqId: null,
              specHash: null,
              sourceMainSha: sha,
              candidateTreeSha: null,
              ok: buildTestResult.ok,
              stdout: `${buildTestResult.stdout}\n${buildTestResult.stderr}`,
            }),
          );
        } catch (error) {
          createLogger('BUILD').warn(`写入 build node:test 摘要失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!verificationPassed(results)) {
        return {
          ok: false,
          detail: results
            .filter((r) => !r.ok)
            .map((r) => `${r.name}: ${r.stderr.trim() || r.stdout.trim()}`)
            .join('\n'),
        };
      }
      const browserGate = browserGateOverride ?? runBrowserGate;
      const gateResult = await browserGate({
        repoDir: config.repoDir,
        e2eRoot: config.repoDir,
        artifactDir: outDir,
        mountPath: `/releases/${sha}/`,
        version: sha,
        project: 'counter',
        specFiles: readSpecFilesFromDir(snapshotDir),
        jobTmp: browserJobTmp,
        browserCacheDir: resolveBrowserCacheDir(),
        globalAgentDir: config.piAgentDir,
        agentDir: join(config.runDir, 'jobs'),
        logger: createLogger('BROWSER-GATE'),
        timeoutMs: browserGateTimeoutMs(),
        testRunsRoot: join(config.runDir, 'test-runs'),
        evidenceStage: 'build',
        sourceMainSha: sha,
      });
      if (!gateResult.ok) {
        return { ok: false, detail: `浏览器验收失败：${gateResult.detail}` };
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
    checkSatisfiedRevisionCurrent: (sourceMainSha, candidateTreeSha) =>
      checkSatisfiedRevisionCurrent(
        git,
        config.repoDir,
        config.mainBranch,
        sourceMainSha,
        candidateTreeSha,
      ),
    checkDispatchCurrent: (revision: DispatchRevision) =>
      checkDispatchRevisionCurrent(git, config.repoDir, config.mainBranch, revision),
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
    publicUrl: config.publicUrl,
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

  const dispatchDeps: DispatchReconcileDeps = {
    // 门禁只绑定需求 ID，不绑定可改名的 owner/repo。仓库身份由发布和领取时的
    // GitHub 数字 repoId 核验；未配置仓库时远端核验失败并 fail closed。
    isGated: (reqId) => reqId === 'REQ-CNT-01',
    allowedPaths: () => ['src/**'],
    dependsOn: () => [],
    deriveTask: (spec, options) =>
      deriveDispatchTask(
        spec,
        {
          repoDir: config.repoDir,
          runDir: config.runDir,
          provider: config.piProvider,
          model: config.piModel,
          agentDir: config.piAgentDir,
          timeoutMs: config.piTimeoutMs,
          graceMs: config.piGraceMs,
          logger: createLogger('DISPATCH-PLANNER'),
        },
        options,
      ),
  };

  const reconcileContext: ReconcileContext = {
    repoDir: config.repoDir,
    git,
    github,
    state,
    logger: createLogger('RECONCILER'),
    mainBranch: config.mainBranch,
    dispatch: dispatchDeps,
  };

  const specIntakeDeps: SpecIntakeDeps = {
    repoDir: config.repoDir,
    runDir: config.runDir,
    git,
    github,
    state,
    logger: createLogger('SPEC-INTAKE'),
    notify: emitNotify,
    piProvider: config.piProvider,
    piModel: config.piModel,
    piAgentDir: config.piAgentDir,
    piTimeoutMs: config.piTimeoutMs,
    piGraceMs: config.piGraceMs,
  };

  const mergeService = repo
    ? new MergeService({
        repo,
        repoDir: config.repoDir,
        state,
        git,
        github,
        logger: createLogger('MERGE'),
        notify: emitNotify,
        mainBranch: config.mainBranch,
      })
    : null;

  // 先建立可变的 core 引用，供 retryWorker 闭包回指统一作业生命周期。
  const core: Core = {
    config,
    logger,
    state,
    git,
    github,
    notifier,
    commands: null as unknown as FeishuCommands,
    mergeService,
    workerDeps,
    deployDeps,
    reconcileContext,
    specIntakeDeps,
    planner: null,
    repo,
    workerRunner: runWorkerJob,
  };

  const retryBaselineDeps: RetryBaselineDeps = {
    repoDir: config.repoDir,
    state,
    git,
    github,
    logger: createLogger('RETRY-BASELINE'),
    retryWorker: (input) => runOneWorkerForInput(core, input),
    retryDeploy: (issueNumber, prNumber) => retryDeployForIssue(deployDeps, issueNumber, prNumber),
    findExistingDelivery: (input) => findExistingDelivery(core, input),
    trustedE2eRoot: workerDeps.browserE2eRoot ?? config.repoDir,
    mainBranch: config.mainBranch,
    publishDispatchRevision: (input) => publishDispatchRevision(reconcileContext, input),
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
    requireSpec: (description, messageId) => submitSpecRequirement(specIntakeDeps, description, messageId),
    retrySpec: (requestId) => retrySpecRequirement(specIntakeDeps, requestId),
    retryBaselineDeps,
    mergeService,
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
  core.retryBaselineDeps = retryBaselineDeps;
  reconcileContext.retryBaselines = retryBaselineDeps;

  return core;
}

/** 组合 planForMain/applyReconciliation，在确定性对账前用 Planner 派生正文（失败回退确定性正文）。 */
export async function reconcileWithPlanner(
  ctx: ReconcileContext,
  planner: ((spec: Spec) => Promise<string | null>) | null,
): Promise<ReconcileSummary | null> {
  if (ctx.dispatch && !planner) {
    return reconcileWithDispatch(ctx, ctx.dispatch);
  }
  const summary = await planForMain(ctx);
  if (!summary) return null;
  if (planner) {
    for (const op of summary.ops) {
      if ((op.kind === 'create' || op.kind === 'update') && op.spec) {
        if (ctx.dispatch?.isGated(op.reqId)) continue;
        if (hasActiveRetryBaseline(ctx.state.snapshot(), op.reqId)) continue;
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
  jobId?: string;
  reqId: string;
  issueNumber: number;
  spec: Spec;
  sourceMainSha: string;
  attempt: number;
  dispatchRevision?: DispatchRevision;
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
    if (
      job &&
      (job.status === 'processing' ||
        job.status === 'in-review' ||
        job.status === 'done' ||
        job.status === 'failed' ||
        job.status === 'satisfied')
    ) {
      continue;
    }
    const attempt = (job ? job.attempt : 0) + 1;
    targets.push({ reqId, issueNumber: req.issueNumber, spec, sourceMainSha: req.sourceMainSha, attempt });
  }
  return targets;
}

function dispatchTargetMatchesRevision(
  target: WorkerTarget,
  revision: DispatchRevision,
): boolean {
  return (
    revision.reqId === target.reqId &&
    revision.issueNumber === target.issueNumber &&
    revision.specHash === target.spec.hash &&
    revision.specPath === target.spec.path &&
    revision.sourceMainSha === target.sourceMainSha
  );
}

interface RefreshedDispatchClaim {
  revision: DispatchRevision;
  grant: DispatchGrant;
}

/**
 * 刷新本版远端开工许可：重新读取 Issue、仓库 ID 与标签事件，用最新状态重新评估
 * 空名单/撤标/新打标。规格是否当前由 claim 的 checkDispatchCurrent 与 worker 各自核对。
 * 任一步失败或非授权都返回 null，调用方据此等待而不是创建 failed job。
 */
async function refreshDispatchClaim(
  core: Core,
  reqId: string,
  issueNumber: number,
): Promise<RefreshedDispatchClaim | null> {
  let issue: ManagedIssue;
  let repoId: string;
  let events: DispatchLabelEvent[];
  try {
    [issue, repoId, events] = await Promise.all([
      core.github.getDispatchIssue(issueNumber),
      core.github.getDispatchRepositoryId(),
      core.github.listDispatchLabelEvents(issueNumber),
    ]);
  } catch (error) {
    core.logger.warn(
      `派工 ${reqId} 远端许可刷新失败，暂停领取: ${errorText(error)}`,
    );
    return null;
  }
  if (issue.state !== 'open' || issue.number !== issueNumber) return null;

  const decision = evaluateDispatchClaim(core.state.snapshot(), reqId, {
    repoId,
    issueNumber,
    labels: issue.labels,
    events,
    allowedActorIds: core.config.dispatchAllowedUserIds ?? [],
  });
  if (!decision.claimable) return null;
  return { revision: decision.revision, grant: decision.grant };
}

/**
 * 生产运行时唯一的计数器开工门禁。远端标签与事件只决定是否可领取，
 * 本地状态更新再原子占用全局 Pi 名额和本版作业，避免并发轮询重复启动。
 */
async function claimDispatchTarget(core: Core, target: WorkerTarget): Promise<WorkerTarget | null> {
  const deps = core.reconcileContext.dispatch;
  if (!deps?.isGated(target.reqId)) {
    // 已有派工历史但门禁已失效时 fail closed，不能退回旧 REQ 直通路径。
    if (hasDispatchHistory(core.state.snapshot(), target.reqId)) return null;
    return target;
  }

  const initial = core.state.snapshot();
  const revision = latestDispatchRevisionFor(initial, target.reqId);
  if (
    !revision ||
    !dispatchTargetMatchesRevision(target, revision) ||
    hasActivePiJob(initial) ||
    hasJobForRevision(initial, target.reqId, revision.revision)
  ) {
    return null;
  }

  const refreshed = await refreshDispatchClaim(core, target.reqId, target.issueNumber);
  if (!refreshed || !dispatchTargetMatchesRevision(target, refreshed.revision)) {
    return null;
  }

  const checker = core.workerDeps.checkDispatchCurrent;
  if (!checker || !(await checker(refreshed.revision))) return null;

  const jobId = `job-${target.reqId}-${target.attempt}-${Date.now()}`;
  const now = new Date().toISOString();
  let claimed = false;
  await core.state.update((state) => {
    const requirement = state.requirements[target.reqId];
    const current = latestDispatchRevisionFor(state, target.reqId);
    if (
      !requirement ||
      requirement.issueNumber !== target.issueNumber ||
      requirement.specHash !== target.spec.hash ||
      requirement.specPath !== target.spec.path ||
      requirement.sourceMainSha !== target.sourceMainSha ||
      !current ||
      current.revision !== refreshed.revision.revision ||
      hasActivePiJob(state) ||
      hasJobForRevision(state, target.reqId, current.revision)
    ) {
      return undefined;
    }
    current.grant = refreshed.grant;
    state.jobs[jobId] = {
      jobId,
      reqId: target.reqId,
      issueNumber: target.issueNumber,
      specHash: target.spec.hash,
      sourceMainSha: target.sourceMainSha,
      attempt: target.attempt,
      status: 'todo',
      dispatchRevision: current.revision,
      grantEventId: refreshed.grant.eventId,
      startedAt: now,
      updatedAt: now,
    };
    claimed = true;
    return undefined;
  });
  if (!claimed) return null;

  return {
    ...target,
    jobId,
    dispatchRevision: refreshed.revision,
  };
}

/**
 * 核远端当前版本：冻结提交仍在 origin/main 历史中，且该快照的需求路径/哈希与冻结记录一致。
 * 任一步失败或读不到都 fail closed，返回 false，调用方据此等待而不是继续领取。
 */
async function checkDispatchRevisionCurrent(
  git: GitClient,
  repoDir: string,
  mainBranch: string,
  revision: DispatchRevision,
): Promise<boolean> {
  try {
    await git.fetch(repoDir, mainBranch);
    const current = (await git.revParse(repoDir, `origin/${mainBranch}`)).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(current)) return false;
    if (!(await git.isAncestor(repoDir, revision.sourceMainSha, current))) return false;
    // 沿第一父链检查冻结 SHA 之后到当前 HEAD 之间是否改过本需求块；
    // 哪怕内容改后再改回（A→B→A）也必须视为过期，不能只看旧快照。
    const commits = await git.firstParentCommits(repoDir, revision.sourceMainSha, current);
    for (const sha of commits) {
      const changed = await git.changedPathsFirstParent(repoDir, sha);
      if (changed.includes(revision.specPath)) return false;
    }
    // 当前 HEAD 的需求块仍须与冻结记录同一身份（需求 ID / 路径 / 哈希）。
    const files = await git.readSpecSnapshot(repoDir, current);
    const parsed = parseSpecs(files);
    if (parsed.errors.length > 0) return false;
    return parsed.specs.some(
      (spec) => spec.id === revision.reqId && spec.path === revision.specPath && spec.hash === revision.specHash,
    );
  } catch {
    return false;
  }
}

function latestDispatchRevisionFor(state: OrchestratorState, reqId: string): DispatchRevision | undefined {
  const list = state.dispatchRevisions?.[reqId] ?? [];
  return list[list.length - 1];
}

function hasDispatchHistory(state: OrchestratorState, reqId: string): boolean {
  return (state.dispatchRevisions?.[reqId]?.length ?? 0) > 0;
}

function hasActivePiJob(state: OrchestratorState): boolean {
  // 已领取但尚未执行的 todo 作业同样占用全局单 Pi 名额，避免异常重启或串行间隙
  // 让其他需求在名额未真正释放前重复领取。
  return Object.values(state.jobs).some(
    (job) => job.status === 'processing' || job.status === 'todo',
  );
}

function hasJobForRevision(state: OrchestratorState, reqId: string, revision: number): boolean {
  return Object.values(state.jobs).some(
    (job) => job.reqId === reqId && job.dispatchRevision === revision,
  );
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
      const outcomeHead = typeof outcome.headSHA === 'string'
        ? outcome.headSHA.trim().toLowerCase()
        : '';
      if (/^[0-9a-f]{40}$/.test(outcomeHead)) {
        job.headSHA = outcomeHead;
      } else {
        // 可信 head 只能来自本次 Worker 提交后的 outcome；缺失或非法时清除旧值，禁止沿用。
        delete job.headSHA;
      }
      return undefined;
    }
    if (outcome.status === 'satisfied') {
      job.status = 'satisfied';
      job.candidateTreeSha = outcome.candidateTreeSha;
      job.resumeAction = 'sync-satisfied-receipt';
      // satisfied 终态无 PR / 提交，清空可能残留的发布字段，避免面板或合并误读。
      delete job.prNumber;
      delete job.headSHA;
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
  if (
    meta?.kind !== 'code-pr' ||
    meta.reqId !== input.reqId ||
    meta.specHash !== input.spec.hash ||
    meta.sourceMainSha !== input.sourceMainSha ||
    !(pr.state === 'open' || pr.merged)
  ) {
    return false;
  }
  // 派工输入必须精确匹配冻结版本；旧 REQ 输入只匹配不带版本的存量交付。
  if (input.dispatchRevision !== undefined) {
    return meta.dispatchRevision === input.dispatchRevision.revision;
  }
  return meta.dispatchRevision === undefined;
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
    const current = core.state.snapshot();
    const requirement = current.requirements[job.reqId];
    // 显式基线已接管旧 revision，或同一 revision 已有更高 attempt 时，
    // 旧标签回执只能留在旧 Job 上供审计，不能改写新 Issue 状态。
    if (isSupersededWorkerRecovery(current, job)) continue;
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

function satisfiedReceiptKey(
  reqId: string,
  specHash: string,
  sourceMainSha: string,
  candidateTreeSha: string,
): string {
  return createHash('sha256')
    .update(`${reqId}\n${specHash}\n${sourceMainSha}\n${candidateTreeSha}`)
    .digest('hex');
}

function satisfiedReceiptText(
  reqId: string,
  specHash: string,
  sourceMainSha: string,
  candidateTreeSha: string,
): string {
  const revisionKey = satisfiedReceiptKey(reqId, specHash, sourceMainSha, candidateTreeSha);
  const lines = [
    '✅ 已验收无需代码变更',
    `需求 \`${reqId}\` 在固定来源 \`${sourceMainSha}\` 已通过 typecheck/node:test/build 与浏览器验收，源码已满足需求，未创建代码 PR、未部署。`,
    `需求哈希：\`${specHash}\``,
    `来源主线 SHA：\`${sourceMainSha}\``,
  ];
  lines.push(`候选树 SHA：\`${candidateTreeSha}\``);
  lines.push(`回执幂等键：\`${revisionKey}\``);
  return lines.join('\n');
}

/**
 * satisfied 终态的外部回执：同步 `status:satisfied` 标签并幂等写一句“无需代码变更”评论。
 * 状态在调用前已持久化，本函数失败不丢失成功证据，只返回 false 等待下轮补同步。
 */
async function syncSatisfiedReceipt(
  core: Core,
  issueNumber: number,
  reqId: string,
  specHash: string,
  sourceMainSha: string,
  candidateTreeSha: string,
): Promise<boolean> {
  // 幂等键绑定完整 revision；响应丢失后重放可以识别此前已提交的回执。
  const marker = `回执幂等键：\`${satisfiedReceiptKey(reqId, specHash, sourceMainSha, candidateTreeSha)}\``;
  const results: boolean[] = [];
  try {
    await core.github.removeLabels(issueNumber, STATUS_LABELS);
    await core.github.addLabels(issueNumber, ['pi-task', 'status:satisfied']);
    results.push(true);
  } catch {
    results.push(false);
  }
  try {
    const comments = await core.github.listIssueComments(issueNumber);
    const already = comments.some((c) => c.body.includes(marker));
    if (!already) {
      await core.github.comment(
        issueNumber,
        satisfiedReceiptText(reqId, specHash, sourceMainSha, candidateTreeSha),
      );
    }
    results.push(true);
  } catch {
    results.push(false);
  }
  return results.every(Boolean);
}

/** 重启后仅恢复未完成的 satisfied 回执阶段；不重跑 Pi，旧 revision 只清标记不污染新需求。 */
export async function syncPendingSatisfiedReceipts(core: Core): Promise<void> {
  const pending = Object.values(core.state.snapshot().jobs).filter(
    (job) => job.status === 'satisfied' && job.resumeAction === 'sync-satisfied-receipt',
  );
  for (const job of pending) {
    const current = core.state.snapshot();
    const requirement = current.requirements[job.reqId];
    if (isSupersededWorkerRecovery(current, job)) continue;
    if (
      !requirement ||
      requirement.issueNumber !== job.issueNumber ||
      requirement.specHash !== job.specHash ||
      requirement.sourceMainSha !== job.sourceMainSha ||
      !/^[0-9a-f]{40}$/.test(job.candidateTreeSha ?? '')
    ) {
      await core.state.update((s) => {
        const target = s.jobs[job.jobId];
        if (target && target.resumeAction === 'sync-satisfied-receipt') target.resumeAction = undefined;
        return undefined;
      });
      continue;
    }
    const ok = await syncSatisfiedReceipt(
      core,
      job.issueNumber,
      job.reqId,
      job.specHash,
      job.sourceMainSha,
      job.candidateTreeSha!,
    );
    if (!ok) continue;
    await core.state.update((s) => {
      const target = s.jobs[job.jobId];
      if (target && target.resumeAction === 'sync-satisfied-receipt') target.resumeAction = undefined;
      return undefined;
    });
  }
}

function isSupersededWorkerRecovery(state: OrchestratorState, job: JobState): boolean {
  const baselineSupercedes = Object.values(state.retryBaselines ?? {}).some(
    (baseline) =>
      // 旧 Job 一经记录为审计前驱，任何阶段都必须冻结其恢复字段。
      baseline.fromJobId === job.jobId ||
      (baseline.newJobId === job.jobId &&
        (baseline.stage === 'prepared' || baseline.stage === 'stale')),
  );
  if (baselineSupercedes) return true;
  return Object.values(state.jobs).some((candidate) => {
    if (
      candidate.jobId === job.jobId ||
      candidate.reqId !== job.reqId ||
      candidate.issueNumber !== job.issueNumber
    ) {
      return false;
    }
    const candidateRevision = candidate.dispatchRevision;
    const jobRevision = job.dispatchRevision;
    if (candidateRevision !== undefined || jobRevision !== undefined) {
      const left = candidateRevision ?? 0;
      const right = jobRevision ?? 0;
      if (left !== right) return left > right;
    }
    return (
      candidate.specHash === job.specHash &&
      candidate.sourceMainSha === job.sourceMainSha &&
      candidate.attempt > job.attempt
    );
  });
}

/**
 * CAS 将已领取的 todo 作业原子转为 processing，并把本版许可刷新为最新事件。
 * 只有仍处于 todo 且绑定仍与输入一致时才成功，防止同 job 并发双调 Pi。
 * 返回 false 表示已被并发领取或状态已变，调用方等待而不重复启动。
 */
async function transitionDispatchToProcessing(
  core: Core,
  input: WorkerInput,
  grant: DispatchGrant,
): Promise<boolean> {
  const jobId = input.jobId;
  let transitioned = false;
  await core.state.update((state) => {
    const job = state.jobs[jobId];
    if (
      !job ||
      job.status !== 'todo' ||
      job.reqId !== input.reqId ||
      job.issueNumber !== input.issueNumber ||
      job.specHash !== input.spec.hash ||
      job.sourceMainSha !== input.sourceMainSha ||
      job.dispatchRevision !== input.dispatchRevision?.revision
    ) {
      return undefined;
    }
    job.status = 'processing';
    job.grantEventId = grant.eventId;
    job.updatedAt = new Date().toISOString();
    transitioned = true;
    return undefined;
  });
  return transitioned;
}

/** 统一 Worker 生命周期：本地状态、GitHub 标签、失败评论与通知保持同一条状态机。 */
export async function runOneWorkerForInput(core: Core, input: WorkerInput): Promise<WorkerOutcome> {
  const jobId = input.jobId;
  const snapshot = core.state.snapshot();
  const requirement = snapshot.requirements[input.reqId];
  // 受管派工需求以生产门禁 isGated 为准，并用已存在历史兜底，防止首次发布记录
  // 落盘前的直接重试绕过领取。旧 REQ 需求既无门禁也无历史，保持原直通行为。
  const isGatedReq = core.reconcileContext?.dispatch?.isGated(input.reqId) ?? false;
  const gatedReq = isGatedReq || hasDispatchHistory(snapshot, input.reqId);
  let freshGrant: DispatchGrant | undefined;
  if (gatedReq) {
    const claimedJob = snapshot.jobs[jobId];
    if (input.dispatchRevision === undefined) {
      core.logger.warn(`拒绝 ${input.reqId} 未领取的派工调用（缺少 dispatchRevision）`);
      return {
        status: 'stale',
        error: `需求 ${input.reqId} 为受管派工需求，缺少冻结领取记录，拒绝未授权调用`,
        failureStage: 'publish',
      };
    }
    if (
      !claimedJob ||
      claimedJob.dispatchRevision !== input.dispatchRevision.revision ||
      claimedJob.status !== 'todo'
    ) {
      core.logger.warn(`拒绝 ${input.reqId} 已领取或已执行作业重复调用 Pi（job ${jobId}）`);
      return {
        status: 'stale',
        error: `需求 ${input.reqId} r${input.dispatchRevision.revision} 作业已领取或已执行，禁止重复调用 Pi`,
        failureStage: 'publish',
      };
    }
    // 在 todo→processing 之前刷新远端许可：空名单、领取后撤标或新打标都会让本版失效。
    // 这里用最新远端事件而非输入携带的旧 grant，防止显式重试绕过最新授权。
    const refreshed = await refreshDispatchClaim(core, input.reqId, input.issueNumber);
    if (!refreshed || refreshed.revision.revision !== input.dispatchRevision.revision) {
      core.logger.warn(`拒绝 ${input.reqId} r${input.dispatchRevision.revision} 当前无有效开工许可，等待`);
      return {
        status: 'stale',
        error: `需求 ${input.reqId} r${input.dispatchRevision.revision} 当前无有效开工许可，未启动 Pi`,
        failureStage: 'publish',
      };
    }
    freshGrant = refreshed.grant;
  }
  const currentDispatchRevision =
    input.dispatchRevision !== undefined
      ? latestDispatchRevisionFor(snapshot, input.reqId)
      : undefined;
  // 新 revision 已接管该 Issue 时，旧作业不再写 GitHub，避免把新需求标成 failed。
  if (
    !requirement ||
    requirement.issueNumber !== input.issueNumber ||
    requirement.specHash !== input.spec.hash ||
    requirement.sourceMainSha !== input.sourceMainSha ||
    (input.dispatchRevision !== undefined &&
      (currentDispatchRevision === undefined ||
        currentDispatchRevision.revision !== input.dispatchRevision.revision))
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
        ...(input.dispatchRevision !== undefined
          ? {
              dispatchRevision: input.dispatchRevision.revision,
              ...(currentDispatchRevision?.grant?.eventId !== undefined
                ? { grantEventId: currentDispatchRevision.grant.eventId }
                : {}),
            }
          : {}),
        startedAt: now,
        updatedAt: now,
      };
      return undefined;
    });
    await markWorkerOutcome(core, jobId, stale);
    await notifyBestEffort(core, `⏭️ ${issueLink(core, input.issueNumber)} 需求版本已变化，旧作业停止`);
    return stale;
  }

  if (gatedReq) {
    // CAS 领取：只有仍处于 todo 且绑定一致才真正转为 processing，防同 job 并发双调。
    const transitioned = await transitionDispatchToProcessing(core, input, freshGrant!);
    if (!transitioned) {
      core.logger.warn(`拒绝 ${input.reqId} r${input.dispatchRevision!.revision} 作业已并发领取或状态变化`);
      return {
        status: 'stale',
        error: `需求 ${input.reqId} r${input.dispatchRevision!.revision} 作业已并发领取或状态变化，未启动 Pi`,
        failureStage: 'publish',
      };
    }
  } else {
    await core.state.update((s) => {
      const previous = s.jobs[jobId];
      const preserveTrustedHead =
        previous &&
        previous.reqId === input.reqId &&
        previous.issueNumber === input.issueNumber &&
        previous.specHash === input.spec.hash &&
        previous.sourceMainSha === input.sourceMainSha &&
        previous.attempt === input.attempt &&
        previous.dispatchRevision === input.dispatchRevision?.revision
          ? previous.headSHA
          : undefined;
      s.jobs[jobId] = {
        jobId,
        reqId: input.reqId,
        issueNumber: input.issueNumber,
        specHash: input.spec.hash,
        sourceMainSha: input.sourceMainSha,
        attempt: input.attempt,
        status: 'processing',
        headSHA: preserveTrustedHead,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return undefined;
    });
  }

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
  const outcome = validateSatisfiedOutcome(await runner(core.workerDeps, input));
  await markWorkerOutcome(core, jobId, outcome);

  if (outcome.status === 'stale') {
    await notifyBestEffort(core, `⏭️ ${issueUrl} ${outcome.error ?? '作业已过期'}`);
    return outcome;
  }

  if (outcome.status === 'satisfied') {
    const receiptOk = await syncSatisfiedReceipt(
      core,
      input.issueNumber,
      input.reqId,
      input.spec.hash,
      input.sourceMainSha,
      outcome.candidateTreeSha!,
    );
    if (!receiptOk) {
      await notifyBestEffort(core, `⚠️ ${issueUrl} 已验收，GitHub 回执待补；不会重跑 Pi`);
      return outcome;
    }
    await core.state.update((s) => {
      const job = s.jobs[jobId];
      if (job && job.status === 'satisfied') {
        job.resumeAction = undefined;
        job.updatedAt = new Date().toISOString();
      }
      return undefined;
    });
    await notifyBestEffort(
      core,
      `✅ ${issueUrl} 已验收无需代码变更${outcome.candidateTreeSha ? `（候选树 ${outcome.candidateTreeSha.slice(0, 8)}）` : ''}`,
    );
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
    jobId: target.jobId ?? `job-${target.reqId}-${target.attempt}-${Date.now()}`,
    reqId: target.reqId,
    issueNumber: target.issueNumber,
    spec: target.spec,
    sourceMainSha: target.sourceMainSha,
    attempt: target.attempt,
    ...(target.dispatchRevision ? { dispatchRevision: target.dispatchRevision } : {}),
  };
  return runOneWorkerForInput(core, input);
}

const runOnceQueues = new WeakMap<Core, Promise<void>>();

async function runOnceUnlocked(core: Core): Promise<{
  summary: ReconcileSummary | null;
  workers: WorkerOutcome[];
  deploy: DeployResult;
}> {
  try {
    await core.mergeService?.reconcilePending();
  } catch (error) {
    core.logger.warn(
      `合并记录只读对账失败（本轮跳过）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await reconcileSpecRequests(core.specIntakeDeps);
  } catch (error) {
    core.logger.warn(`spec 请求远端对账失败（本轮跳过）: ${error instanceof Error ? error.message : String(error)}`);
  }
  await syncPendingStatusLabels(core);
  await syncPendingSatisfiedReceipts(core);
  // 先把已登记的重试准备恢复到 ready/stale，再进入常规对账；
  // 这样未决准备只作为短期防护存在，不会让权威删除/更新差量被静默吞掉。
  if (core.retryBaselineDeps) {
    await resumeRetryBaselines(core.retryBaselineDeps);
  }
  // applyReconciliation 关键操作失败会抛错（不推进游标），此处不捕获：
  // 异常向上传播，跳过 Worker 派发与部署，等待下轮重放差量。
  const summary = await reconcileWithPlanner(core.reconcileContext, core.planner);
  const workers: WorkerOutcome[] = [];
  if (summary) {
    const targets = pickWorkerTargets(core.state.snapshot(), summary.specs);
    for (const target of targets) {
      const claimed = await claimDispatchTarget(core, target);
      if (!claimed) continue;
      workers.push(await runOneWorker(core, claimed));
    }
  }
  const deploy = await deployOnce(core.deployDeps);
  return { summary, workers, deploy };
}

/** 同一 Core 的轮询串行执行，避免并发 fetch 抢同一个 origin/main 跟踪引用。 */
export async function runOnce(core: Core): Promise<{
  summary: ReconcileSummary | null;
  workers: WorkerOutcome[];
  deploy: DeployResult;
}> {
  const previous = runOnceQueues.get(core) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  runOnceQueues.set(core, tail);
  await previous;
  try {
    return await runOnceUnlocked(core);
  } finally {
    release();
    if (runOnceQueues.get(core) === tail) {
      runOnceQueues.delete(core);
    }
  }
}
