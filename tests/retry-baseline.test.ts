import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { GitClient } from '../orchestrator/git.ts';
import { encodeMetaBlock, extractMeta, GithubClient, type GhRunner } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { createCore, runOnce, runOneWorkerForInput, type Core } from '../orchestrator/runtime.ts';
import { retryDeployForIssue } from '../orchestrator/deploy.ts';
import {
  baselineOperationId,
  prepareRetryBaseline,
  persistRetryBaselinePrepared,
  resumeRetryBaselines,
  retryWithBaseline,
  syncRetryBaselinePrepared,
  type PublishDispatchRevisionInput,
  type RetryBaselineHooks,
} from '../orchestrator/retry-baseline.ts';
import { reconcileOnce } from '../orchestrator/scheduler.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { StateStore, normalizeRetryBaselineLinks } from '../orchestrator/state.ts';
import {
  emptyState,
  type DispatchRevision,
  type ManagedIssue,
  type ManagedPR,
  type OrchestratorState,
  type Spec,
} from '../orchestrator/types.ts';
import type { RetryBaselineDeps } from '../orchestrator/retry-baseline.ts';
import { loadConfig, type Config } from '../orchestrator/config.ts';
import type { WorkerDeps, WorkerInput, WorkerOutcome } from '../orchestrator/worker.ts';

const execFileAsync = promisify(execFile);
const REQ_ID = 'REQ-COMPAT-01';
const COUNTER_REQ_ID = 'REQ-CNT-01';
const SPEC_PATH = 'docs/specs/counter.md';
const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const sourceController = new URL('../', import.meta.url).pathname;

function doc(text = '计数器初始需求', reqId = REQ_ID): string {
  return `### [${reqId}] 计数器\n\n${text}\n`;
}

function specOf(text: string): Spec {
  const parsed = parseSpecs({ [SPEC_PATH]: text });
  assert.equal(parsed.errors.length, 0);
  return parsed.specs[0]!;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Spec Loop Test',
      GIT_AUTHOR_EMAIL: 'spec-loop-test@example.invalid',
      GIT_COMMITTER_NAME: 'Spec Loop Test',
      GIT_COMMITTER_EMAIL: 'spec-loop-test@example.invalid',
    },
  });
  return result.stdout.trim();
}

class FakeGithub {
  issue: ManagedIssue;
  prs: ManagedPR[] = [];
  branches = new Set<string>();
  dispatchLabelEvents: Array<{
    id: number;
    actorId: number | null;
    name: string;
    event: 'labeled' | 'unlabeled';
    createdAt: string;
  }> = [];
  issueUpdates: string[] = [];
  issueUpdateAttempts = 0;
  loseFirstIssueResponse = false;
  failIssueRead = false;
  failPRRead = false;
  failRepoIdRead = false;
  repoId = '9001';
  restoreOldIssueAfterUpdate = false;
  nextPRNumber = 42;

  constructor(body: string) {
    this.issue = { number: 12, title: '[REQ-CNT-01] 计数器', body, state: 'open', labels: [], meta: null };
  }

  resetCalls(): void {
    this.issueUpdates = [];
    this.issueUpdateAttempts = 0;
  }

  readonly runner: GhRunner = async (args) => {
    if (args[0] === 'pr' && args[1] === 'create') {
      const fileIndex = args.indexOf('--body-file');
      const headIndex = args.indexOf('--head');
      const body = fileIndex >= 0 ? readFileSync(args[fileIndex + 1]!, 'utf8') : '';
      const number = this.nextPRNumber++;
      this.prs.push({
        number,
        title: args[args.indexOf('--title') + 1] ?? '',
        body,
        state: 'open',
        merged: false,
        headRefName: args[headIndex + 1] ?? '',
        baseRefName: args[args.indexOf('--base') + 1] ?? 'main',
        meta: extractMeta(body),
        url: `https://example.invalid/pull/${number}`,
      });
      return { stdout: `https://example.invalid/pull/${number}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return { stdout: '{}', stderr: '', code: 0 };
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      if (args.includes('--add-label') || args.includes('--remove-label')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      this.issueUpdateAttempts += 1;
      const fileIndex = args.indexOf('--body-file');
      const body = fileIndex >= 0 ? readFileSync(args[fileIndex + 1]!, 'utf8') : this.issue.body;
      this.issue = { ...this.issue, body, meta: extractMeta(body) };
      this.issueUpdates.push(body);
      if (this.loseFirstIssueResponse && this.issueUpdateAttempts === 1) {
        this.loseFirstIssueResponse = false;
        return { stdout: '', stderr: '模拟 Issue 更新响应丢失', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({
          number: this.issue.number,
          state: this.issue.state,
          labels: this.issue.labels.map((name) => ({ name })),
        }),
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'issue' && (args[1] === 'comment' || args[1] === 'close' || args[1] === 'reopen')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'label') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'pr' && args[1] === 'close') return { stdout: '', stderr: '', code: 0 };
    if (args[0] !== 'api') return { stdout: '', stderr: '', code: 0 };
    const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
    if (args[1] === 'user') {
      return { stdout: JSON.stringify({ id: 4242 }), stderr: '', code: 0 };
    }
    if (path === 'repos/owner/repo') {
      if (this.failRepoIdRead) return { stdout: '', stderr: '模拟仓库 ID 读取失败', code: 1 };
      return { stdout: JSON.stringify({ id: Number(this.repoId) }), stderr: '', code: 0 };
    }
    if (path === `repos/owner/repo/issues/${this.issue.number}`) {
      return {
        stdout: JSON.stringify({
          ...this.issue,
          labels: this.issue.labels.map((name) => ({ name })),
        }),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/owner/repo/issues/${this.issue.number}/events?per_page=100`) {
      return {
        stdout: JSON.stringify([this.dispatchLabelEvents.map((event) => ({
          id: event.id,
          event: event.event,
          actor: event.actorId === null ? null : { id: event.actorId },
          label: { name: event.name },
          created_at: event.createdAt,
        }))]),
        stderr: '',
        code: 0,
      };
    }
    if (/\/issues\/\d+\/comments\?/.test(path)) {
      return { stdout: JSON.stringify([[]]), stderr: '', code: 0 };
    }
    if (/\/issues(?:\?|$)/.test(path)) {
      if (this.failIssueRead) return { stdout: '', stderr: '模拟 Issue 读取失败', code: 1 };
      return { stdout: JSON.stringify([[{ ...this.issue, labels: this.issue.labels.map((name) => ({ name })) }]]), stderr: '', code: 0 };
    }
    if (/\/pulls(?:\?|$)/.test(path)) {
      if (this.failPRRead) return { stdout: '', stderr: '模拟 PR 读取失败', code: 1 };
      return {
        stdout: JSON.stringify([this.prs.map((pr) => ({
          number: pr.number,
          title: pr.title,
          body: pr.body || (pr.meta ? encodeMetaBlock(pr.meta) : ''),
          state: pr.state,
          merged_at: pr.merged ? '2026-11-16T00:00:00Z' : null,
          head: { ref: pr.headRefName, sha: pr.headSHA },
          base: { ref: pr.baseRefName },
          merge_commit_sha: pr.mergeCommitSha,
          html_url: pr.url,
        }))]),
        stderr: '',
        code: 0,
      };
    }
    const branch = /\/git\/ref\/heads\/(.+)$/.exec(path)?.[1];
    if (branch) {
      if (this.branches.has(branch)) {
        return { stdout: JSON.stringify({ object: { sha: 'a'.repeat(40) } }), stderr: '', code: 0 };
      }
      // 与 defaultGhRunner 的失败结果一致；明确 404 才表示分支不存在。
      return { stdout: '', stderr: `gh api repos/owner/repo/git/ref/heads/${branch}: HTTP 404 Not Found`, code: 1 };
    }
    return { stdout: '', stderr: '模拟不支持的 gh api', code: 1 };
  };
}

interface BaselineFixture {
  root: string;
  repo: string;
  stateFile: string;
  trustedE2eRoot: string;
  reqId: string;
  store: StateStore;
  oldSha: string;
  newSha: string;
  futureSha: string;
  spec: Spec;
  github: FakeGithub;
  gitClient: GitClient;
  workerCalls: WorkerInput[];
  workerOutcomes: WorkerOutcome[];
  workerLogs: string[];
  core?: Core;
  dispose: () => void;
}

async function createFixture(options: {
  sameSha?: boolean;
  changedSpec?: boolean;
  noContract?: boolean;
  reqId?: string;
  counterRevision?: 'published-granted' | 'published' | 'unpublished';
} = {}): Promise<BaselineFixture> {
  const reqId = options.reqId ?? REQ_ID;
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-retry-baseline-'));
  const repo = join(root, 'repo');
  const trustedE2eRoot = join(root, 'trusted-controller');
  mkdirSync(join(repo, 'docs', 'specs'), { recursive: true });
  await git(root, ['init', '-q', '--bare', join(root, 'remote.git')]);
  await git(root, ['init', '-q', repo]);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['remote', 'add', 'origin', join(root, 'remote.git')]);
  const initial = doc('计数器初始需求', reqId);
  writeFileSync(join(repo, SPEC_PATH), initial);
  await git(repo, ['add', SPEC_PATH]);
  await git(repo, ['commit', '-qm', 'initial docs']);
  const oldSha = await git(repo, ['rev-parse', 'HEAD']);
  await pushMain(repo);

  mkdirSync(join(trustedE2eRoot, 'tests', 'e2e', 'contracts'), { recursive: true });
  const oldSpec = specOf(initial);
  const contractPath = join(trustedE2eRoot, 'tests', 'e2e', 'contracts', 'counter.json');
  if (!options.noContract && reqId === COUNTER_REQ_ID) {
    writeFileSync(contractPath, JSON.stringify({
      reqId,
      specPath: SPEC_PATH,
      specHash: oldSpec.hash,
      caseIds: ['E2E-CNT-001'],
    }));
  }

  let newSha = oldSha;
  if (!options.sameSha) {
    if (!options.changedSpec) writeFileSync(join(repo, 'README.md'), 'controller merge\n');
    else writeFileSync(join(repo, SPEC_PATH), doc('新版本', reqId));
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'new main']);
    newSha = await git(repo, ['rev-parse', 'HEAD']);
    await pushMain(repo);
  }
  // 临时工作库模拟控制器的 main；不以旧 SHA 反向创建分支，避免正常推进被误判为 force-push。
  await git(repo, ['checkout', '-q', '-B', 'controller', newSha]);
  await git(repo, ['update-ref', 'refs/heads/main', newSha]);
  writeFileSync(join(repo, 'future.txt'), 'future controller main\n');
  await git(repo, ['add', 'future.txt']);
  await git(repo, ['commit', '-qm', 'future main']);
  const futureSha = await git(repo, ['rev-parse', 'HEAD']);
  await pushBranch(repo, 'future');
  await git(repo, ['checkout', '-q', '-B', 'controller', newSha]);
  const spec = specOf(initial);
  const issueMeta = {
    schema: 1,
    system: 'spec-loop',
    kind: 'requirement',
    reqId,
    specPath: SPEC_PATH,
    specHash: spec.hash,
    sourceMainSha: oldSha,
    operationKey: `${spec.hash}:${oldSha}:requirement`,
  };
  const github = new FakeGithub(`${doc('计数器初始需求', reqId)}\n\n${encodeMetaBlock(issueMeta)}`);
  github.issue.meta = issueMeta;
  if (options.counterRevision === 'published-granted') {
    github.issue.labels = ['可开工/r1'];
    github.dispatchLabelEvents = [{
      id: 8101,
      actorId: 4242,
      name: '可开工/r1',
      event: 'labeled',
      createdAt: '2026-11-20T00:01:00.000Z',
    }];
  }
  const stateFile = join(repo, '.orchestrator-state.json');
  const state: OrchestratorState = {
    ...emptyState(),
    repo: 'owner/repo',
    cursorMainSha: oldSha,
    requirements: {
      [reqId]: { issueNumber: 12, specPath: SPEC_PATH, specHash: spec.hash, sourceMainSha: oldSha },
    },
    jobs: {
      oldJob: {
        jobId: 'oldJob',
        reqId,
        issueNumber: 12,
        specHash: spec.hash,
        sourceMainSha: oldSha,
        attempt: 1,
        status: 'failed',
        failureStage: 'verify',
        resumeAction: 'worker',
        startedAt: '2026-11-15T00:00:00Z',
        updatedAt: '2026-11-15T00:00:00Z',
      },
    },
    dispatchRevisions: options.counterRevision
      ? {
          [reqId]: [{
            reqId,
            repoId: '9001',
            revision: 1,
            issueNumber: 12,
            specHash: spec.hash,
            specPath: SPEC_PATH,
            sourceMainSha: oldSha,
            task: {
              goal: '实现计数器需求',
              steps: [{ text: '完成计数器实现', acceptanceRefs: ['A1'] }],
              acceptance: { A1: '计数器可用' },
              allowedPaths: ['src/**'],
              dependsOn: [],
            },
            ...(options.counterRevision === 'unpublished'
              ? {}
              : {
                  publishedAt: '2026-11-20T00:00:00.000Z',
                  publicationCommentId: 7001,
                }),
            ...(options.counterRevision === 'published-granted'
              ? {
                  grant: {
                    eventId: 8101,
                    actorId: '4242',
                    grantedAt: '2026-11-20T00:01:00.000Z',
                  },
                }
              : {}),
          }],
        }
      : {},
  };
  // 按生产顺序先加载状态，再通过 StateStore 的真实持久化路径初始化夹具。
  const store = new StateStore(stateFile);
  store.load();
  await store.update((current) => Object.assign(current, state));
  return {
    root,
    repo,
    stateFile,
    trustedE2eRoot,
    reqId,
    store,
    oldSha,
    newSha,
    futureSha,
    spec,
    github,
    gitClient: new GitClient(undefined, {
      repo: 'owner/repo',
      mainBranch: 'main',
      repositoryId: 'github-repository-id:9001',
      issueNumber: 18,
      confirmedMainSha: oldSha,
      specHash: spec.hash,
    }),
    workerCalls: [],
    workerOutcomes: [],
    workerLogs: [],
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 使用 sourceController 的固定本地远端传输，隔离外部 Git 配置和网络。 */
async function gitWithTestTransport(cwd: string, args: string[]): Promise<string> {
  return git(cwd, ['-c', `url.file://${sourceController}.insteadOf=file://`, ...args]);
}

async function pushBranch(repo: string, branch: string): Promise<void> {
  await gitWithTestTransport(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
}

async function pushMain(repo: string): Promise<void> {
  await pushBranch(repo, 'main');
}

function baselineDeps(
  fx: BaselineFixture,
  hooks?: RetryBaselineHooks,
  options: Pick<RetryBaselineDeps, 'publishDispatchRevision'> = {},
) {
  const github = new GithubClient('owner/repo', fx.github.runner);
  let deployCalls = 0;
  return {
    deps: {
      repoDir: fx.repo,
      state: fx.store,
      git: fx.gitClient,
      github,
      logger,
      trustedE2eRoot: fx.trustedE2eRoot,
      retryWorker: (input: WorkerInput): Promise<WorkerOutcome> =>
        runOneWorkerForInput(fx.core!, input),
      findExistingDelivery: undefined as RetryBaselineDeps['findExistingDelivery'],
      retryDeploy: async () => {
        deployCalls += 1;
        return { status: 'nothing' as const };
      },
      mainBranch: 'main',
      hooks,
      publishDispatchRevision: options.publishDispatchRevision,
    },
    github,
    deployCalls: () => deployCalls,
  };
}

function productionDeps(core: Core, github: GithubClient, hooks?: RetryBaselineHooks): RetryBaselineDeps {
  return {
    repoDir: core.retryBaselineDeps!.repoDir,
    state: core.state,
    git: core.retryBaselineDeps!.git,
    github,
    logger: core.retryBaselineDeps!.logger,
    retryWorker: (input) => runOneWorkerForInput(core, input),
    retryDeploy: core.retryBaselineDeps!.retryDeploy,
    trustedE2eRoot: core.workerDeps.browserE2eRoot,
    mainBranch: core.retryBaselineDeps!.mainBranch,
    hooks,
  };
}

function coreConfig(fx: BaselineFixture): Config {
  const config = loadConfig(fx.repo);
  return fx.reqId === COUNTER_REQ_ID
    ? { ...config, dispatchAllowedUserIds: ['4242'] }
    : config;
}

function useProductionCommands(fx: BaselineFixture): void {
  const config = coreConfig(fx);
  const core = createCore(config, 'owner/repo');
  const github = new GithubClient('owner/repo', fx.github.runner);
  Object.assign(core, { github });
  Object.assign(core.workerDeps, { github });
  Object.assign(core.deployDeps, { github });
  Object.assign(core.reconcileContext, { github });
  Object.assign(core.specIntakeDeps, { github });
  Object.assign(core.retryBaselineDeps!, { github });
  core.workerDeps.browserE2eRoot = fx.trustedE2eRoot;
  core.retryBaselineDeps!.trustedE2eRoot = fx.trustedE2eRoot;
  core.workerDeps.runBrowserGate = async () => ({
    ok: true,
    detail: '测试门禁通过',
    reportDir: join(fx.root, 'browser-report'),
    reportPath: join(fx.root, 'browser-report', 'results.json'),
    stdoutLogPath: join(fx.root, 'browser-report', 'stdout.log'),
    stderrLogPath: join(fx.root, 'browser-report', 'stderr.log'),
  });
  core.workerRunner = async (_deps, input) => {
    fx.workerCalls.push(input);
    return { status: 'published', prNumber: 42 };
  };
  fx.store = core.state;
  fx.core = core;
}

function refreshFixture(fx: BaselineFixture): void {
  fx.store = new StateStore(fx.stateFile);
  fx.store.load();
  Object.assign(fx.core!.state, fx.store);
  Object.assign(fx.core!.workerDeps, { state: fx.store });
  Object.assign(fx.core!.deployDeps, { state: fx.store });
  Object.assign(fx.core!.reconcileContext, { state: fx.store });
  Object.assign(fx.core!.specIntakeDeps, { state: fx.store });
  Object.assign(fx.core!.retryBaselineDeps!, { state: fx.store });
  const requirement = fx.store.snapshot().requirements[REQ_ID];
  if (!requirement) return;
  const meta = {
    schema: 1,
    system: 'spec-loop',
    kind: 'requirement',
    reqId: REQ_ID,
    specPath: SPEC_PATH,
    specHash: requirement.specHash,
    sourceMainSha: requirement.sourceMainSha,
    operationKey: `${requirement.specHash}:${requirement.sourceMainSha}:requirement`,
  };
  fx.github.issue = {
    ...fx.github.issue,
    body: `${doc()}\n\n${encodeMetaBlock(meta)}`,
    meta,
  };
}

async function markFixtureReleased(fx: BaselineFixture): Promise<void> {
  await fx.store.update((state) => {
    state.requirements[REQ_ID] = {
      ...state.requirements[REQ_ID]!,
      sourceMainSha: fx.newSha,
    };
    state.jobs.oldJob = {
      ...state.jobs.oldJob!,
      sourceMainSha: fx.newSha,
    };
    state.cursorMainSha = fx.newSha;
    return undefined;
  });
  const issueMeta = {
    schema: 1,
    system: 'spec-loop',
    kind: 'requirement',
    reqId: REQ_ID,
    specPath: SPEC_PATH,
    specHash: fx.spec.hash,
    sourceMainSha: fx.newSha,
    operationKey: `${fx.spec.hash}:${fx.newSha}:requirement`,
  };
  fx.github.issue = {
    ...fx.github.issue,
    body: `${doc()}\n\n${encodeMetaBlock(issueMeta)}`,
    meta: issueMeta,
  };
}

function useRealCore(
  fx: BaselineFixture,
  worker: (deps: WorkerDeps, input: WorkerInput) => Promise<WorkerOutcome>,
): Core {
  const config = coreConfig(fx);
  mkdirSync(config.runDir, { recursive: true });
  const core = createCore(config, 'owner/repo');
  // createCore 默认持有生产 GitHub 客户端；测试仅替换远端接口，Git/State/生命周期保持真实。
  core.github = new GithubClient('owner/repo', fx.github.runner);
  core.workerDeps.github = core.github;
  core.retryBaselineDeps!.github = core.github;
  core.retryBaselineDeps!.findExistingDelivery = (input) => findExistingDeliveryForTest(core, input);
  core.deployDeps.github = core.github;
  core.reconcileContext.github = core.github;
  core.specIntakeDeps.github = core.github;
  core.retryBaselineDeps!.retryDeploy = (issueNumber, prNumber) =>
    retryDeployForIssue(core.deployDeps, issueNumber, prNumber);
  core.workerDeps.browserE2eRoot = fx.trustedE2eRoot;
  core.retryBaselineDeps!.trustedE2eRoot = fx.trustedE2eRoot;
  // 实际生命周期由同一 createCore 的 runner 给出合法结局；状态写入沿用 runOneWorkerForInput。
  core.workerDeps.piProvider = 'test-provider';
  core.workerDeps.piModel = 'test-model';
  core.workerDeps.verify = async () => [
    'typecheck',
    'test',
    'build',
  ].map((name) => ({ name, ok: true, stdout: 'ok', stderr: '', code: 0 }));
  core.workerDeps.logger = {
    info(message: string) {
      fx.workerLogs.push(message);
    }, warn(message: string) {
      fx.workerLogs.push(message);
    }, error() {}, debug() {},
  };
  core.workerDeps.runBrowserGate = async () => ({
    ok: true,
    detail: '测试门禁通过',
    reportDir: join(fx.root, 'browser-report'),
    reportPath: join(fx.root, 'browser-report', 'results.json'),
    stdoutLogPath: join(fx.root, 'browser-report', 'stdout.log'),
    stderrLogPath: join(fx.root, 'browser-report', 'stderr.log'),
  });
  core.workerRunner = async (_deps, input) => {
    const outcome = await worker({ ..._deps, verify: core.workerDeps.verify }, input);
    // runOneWorker 在真实 WorkerRunner 返回后才写 in-review；测试故障只决定本次结局。
    return outcome;
  };
  fx.store = core.state;
  fx.core = core;
  return core;
}

async function findExistingDeliveryForTest(core: Core, input: WorkerInput): Promise<ManagedPR | null> {
  const matches = (await core.github.listPRs()).filter(
    (pr) =>
      pr.meta?.kind === 'code-pr' &&
      pr.meta.reqId === input.reqId &&
      pr.meta.specHash === input.spec.hash &&
      pr.meta.sourceMainSha === input.sourceMainSha &&
      (pr.state === 'open' || pr.merged),
  );
  if (matches.length > 1) throw new Error('测试远端存在多个当前 revision 交付 PR');
  return matches[0] ?? null;
}

function coreOutcomeQueue(
  fx: BaselineFixture,
  outcomes: WorkerOutcome[],
): (deps: WorkerDeps, input: WorkerInput) => Promise<WorkerOutcome> {
  const queue = [...outcomes];
  return async (deps, input) => {
    void deps;
    const outcome = queue.shift();
    if (!outcome) throw new Error(`未配置 ${input.jobId} 的 Worker 结局`);
    fx.workerCalls.push(structuredClone(input));
    fx.workerOutcomes.push(structuredClone(outcome));
    return outcome;
  };
}

function counterPublisher(fx: BaselineFixture): {
  publishDispatchRevision: NonNullable<RetryBaselineDeps['publishDispatchRevision']>;
  calls: PublishDispatchRevisionInput[];
} {
  const calls: PublishDispatchRevisionInput[] = [];
  return {
    calls,
    publishDispatchRevision: async (input) => {
      calls.push(structuredClone(input));
      let published: DispatchRevision | undefined;
      await fx.store.update((state) => {
        const revisions = state.dispatchRevisions?.[input.reqId] ?? [];
        const existing = revisions.find(
          (revision) =>
            revision.specHash === input.spec.hash &&
            revision.sourceMainSha === input.targetMainSha &&
            revision.publishedAt === undefined,
        );
        if (existing) {
          existing.publishedAt = '2026-11-21T01:00:00.000Z';
          existing.publicationCommentId = 9000 + existing.revision;
          const frozen = structuredClone(existing);
          delete frozen.publishedAt;
          delete frozen.publicationCommentId;
          published = frozen;
          return undefined;
        }
        const revision = Math.max(0, ...revisions.map((candidate) => candidate.revision)) + 1;
        const created: DispatchRevision = {
          reqId: input.reqId,
          repoId: input.repoId,
          revision,
          issueNumber: input.issueNumber,
          specHash: input.spec.hash,
          specPath: input.spec.path,
          sourceMainSha: input.targetMainSha,
          task: {
            goal: '按当前已确认规格重新排期',
            steps: [{ text: '完成当前需求', acceptanceRefs: ['A1'] }],
            acceptance: { A1: '当前需求验收通过' },
            allowedPaths: ['src/**'],
            dependsOn: [],
          },
          publishedAt: '2026-11-21T01:00:00.000Z',
          publicationCommentId: 9000 + revision,
        };
        state.dispatchRevisions ??= {};
        state.dispatchRevisions[input.reqId] = [...revisions, created];
        for (const prior of state.dispatchRevisions[input.reqId]!) {
          if (prior.revision !== revision && prior.grant) delete prior.grant;
        }
        const frozen = structuredClone(created);
        delete frozen.publishedAt;
        delete frozen.publicationCommentId;
        published = frozen;
        return undefined;
      });
      if (!published) throw new Error('测试发布器未生成冻结版本');
      return published;
    },
  };
}

function assertOriginalJob(fx: BaselineFixture, original: OrchestratorState['jobs'][string]): void {
  assert.deepEqual(fx.store.snapshot().jobs.oldJob, original);
}

test('真实 StateStore/Git：旧 SHA 合并后 main 保留旧 Job、建立新基线并交给 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [
      { status: 'published', prNumber: 43 },
    ]));
    const originalJob = fx.store.snapshot().jobs.oldJob!;
    const originalRequirement = structuredClone(fx.store.snapshot().requirements[REQ_ID]);
    const originalIssue = structuredClone(fx.github.issue);
    const { deps } = baselineDeps(fx);
    const result = await retryWithBaseline(deps, 12);
    assert.equal(result, '#12 已在新 main 基线上重新进入 review（PR #43）');
    assert.deepEqual(fx.store.snapshot().jobs.oldJob, originalJob);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(fx.workerCalls[0]!.sourceMainSha, fx.newSha);
    assert.equal(fx.workerCalls[0]!.spec.hash, fx.spec.hash);
    assert.equal(fx.core!.retryBaselineDeps?.trustedE2eRoot, fx.trustedE2eRoot);
    assert.equal(fx.workerCalls[0]!.attempt, 2);
    assert.match(fx.workerCalls[0]!.jobId, /^retry-baseline-[0-9a-f]{24}-job$/);
    const state = fx.store.snapshot();
    const baseline = Object.values(state.retryBaselines ?? {})[0];
    assert.ok(baseline);
    assert.equal(baseline.stage, 'completed');
    assert.equal(state.requirements[REQ_ID]?.sourceMainSha, fx.newSha);
    assert.equal(state.jobs[baseline.newJobId]?.sourceMainSha, fx.newSha);
    assert.equal(state.jobs[baseline.newJobId]?.status, 'in-review');
    assert.equal(state.jobs[baseline.newJobId]?.prNumber, 43);
    assert.equal(state.deploy.activeSha, null);
    assert.notDeepEqual(state.requirements[REQ_ID], originalRequirement);
    assert.notEqual(fx.github.issue.body, originalIssue.body);
    const operation = baselineOperationId(originalJob, fx.newSha);
    assert.equal(baseline.operationId, operation);
    const reloaded = new StateStore(fx.stateFile).load();
    assert.deepEqual(reloaded.jobs.oldJob, originalJob);
    assert.equal(reloaded.retryBaselines![operation]?.stage, 'completed');
    await runOnce(fx.core!);
    assert.equal(fx.workerCalls.length, 1, '普通 runOnce 不自动重跑新基线，noop 不覆盖新绑定');
    assert.equal(fx.store.snapshot().requirements[REQ_ID]?.sourceMainSha, fx.newSha);
    assert.deepEqual(fx.store.snapshot().jobs.oldJob, originalJob);
  } finally {
    fx.dispose();
  }
});

test('prepared 后中断：重启恢复只改外部准备、不调用 Worker；显式重试复用同一个新 Job', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, async () => ({ status: 'published', prNumber: 42 }));
    const originalJob = structuredClone(fx.store.snapshot().jobs.oldJob);
    const interrupted = baselineDeps(fx, {
      beforeIssueUpdate: () => {
        const error = new Error('模拟 prepared 后进程中断');
        error.name = 'InterruptedAfterPrepared';
        throw error;
      },
    });
    const interruptedResult = await retryWithBaseline(interrupted.deps, 12);
    assert.match(interruptedResult, /模拟 prepared 后进程中断/);
    assert.deepEqual(fx.store.snapshot().jobs.oldJob, originalJob);
    assert.equal(fx.github.issueUpdateAttempts, 0);
    assert.equal(fx.workerCalls.length, 0);
    const first = Object.values(fx.store.snapshot().retryBaselines ?? {})[0];
    assert.ok(first);
    assert.equal(first.stage, 'prepared');
    const oldBeforeReload = structuredClone(fx.store.snapshot().jobs.oldJob);
    // 模拟控制器重启：新 createCore 从磁盘加载同一 prepared 记录。
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 43 }]));
    const restoredCore = fx.core!;
    const restoredStore = restoredCore.state;
    assert.equal(restoredStore.snapshot().retryBaselines![first.operationId]?.stage, 'prepared');
    await runOnce(restoredCore);
    assert.equal(restoredStore.snapshot().retryBaselines![first.operationId]?.stage, 'ready');
    assert.equal(fx.workerCalls.length, 0);
    assert.equal(restoredStore.snapshot().jobs.oldJob?.status, 'failed');
    assert.equal(restoredStore.snapshot().requirements[REQ_ID]?.sourceMainSha, fx.newSha);
    assert.equal(fx.github.issueUpdateAttempts, 1);
    const explicit = await restoredCore.commands.retry(12);
    assert.match(explicit, /已在新 main/);
    assert.equal(restoredStore.snapshot().retryBaselines![first.operationId]?.stage, 'completed');
    assert.equal(restoredStore.snapshot().requirements[REQ_ID]?.sourceMainSha, fx.newSha);
    assert.equal(fx.workerCalls.length, 1);
    assert.deepEqual(fx.workerOutcomes, [{ status: 'published', prNumber: 43 }]);
    assert.equal(fx.workerCalls[0]!.jobId, first.newJobId);
    assert.equal(Object.keys(restoredStore.snapshot().retryBaselines ?? {}).length, 1);
    assert.equal(fx.github.issueUpdateAttempts, 1);
    assert.deepEqual(restoredStore.snapshot().jobs.oldJob, originalJob);
    assert.deepEqual(restoredStore.snapshot().jobs.oldJob, oldBeforeReload);
    const finalReload = new StateStore(fx.stateFile).load();
    const finalBaseline = finalReload.retryBaselines![first.operationId]!;
    assert.equal(finalBaseline.newJobId, first.newJobId);
    assert.equal(finalReload.jobs[first.newJobId]?.status, 'in-review');
    assert.equal(finalReload.jobs[first.newJobId]?.prNumber, 43);
  } finally {
    fx.dispose();
  }
});

test('prepared 且 Issue 已 target 后重启恢复：explicit=false 完成本地 ready，仍不调用 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, []));
    const { deps } = baselineDeps(fx, {
      beforeCommitReady: () => {
        throw new Error('模拟 ready 本地提交前退出');
      },
    });
    const interrupted = await retryWithBaseline(deps, 12);
    assert.match(interrupted, /本地 ready 提交失败|ready 提交前|显式重试准备失败.*ready 本地提交前退出/);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    assert.equal(fx.workerCalls.length, 0);
    const restored = useRealCore(fx, coreOutcomeQueue(fx, []));
    await runOnce(restored);
    const state = restored.state.snapshot();
    const baseline = state.retryBaselines![prepared.operationId]!;
    assert.equal(baseline.stage, 'ready');
    assert.equal(state.requirements[REQ_ID]?.sourceMainSha, fx.newSha);
    assert.equal(state.jobs[baseline.newJobId]?.sourceMainSha, fx.newSha);
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('ready 已进入 processing 后重启恢复：只收尾 operation，不改 Job、不调 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, []));
    const { deps } = baselineDeps(fx, {
      beforeCommitReady: () => {
        throw new Error('模拟 ready 本地提交前退出');
      },
    });
    await retryWithBaseline(deps, 12);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    const restored = useRealCore(fx, coreOutcomeQueue(fx, []));
    await runOnce(restored);
    const before = restored.state.snapshot();
    const baseline = before.retryBaselines![prepared.operationId]!;
    assert.equal(baseline.stage, 'ready');
    await restored.state.update((s) => {
      const job = s.jobs[baseline.newJobId];
      if (!job) throw new Error('缺少 ready 新 Job');
      job.status = 'processing';
      job.failureStage = undefined;
      job.resumeAction = undefined;
      job.updatedAt = new Date().toISOString();
      return undefined;
    });
    await resumeRetryBaselines(restored.retryBaselineDeps!);
    const after = restored.state.snapshot();
    assert.equal(after.retryBaselines![baseline.operationId]?.stage, 'completed');
    assert.equal(after.jobs[baseline.newJobId]?.status, 'processing');
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('ready 未运行且 main 已漂移后重启恢复：只 markStale，让权威对账重放', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, []));
    const { deps } = baselineDeps(fx, {
      beforeCommitReady: () => {
        throw new Error('模拟 ready 本地提交前退出');
      },
    });
    await retryWithBaseline(deps, 12);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    const restored = useRealCore(fx, coreOutcomeQueue(fx, []));
    await runOnce(restored);
    const before = restored.state.snapshot();
    const baseline = before.retryBaselines![prepared.operationId]!;
    assert.equal(baseline.stage, 'ready');
    await gitWithTestTransport(fx.repo, ['push', '-q', 'origin', `${fx.futureSha}:refs/heads/main`]);
    await resumeRetryBaselines(restored.retryBaselineDeps!);
    const after = restored.state.snapshot();
    assert.equal(after.retryBaselines![baseline.operationId]?.stage, 'stale');
    assert.equal(after.jobs[baseline.newJobId]?.failureStage, 'retry-baseline-stale');
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('历史其他 revision 已合并 code/spec PR 不再占用活动槽，显式重试仍走新基线', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    const otherSha = '1'.repeat(40);
    fx.github.prs = [
      {
        number: 8,
        title: 'merged other code',
        body: '',
        state: 'closed',
        merged: true,
        headRefName: 'pi/merged-other-code',
        baseRefName: 'main',
        meta: { kind: 'code-pr', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: otherSha },
        url: '',
      },
      {
        number: 9,
        title: 'merged other spec request',
        body: '',
        state: 'closed',
        merged: true,
        headRefName: 'pi/merged-other-spec',
        baseRefName: 'main',
        meta: { kind: 'spec-request', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: otherSha },
        url: '',
      },
    ];
    const { deps } = baselineDeps(fx);
    const message = await retryWithBaseline(deps, 12);
    assert.match(message, /已在新 main 基线上重新进入 review/);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(fx.workerCalls[0]?.sourceMainSha, fx.newSha);
  } finally {
    fx.dispose();
  }
});

test('prepared 恢复时历史其他 revision 已合并 code/spec PR 不阻断，只完成 ready 不调 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, []));
    const { deps } = baselineDeps(fx, {
      beforeIssueUpdate: () => {
        throw new Error('模拟 prepared 后退出');
      },
    });
    await retryWithBaseline(deps, 12);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    const otherSha = '2'.repeat(40);
    fx.github.prs = [
      {
        number: 8,
        title: 'merged other code',
        body: '',
        state: 'closed',
        merged: true,
        headRefName: 'pi/merged-other-code',
        baseRefName: 'main',
        meta: { kind: 'code-pr', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: otherSha },
        url: '',
      },
      {
        number: 9,
        title: 'merged other spec request',
        body: '',
        state: 'closed',
        merged: true,
        headRefName: 'pi/merged-other-spec',
        baseRefName: 'main',
        meta: { kind: 'spec-request', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: otherSha },
        url: '',
      },
    ];
    const restored = useRealCore(fx, coreOutcomeQueue(fx, []));
    await runOnce(restored);
    const state = restored.state.snapshot();
    assert.equal(state.retryBaselines![prepared.operationId]?.stage, 'ready');
    assert.equal(state.requirements[REQ_ID]?.sourceMainSha, fx.newSha);
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('prepared 恢复时远端 PR 状态未知：拒绝写 Issue/建 Job，保留 prepared', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, []));
    const { deps } = baselineDeps(fx, {
      beforeIssueUpdate: () => {
        throw new Error('模拟 prepared 后退出');
      },
    });
    await retryWithBaseline(deps, 12);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    fx.github.prs = [{
      number: 9,
      title: 'unknown',
      body: '',
      state: 'unknown',
      merged: false,
      headRefName: 'pi/unknown',
      baseRefName: 'main',
      meta: { kind: 'code-pr', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: fx.newSha },
      url: '',
    } as unknown as ManagedPR];
    const restored = useRealCore(fx, coreOutcomeQueue(fx, []));
    await runOnce(restored);
    const state = restored.state.snapshot();
    assert.equal(state.retryBaselines![prepared.operationId]?.stage, 'prepared');
    assert.equal(state.jobs[prepared.newJobId], undefined);
    assert.equal(state.requirements[REQ_ID]?.sourceMainSha, fx.oldSha);
    assert.equal(fx.github.issueUpdateAttempts, 0);
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('ready 执行前远端 PR 状态未知或其他活动交付：不调用 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    let throwReadyCommit = true;
    const { deps } = baselineDeps(fx, {
      beforeCommitReady: () => {
        if (throwReadyCommit) {
          throwReadyCommit = false;
          throw new Error('模拟 ready 本地提交前退出');
        }
      },
    });
    await retryWithBaseline(deps, 12);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    fx.github.prs = [{
      number: 8,
      title: 'other code',
      body: '',
      state: 'open',
      merged: false,
      headRefName: 'pi/other',
      baseRefName: 'main',
      meta: { kind: 'code-pr', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: fx.oldSha },
      url: '',
    }];
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /活动交付|已有 target|状态未知/);
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('prepared 前失败：没有 Job/Issue/Worker 副作用', async () => {
  const fx = await createFixture();
  try {
    const before = fx.store.snapshot();
    fx.github.failPRRead = true;
    const { deps } = baselineDeps(fx);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /PR 状态读取失败/);
    const after = fx.store.snapshot();
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.requirements, before.requirements);
    assert.deepEqual(after.retryBaselines ?? {}, {});
    assert.equal(fx.github.issueUpdateAttempts, 0);
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
});

test('新基线真实执行失败后才建立下一 attempt，旧 Job 不改', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [
      { status: 'failed', error: '模拟候选验证失败', failureStage: 'verify', resumeAction: 'worker' },
      { status: 'published', prNumber: 43 },
    ]));
    const originalJob = structuredClone(fx.store.snapshot().jobs.oldJob);
    const { deps } = baselineDeps(fx);
    const first = await retryWithBaseline(deps, 12);
    assert.match(first, /实际执行并失败（verify）/);
    const firstBaseline = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(firstBaseline.stage, 'completed');
    assert.equal(fx.store.snapshot().jobs[firstBaseline.newJobId]?.status, 'failed');
    assert.equal(fx.workerCalls.length, 1);
    const second = await retryWithBaseline(deps, 12);
    assert.match(second, /已在新 main 基线上重新进入 review/);
    assert.equal(fx.workerCalls.length, 2);
    assert.equal(fx.workerCalls[1]!.attempt, 3);
    assert.deepEqual(fx.store.snapshot().jobs.oldJob, originalJob);
    const baselines = Object.values(fx.store.snapshot().retryBaselines ?? {});
    assert.equal(baselines.length, 2);
    assert.notEqual(baselines[0]!.operationId, baselines[1]!.operationId);
  } finally {
    fx.dispose();
  }
});

test('远端 Issue 写入响应丢失：读回 target 后完成同一发布，不重复写正文或模型调用', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    fx.github.prs = [{
      number: 42,
      title: '[REQ-CNT-01] 计数器',
      body: '',
      state: 'open',
      merged: false,
      headRefName: 'pi/counter-new',
      baseRefName: 'main',
      meta: { kind: 'code-pr', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: fx.newSha },
      url: 'https://example.invalid/pull/42',
    }];
    const { deps } = baselineDeps(fx);
    const first = await retryWithBaseline(deps, 12);
    assert.match(first, /已有 target 代码交付 PR #42/);
    assert.equal(fx.github.issueUpdateAttempts, 0);
    assert.equal(fx.workerCalls.length, 0);
    assert.deepEqual(fx.store.snapshot().retryBaselines ?? {}, {});
    fx.github.prs = [];
    fx.github.resetCalls();
    const second = await retryWithBaseline(deps, 12);
    assert.match(second, /已在新 main 基线上重新进入 review（PR #42）/);
    assert.equal(fx.github.issueUpdateAttempts, 1);
    assert.equal(fx.workerCalls.length, 1);
    const ready = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(ready.stage, 'completed');
    const retried = await retryWithBaseline(deps, 12);
    assert.match(retried, /当前状态 in-review|仅最新失败任务|复用已有生命周期|不重复派发/);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(fx.github.issueUpdateAttempts, 1);
    const jobs = fx.store.snapshot().jobs;
    assert.equal(Object.keys(jobs).filter((jobId) => jobId.startsWith('retry-baseline-')).length, 1);
    assert.equal(jobs[ready.newJobId]?.status, 'in-review');
    assert.equal(jobs[ready.newJobId]?.prNumber, 42);
  } finally {
    fx.dispose();
  }
});

test('same-sha 重试也先持久 prepared，并保留原 Issue 活动元数据', async () => {
  const fx = await createFixture({ sameSha: true });
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    const originalJob = structuredClone(fx.store.snapshot().jobs.oldJob);
    const originalBody = fx.github.issue.body;
    const { deps } = baselineDeps(fx);
    const result = await retryWithBaseline(deps, 12);
    assert.equal(result, '#12 已在新 main 基线上重新进入 review（PR #42）');
    assert.match(result, /已在新 main/);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(fx.workerCalls[0]!.sourceMainSha, fx.oldSha);
    assert.equal(fx.workerCalls[0]!.attempt, 2);
    assert.deepEqual(fx.store.snapshot().jobs.oldJob, originalJob);
    const baseline = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(baseline.fromSourceMainSha, baseline.targetSourceMainSha);
    assert.equal(baseline.stage, 'completed');
    assert.equal(fx.github.issue.body, originalBody);
    assert.equal(fx.store.snapshot().requirements[REQ_ID]?.sourceMainSha, fx.oldSha);
  } finally {
    fx.dispose();
  }
});

test('远端已发布 PR 在本地 ready 提交后恢复，拒绝按未知远端状态再次派发', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [
      { status: 'failed', error: '模拟本地落盘失败', failureStage: 'verify', resumeAction: 'worker' },
      { status: 'published', prNumber: 43 },
    ]));
    const { deps } = baselineDeps(fx, {
      beforeCommitReady: () => {
        throw new Error('模拟 ready 提交前中断');
      },
    });
    const interrupted = await retryWithBaseline(deps, 12);
    assert.match(interrupted, /ready 提交前中断/);
    const prepared = Object.values(fx.store.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(prepared.stage, 'prepared');
    assert.ok(fx.store.snapshot().jobs[prepared.newJobId] === undefined);
    assert.equal(fx.workerCalls.length, 0);
    const { deps: normal } = baselineDeps(fx);
    normal.findExistingDelivery = async () => {
      throw new Error('模拟 PR 列表响应丢失');
    };
    const uncertain = await retryWithBaseline(normal, 12);
    assert.match(uncertain, /既有代码 PR.*状态读取失败|PR 状态读取失败|执行前远端交付预检失败/);
    assert.equal(fx.workerCalls.length, 0);
    assert.equal(fx.store.snapshot().retryBaselines![prepared.operationId]?.stage, 'ready');
  } finally {
    fx.dispose();
  }
});

test('生产 commands.retry 共享 createCore 的可信资产依赖，旧高 attempt 不遮蔽当前 revision', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    await fx.store.update((s) => {
      s.jobs.historical = {
        ...s.jobs.oldJob!,
        jobId: 'historical',
        attempt: 99,
        specHash: '0'.repeat(64),
        sourceMainSha: '0'.repeat(40),
      };
      return undefined;
    });
    const message = await fx.core!.commands.retry(12);
    assert.match(message, /已在新 main 基线上重新进入 review/);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(fx.workerCalls[0]!.sourceMainSha, fx.newSha);
    assert.equal(fx.workerCalls[0]!.spec.hash, fx.spec.hash);
  } finally {
    fx.dispose();
  }
});

test('生产命令入口共享可信根；恢复窗口可重载且不自动派发', async () => {
  const fx = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published-granted',
  });
  try {
    useProductionCommands(fx);
    const core = fx.core!;
    const sharedDeps = core.retryBaselineDeps!;
    sharedDeps.trustedE2eRoot = undefined;
    core.workerDeps.browserE2eRoot = undefined;
    const unavailable = await core.commands.retry(12);
    assert.match(unavailable, /可信验收资产/);
    assert.equal(fx.workerCalls.length, 0);
    assert.equal(fx.github.issueUpdateAttempts, 0);
    assert.deepEqual(fx.store.snapshot().retryBaselines ?? {}, {});
    core.workerDeps.browserE2eRoot = fx.trustedE2eRoot;
    sharedDeps.trustedE2eRoot = fx.trustedE2eRoot;
    const message = await core.commands.retry(12);
    assert.match(message, /已在新 main 基线上重新进入 review/);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(sharedDeps.repoDir, fx.repo);
    assert.equal(sharedDeps.trustedE2eRoot, fx.trustedE2eRoot);
  } finally {
    fx.dispose();
  }
});

test('main 在 Issue 准备前漂移：标记 stale、保留旧绑定且不调用 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, async () => ({ status: 'published', prNumber: 42 }));
    const originalIssue = structuredClone(fx.github.issue);
    const normal = baselineDeps(fx);
    const originalJob = structuredClone(fx.store.snapshot().jobs.oldJob);
    const planned = await prepareRetryBaseline(normal.deps, 12);
    assert.ok('oldJob' in planned);
    await persistRetryBaselinePrepared(normal.deps, planned);
    // 在临时工作库的 controller/main 继续提交，按 fast-forward 推送。
    writeFileSync(join(fx.repo, 'later.txt'), 'later main\n');
    await git(fx.repo, ['add', 'later.txt']);
    await git(fx.repo, ['commit', '-qm', 'main moves before issue']);
    await git(fx.repo, ['branch', '-f', 'main', 'HEAD']);
    await pushMain(fx.repo);
    const resumed = baselineDeps(fx);
    resumed.deps.state = new StateStore(fx.stateFile);
    resumed.deps.state.load();
    fx.core!.state = resumed.deps.state;
    Object.assign(fx.core!.retryBaselineDeps!, { state: resumed.deps.state });
    await runOnce(fx.core!);
    assert.deepEqual(resumed.deps.state.snapshot().jobs.oldJob, originalJob);
    assert.equal(resumed.deps.state.snapshot().requirements[REQ_ID]?.sourceMainSha, fx.oldSha);
    assert.equal(fx.github.issue.body, originalIssue.body);
    assert.equal(fx.workerCalls.length, 0);
    const baseline = Object.values(resumed.deps.state.snapshot().retryBaselines ?? {})[0]!;
    assert.equal(baseline.stage, 'stale');
    assert.equal(baseline.targetSourceMainSha, fx.newSha);
  } finally {
    fx.dispose();
  }
});

test('ready 后执行前 main 前进：不调用 Worker、不改部署', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, async () => ({ status: 'published', prNumber: 42 }));
    const { deps } = baselineDeps(fx);
    const planned = await prepareRetryBaseline(deps, 12);
    assert.ok('oldJob' in planned);
    await persistRetryBaselinePrepared(deps, planned);
    fx.github.prs = [];
    await syncRetryBaselinePrepared(deps, 12);
    writeFileSync(join(fx.repo, 'next.txt'), 'next\n');
    await git(fx.repo, ['add', 'next.txt']);
    await git(fx.repo, ['commit', '-qm', 'main advances']);
    // 从已固定的 target 正常前进；不能用 force-update 模拟普通主线提交。
    await git(fx.repo, ['checkout', '-q', '-B', 'controller', fx.newSha]);
    writeFileSync(join(fx.repo, 'next.txt'), 'next\n');
    await git(fx.repo, ['add', 'next.txt']);
    await git(fx.repo, ['commit', '-qm', 'main advances']);
    await pushMain(fx.repo);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /main 已前进.*旧绑定|执行前 main 已前进/);
    assert.equal(fx.workerCalls.length, 0);
    assert.equal(fx.store.snapshot().deploy.activeSha, null);
    const baseline = Object.values(fx.store.snapshot().retryBaselines ?? {})[0];
    assert.equal(baseline?.stage, 'stale');
  } finally {
    fx.dispose();
  }
});

test('可信契约来自控制器资产而非候选规格；缺失/不匹配 fail closed', async () => {
  const fx = await createFixture({
    noContract: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published',
  });
  try {
    const { deps } = baselineDeps(fx);
    const noContract = await retryWithBaseline(deps, 12);
    assert.match(noContract, /可信验收资产/);
    assert.equal(fx.workerCalls.length, 0);
    mkdirSync(join(fx.trustedE2eRoot, 'tests', 'e2e', 'contracts'), { recursive: true });
    writeFileSync(join(fx.trustedE2eRoot, 'tests', 'e2e', 'contracts', 'counter.json'), JSON.stringify({
      reqId: COUNTER_REQ_ID,
      specPath: SPEC_PATH,
      specHash: specOf(doc('不属于该候选'))!.hash,
      caseIds: ['E2E-CNT-001'],
    }));
    const mismatch = await retryWithBaseline(deps, 12);
    assert.match(mismatch, /可信验收契约不匹配/);
    assert.deepEqual(fx.store.snapshot().retryBaselines ?? {}, {});
  } finally {
    fx.dispose();
  }
});

test('旧 revision 已有代码交付：不创建新准备、不派发 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    const { deps } = baselineDeps(fx);
    fx.github.prs = [{
      number: 7,
      title: '旧交付',
      body: '',
      state: 'open',
      merged: false,
      headRefName: 'pi/old',
      baseRefName: 'main',
      meta: { kind: 'code-pr', reqId: REQ_ID, specHash: fx.spec.hash, sourceMainSha: fx.oldSha },
      url: '',
    }];
    const delivery = await retryWithBaseline(deps, 12);
    assert.match(delivery, /旧 revision 已有代码交付/);
    assert.equal(deps.state.snapshot().requirements[REQ_ID]?.sourceMainSha, fx.oldSha);
    assert.equal(fx.workerCalls.length, 0);
    assert.deepEqual(fx.store.snapshot().retryBaselines ?? {}, {});
  } finally {
    fx.dispose();
  }
});

test('活动 Worker 冲突：不新建准备、不派发 Worker', async () => {
  const fx = await createFixture();
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    await fx.store.update((s) => {
      s.jobs.processing = { ...s.jobs.oldJob!, jobId: 'processing', status: 'processing', attempt: 0 };
      return undefined;
    });
    const { deps } = baselineDeps(fx);
    const active = await retryWithBaseline(deps, 12);
    assert.match(active, /活动 Worker/);
    assert.equal(fx.workerCalls.length, 0);
    assert.deepEqual(fx.store.snapshot().retryBaselines ?? {}, {});
  } finally {
    fx.dispose();
  }
});

test('非祖先、规格改动、satisfied 与部署恢复不建立代码重试', async () => {
  const fx = await createFixture({ changedSpec: true });
  try {
    const { deps } = baselineDeps(fx);
    const changed = await retryWithBaseline(deps, 12);
    assert.match(changed, /路径或内容已变化/);
    assert.equal(fx.workerCalls.length, 0);
    await fx.store.update((s) => {
      s.jobs.oldJob!.status = 'satisfied';
      return undefined;
    });
    const satisfied = await retryWithBaseline(deps, 12);
    assert.match(satisfied, /已验收无需代码变更/);
    assert.equal(fx.workerCalls.length, 0);
  } finally {
    fx.dispose();
  }
  const deployFx = await createFixture();
  try {
    useRealCore(deployFx, async () => ({ status: 'published', prNumber: 42 }));
    await deployFx.store.update((s) => {
      s.jobs.oldJob!.failureStage = 'deploy';
      s.jobs.oldJob!.resumeAction = 'deploy-only';
      return undefined;
    });
    const deployDeps = baselineDeps(deployFx);
    const result = await retryWithBaseline(deployDeps.deps, 12);
    assert.match(result, /重试部署/);
    assert.equal(deployDeps.deployCalls(), 1);
    assert.deepEqual(deployFx.workerCalls, []);
  } finally {
    deployFx.dispose();
  }
});

test('counter 已发布版本在 main 前进后只发布新 rN 待排期，不创建基线或调用 Worker', async () => {
  const fx = await createFixture({
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published',
  });
  try {
    const publisher = counterPublisher(fx);
    const { deps } = baselineDeps(fx, undefined, publisher);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /已按当前 main 发布 r2 待排期/);
    assert.match(result, /可开工\/r2/);
    assert.equal(publisher.calls.length, 1);
    assert.equal(publisher.calls[0]!.reqId, COUNTER_REQ_ID);
    assert.equal(publisher.calls[0]!.targetMainSha, fx.newSha);
    assert.equal(publisher.calls[0]!.repoId, '9001');
    assert.equal(fx.workerCalls.length, 0);
    const state = fx.store.snapshot();
    const revisions = state.dispatchRevisions?.[COUNTER_REQ_ID] ?? [];
    assert.equal(revisions.length, 2);
    assert.equal(revisions[1]!.revision, 2);
    assert.equal(revisions[1]!.sourceMainSha, fx.newSha);
    assert.equal(revisions[1]!.grant, undefined);
    assert.equal(state.requirements[COUNTER_REQ_ID]?.sourceMainSha, fx.newSha);
    assert.deepEqual(state.retryBaselines ?? {}, {});
    assert.deepEqual(Object.keys(state.jobs), ['oldJob']);
  } finally {
    fx.dispose();
  }
});

test('counter 同 SHA 带当前授权可经正常命令入口重试，并携带完整冻结版本', async () => {
  const fx = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published-granted',
  });
  try {
    useRealCore(fx, coreOutcomeQueue(fx, [{ status: 'published', prNumber: 42 }]));
    const originalJob = structuredClone(fx.store.snapshot().jobs.oldJob);
    const result = await fx.core!.commands.retry(12);
    assert.match(result, /已在新 main 基线上重新进入 review/);
    assert.equal(fx.workerCalls.length, 1);
    assert.equal(fx.workerCalls[0]!.dispatchRevision?.revision, 1);
    assert.equal(fx.workerCalls[0]!.dispatchRevision?.grant?.eventId, 8101);
    assert.equal(fx.workerCalls[0]!.dispatchRevision?.task.allowedPaths[0], 'src/**');
    const state = fx.store.snapshot();
    const baseline = Object.values(state.retryBaselines ?? {})[0]!;
    assert.equal(state.jobs[baseline.newJobId]?.dispatchRevision, 1);
    assert.equal(state.jobs[baseline.newJobId]?.grantEventId, 8101);
    assert.deepEqual(state.jobs.oldJob, originalJob);
  } finally {
    fx.dispose();
  }
});

test('counter 显式重试时当前开工标签已撤下，不调用 Worker 或创建代码 PR', async () => {
  const fx = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published-granted',
  });
  try {
    useRealCore(fx, async () => {
      throw new Error('撤标后不应调用 Worker');
    });
    const originalJob = structuredClone(fx.store.snapshot().jobs.oldJob);
    fx.github.issue.labels = [];
    fx.github.dispatchLabelEvents.push({
      id: 8102,
      actorId: 4242,
      name: '可开工/r1',
      event: 'unlabeled',
      createdAt: '2026-11-20T00:02:00.000Z',
    });

    const result = await fx.core!.commands.retry(12);

    assert.match(result, /主线漂移或过期|当前无有效开工许可/);
    assert.equal(fx.workerCalls.length, 0);
    assert.deepEqual(fx.github.prs, []);
    assert.deepEqual(fx.store.snapshot().jobs.oldJob, originalJob);
    assert.equal(
      fx.store.snapshot().dispatchRevisions?.[COUNTER_REQ_ID]?.[0]?.grant?.eventId,
      8101,
    );
  } finally {
    fx.dispose();
  }
});

test('counter 同 SHA 无已观察授权拒绝增加 attempt', async () => {
  const fx = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published',
  });
  try {
    const { deps } = baselineDeps(fx);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /尚无有效开工授权/);
    assert.equal(fx.workerCalls.length, 0);
    assert.deepEqual(fx.store.snapshot().retryBaselines ?? {}, {});
  } finally {
    fx.dispose();
  }
});

test('counter 显式重试按当前数字仓库 ID 核对冻结版本，读取失败或漂移均 fail closed', async () => {
  const drifted = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published-granted',
  });
  try {
    drifted.github.repoId = '9002';
    const { deps } = baselineDeps(drifted);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /当前仓库数字 ID 与冻结派工版本不一致/);
    assert.equal(drifted.workerCalls.length, 0);
    assert.deepEqual(drifted.store.snapshot().retryBaselines ?? {}, {});
  } finally {
    drifted.dispose();
  }

  const unknown = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published-granted',
  });
  try {
    unknown.github.failRepoIdRead = true;
    const { deps } = baselineDeps(unknown);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /当前仓库数字 ID 读取失败/);
    assert.equal(unknown.workerCalls.length, 0);
    assert.deepEqual(unknown.store.snapshot().retryBaselines ?? {}, {});
  } finally {
    unknown.dispose();
  }
});

test('counter 无冻结版本或发布回调缺失时 fail closed，不借命令启动 Worker', async () => {
  const unversioned = await createFixture({ reqId: COUNTER_REQ_ID });
  try {
    const { deps } = baselineDeps(unversioned);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /尚无已发布的冻结派工版本/);
    assert.equal(unversioned.workerCalls.length, 0);
  } finally {
    unversioned.dispose();
  }

  const changed = await createFixture({
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published',
  });
  try {
    const { deps } = baselineDeps(changed);
    const result = await retryWithBaseline(deps, 12);
    assert.match(result, /未接线 scheduler 派工发布入口/);
    assert.equal(changed.workerCalls.length, 0);
    const state = changed.store.snapshot();
    assert.equal(state.requirements[COUNTER_REQ_ID]?.sourceMainSha, changed.oldSha);
    assert.equal(state.dispatchRevisions?.[COUNTER_REQ_ID]?.length, 1);
    assert.deepEqual(state.retryBaselines ?? {}, {});
  } finally {
    changed.dispose();
  }
});

test('counter 重启恢复只完成 prepared→ready，不自动调用 Worker', async () => {
  const fx = await createFixture({
    sameSha: true,
    reqId: COUNTER_REQ_ID,
    counterRevision: 'published-granted',
  });
  try {
    const { deps } = baselineDeps(fx);
    const prepared = await prepareRetryBaseline(deps, 12);
    assert.ok('oldJob' in prepared);
    await persistRetryBaselinePrepared(deps, prepared);
    await resumeRetryBaselines(deps);
    assert.equal(fx.workerCalls.length, 0);
    const state = fx.store.snapshot();
    assert.equal(
      state.retryBaselines?.[prepared.baseline.operationId]?.stage,
      'ready',
    );
    assert.equal(
      state.jobs[prepared.baseline.newJobId]?.dispatchRevision,
      1,
    );
  } finally {
    fx.dispose();
  }
});
