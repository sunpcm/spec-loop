import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Config } from '../orchestrator/config.ts';
import { createCommands } from '../orchestrator/commands.ts';
import { GitClient } from '../orchestrator/git.ts';
import {
  encodeMetaBlock,
  extractMeta,
  GithubClient,
  type GhRunner,
} from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import type { PiInvocation, PiResult } from '../orchestrator/pi-runner.ts';
import { createCore } from '../orchestrator/runtime.ts';
import type { SpecIntakeDeps } from '../orchestrator/spec-intake.ts';
import {
  reconcileSpecRequests,
  retrySpecRequirement,
  specRequestState,
  submitSpecRequirement,
} from '../orchestrator/spec-intake.ts';
import {
  computeSpecRequestId,
  normalizeSpecDescription,
} from '../orchestrator/spec-identity.ts';
import { StateStore } from '../orchestrator/state.ts';
import type {
  JobState,
  ManagedPR,
  OrchestratorState,
  SpecRequest,
} from '../orchestrator/types.ts';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const BASE_DOC = `# 计数器演示

### [REQ-CNT-01] 计数器与自定义步长

#### 功能
- 页面展示计数值，初始值为 0。
- 输入合法整数步长后，点击“增加”按该步长累计。
- 提供“减少”按钮，与“增加”共用同一个步长输入，点击后按该整数步长减去计数。
- 点击“重置”将计数值恢复为 0。

#### 验收
- 初始显示 0；步长 2 时点击一次显示 2。
- 步长 2 时，先点击“增加”得到 2，再点击“减少”回到 0。
- 增加、减少共用步长；重置、需求 ID 和页面版本展示保持可用。
- 重置后显示 0，原步长保留。
`;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface RepoFixture {
  root: string;
  remoteDir: string;
  seedDir: string;
  repoDir: string;
  baseSHA: string;
}

function createRepoFixture(baseDoc = BASE_DOC): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-intake-'));
  const remoteDir = join(root, 'remote.git');
  const seedDir = join(root, 'seed');
  const repoDir = join(root, 'repo');

  execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
  mkdirSync(seedDir, { recursive: true });
  git(['init', '-b', 'main'], seedDir);
  git(['config', 'user.email', 'spec-loop@example.test'], seedDir);
  git(['config', 'user.name', 'Spec Loop Test'], seedDir);
  mkdirSync(join(seedDir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(seedDir, 'docs', 'specs', 'counter.md'), baseDoc, 'utf8');
  writeFileSync(join(seedDir, 'README.md'), '# fixture\n', 'utf8');
  git(['add', '-A'], seedDir);
  git(['commit', '-m', 'initial'], seedDir);
  git(['remote', 'add', 'origin', remoteDir], seedDir);
  git(['push', '-u', 'origin', 'main'], seedDir);

  git(['clone', remoteDir, repoDir], root);
  git(['config', 'user.email', 'spec-loop@example.test'], repoDir);
  git(['config', 'user.name', 'Spec Loop Test'], repoDir);
  return {
    root,
    remoteDir,
    seedDir,
    repoDir,
    baseSHA: git(['rev-parse', 'origin/main'], repoDir),
  };
}

function advanceRemote(fixture: RepoFixture, marker: string): string {
  writeFileSync(join(fixture.seedDir, 'README.md'), `# fixture\n${marker}\n`, 'utf8');
  git(['add', 'README.md'], fixture.seedDir);
  git(['commit', '-m', marker], fixture.seedDir);
  git(['push', 'origin', 'main'], fixture.seedDir);
  return git(['rev-parse', 'HEAD'], fixture.seedDir);
}

function updatedDoc(marker: string, document = BASE_DOC): string {
  return document.replace(
    '- 重置后显示 0，原步长保留。',
    `- 重置后显示 0，原步长保留。\n- 自动化覆盖：${marker}`,
  );
}

function createSpecCommit(
  harness: Harness,
  marker: string,
  options: { content?: string; executable?: boolean } = {},
): string {
  const worktree = join(harness.fixture.root, `spec-commit-${marker.replace(/[^a-z0-9-]/gi, '-')}`);
  git(['worktree', 'add', '--detach', worktree, harness.fixture.baseSHA], harness.fixture.repoDir);
  try {
    writeFileSync(join(worktree, 'docs', 'specs', 'counter.md'), options.content ?? updatedDoc(marker), 'utf8');
    git(['add', '--', 'docs/specs/counter.md'], worktree);
    if (options.executable) git(['update-index', '--chmod=+x', 'docs/specs/counter.md'], worktree);
    git(['commit', '-m', `spec fixture ${marker}`], worktree);
    return git(['rev-parse', 'HEAD'], worktree);
  } finally {
    git(['worktree', 'remove', '--force', worktree], harness.fixture.repoDir);
  }
}

function makeJob(
  jobId: string,
  attempt: number,
  status: JobState['status'],
  baseSHA: string,
): JobState {
  return {
    jobId,
    reqId: 'REQ-CNT-01',
    issueNumber: 3,
    specHash: `hash-${attempt}`,
    sourceMainSha: baseSHA,
    attempt,
    status,
    startedAt: `2026-11-14T00:0${attempt}:00.000Z`,
    updatedAt: `2026-11-14T00:0${attempt}:30.000Z`,
  };
}

function baseState(baseSHA: string, overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    schemaVersion: 1,
    repo: 'owner/repo',
    cursorMainSha: baseSHA,
    requirements: {},
    jobs: {},
    deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
    specRequests: {},
    opLog: [],
    ...overrides,
  };
}

interface FakePR extends ManagedPR {
  labels: string[];
}

class FakeGithub {
  readonly prs: FakePR[] = [];
  readonly branchSHAs = new Map<string, string>();
  readonly omitHeadSHA = new Set<number>();
  readonly runner: GhRunner;
  failList = false;
  failBranchRead = false;
  failLabelOnce = false;
  loseCreateResponse = false;
  prCreateCalls = 0;
  listCalls = 0;
  labelCalls: Array<{ number: number; labels: string[] }> = [];
  private nextNumber = 10;

  constructor() {
    this.runner = async (args) => {
      if (args[0] === 'api' && args[1] === '--paginate') {
        this.listCalls += 1;
        if (this.failList) return { stdout: '', stderr: 'fake network failure', code: 1 };
        return {
          stdout: JSON.stringify([this.prs.map((pr) => this.toRest(pr))]),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/git/ref/heads/')) {
        if (this.failBranchRead) {
          return { stdout: '', stderr: 'fake branch network failure', code: 1 };
        }
        const prefix = '/git/ref/heads/';
        const branch = args[1].slice(args[1].indexOf(prefix) + prefix.length);
        const sha = this.branchSHAs.get(branch);
        if (!sha) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
        return { stdout: JSON.stringify({ object: { sha } }), stderr: '', code: 0 };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        this.prCreateCalls += 1;
        const title = args[args.indexOf('--title') + 1] ?? '';
        const bodyFile = args[args.indexOf('--body-file') + 1] ?? '';
        const head = args[args.indexOf('--head') + 1] ?? '';
        const base = args[args.indexOf('--base') + 1] ?? '';
        const body = readFileSync(bodyFile, 'utf8');
        const number = this.nextNumber++;
        this.prs.push({
          number,
          title,
          body,
          state: 'open',
          merged: false,
          headRefName: head,
          baseRefName: base,
          meta: extractMeta(body),
          labels: [],
          url: `https://github.com/owner/repo/pull/${number}`,
        });
        if (this.loseCreateResponse) {
          return { stdout: '', stderr: 'fake response lost after create', code: 1 };
        }
        return { stdout: `https://github.com/owner/repo/pull/${number}\n`, stderr: '', code: 0 };
      }
      if (args[0] === 'pr' && args[1] === 'edit') {
        const number = Number(args[2]);
        const labels = (args[args.indexOf('--add-label') + 1] ?? '').split(',').filter(Boolean);
        this.labelCalls.push({ number, labels });
        if (this.failLabelOnce) {
          this.failLabelOnce = false;
          return { stdout: '', stderr: 'fake label failure', code: 1 };
        }
        const pr = this.prs.find((candidate) => candidate.number === number);
        if (pr) {
          for (const label of labels) {
            if (!pr.labels.includes(label)) pr.labels.push(label);
          }
        }
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: `unexpected gh args: ${args.join(' ')}`, code: 1 };
    };
  }

  addPR(pr: Omit<FakePR, 'labels'> & { labels?: string[] }): FakePR {
    const body =
      pr.meta && !pr.body.includes('<!-- spec-loop:meta')
        ? `${pr.body}${pr.body ? '\n' : ''}${encodeMetaBlock(pr.meta)}`
        : pr.body;
    const added: FakePR = { ...pr, body, labels: pr.labels ?? [] };
    this.prs.push(added);
    return added;
  }

  private toRest(pr: FakePR): Record<string, unknown> {
    const headSHA = this.omitHeadSHA.has(pr.number)
      ? undefined
      : pr.headSHA ?? this.branchSHAs.get(pr.headRefName);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.mergedAt ?? null,
      head: headSHA ? { ref: pr.headRefName, sha: headSHA } : { ref: pr.headRefName },
      base: { ref: pr.baseRefName },
      html_url: pr.url,
      labels: pr.labels.map((name) => ({ name })),
    };
  }
}

class TrackingGitClient extends GitClient {
  failPush = false;
  private readonly branchSHAs: Map<string, string>;

  constructor(branchSHAs: Map<string, string>) {
    super();
    this.branchSHAs = branchSHAs;
  }

  override async push(cwd: string, branch: string, remote = 'origin'): Promise<void> {
    if (this.failPush) throw new Error('fake push failure');
    await super.push(cwd, branch, remote);
    this.branchSHAs.set(branch, await this.revParse(cwd, 'HEAD'));
  }
}

type PiResponder = (invocation: PiInvocation, index: number) => Promise<PiResult> | PiResult;

interface Harness {
  fixture: RepoFixture;
  runDir: string;
  stateFile: string;
  state: StateStore;
  fakeGithub: FakeGithub;
  github: GithubClient;
  trackingGit: TrackingGitClient;
  deps: SpecIntakeDeps;
  notifications: string[];
  piInvocations: PiInvocation[];
  setPiResponder: (responder: PiResponder) => void;
}

function successPi(output: unknown): PiResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    output,
    durationMs: 1,
    timedOut: false,
  };
}

function createHarness(
  options: {
    state?: OrchestratorState;
    baseDoc?: string;
    stateFactory?: (file: string, initialState: OrchestratorState) => StateStore;
  } = {},
): Harness {
  const fixture = createRepoFixture(options.baseDoc);
  const runDir = join(fixture.root, 'run');
  const stateFile = join(fixture.root, 'state.json');
  const initialState = options.state ?? baseState(fixture.baseSHA);
  const state = options.stateFactory?.(stateFile, initialState) ?? new StateStore(stateFile, initialState);
  const fakeGithub = new FakeGithub();
  const github = new GithubClient('owner/repo', fakeGithub.runner);
  const trackingGit = new TrackingGitClient(fakeGithub.branchSHAs);
  const notifications: string[] = [];
  const piInvocations: PiInvocation[] = [];
  let responder: PiResponder = () =>
    successPi({ summary: '增加验收覆盖', content: updatedDoc('isolated') });

  const deps: SpecIntakeDeps = {
    repoDir: fixture.repoDir,
    runDir,
    git: trackingGit,
    github,
    state,
    logger: silentLogger,
    notify: async (text) => {
      notifications.push(text);
    },
    piProvider: 'fake',
    piModel: 'fake/model',
    piAgentDir: join(fixture.root, 'global-agent'),
    piTimeoutMs: 100,
    piGraceMs: 10,
    runPi: async (invocation) => {
      piInvocations.push(invocation);
      return responder(invocation, piInvocations.length - 1);
    },
  };

  return {
    fixture,
    runDir,
    stateFile,
    state,
    fakeGithub,
    github,
    trackingGit,
    deps,
    notifications,
    piInvocations,
    setPiResponder: (next) => {
      responder = next;
    },
  };
}

class FailFirstDocPersistStateStore extends StateStore {
  private failNextDocPersist = true;

  protected override persist(state: OrchestratorState): void {
    const previous = this.snapshot();
    const persistsValidDoc = Object.values(state.specRequests ?? {}).some(
      (request) => request.hasValidDoc && !previous.specRequests?.[request.requestId]?.hasValidDoc,
    );
    if (persistsValidDoc && this.failNextDocPersist) {
      this.failNextDocPersist = false;
      throw new Error('fake state persist failure after artifact write');
    }
    super.persist(state);
  }
}

function historicalMergedCodePR(): ManagedPR {
  return {
    number: 3,
    title: '[REQ-CNT-01] 历史交付',
    body: '',
    state: 'closed',
    merged: true,
    headRefName: 'pi/req-old',
    baseRefName: 'main',
    meta: { kind: 'code-pr', reqId: 'REQ-CNT-01', specHash: 'old' },
    labels: ['pi-task'],
    url: 'https://github.com/owner/repo/pull/3',
  };
}

test('历史 merged 代码 PR #3 与 failed/done attempt 不阻挡新需求；messageId 去重且历史完成后可复用描述', async () => {
  const harness = createHarness();
  harness.fakeGithub.addPR(historicalMergedCodePR());
  await harness.state.update((state) => {
    state.jobs['attempt-1'] = makeJob('attempt-1', 1, 'failed', harness.fixture.baseSHA);
    state.jobs['attempt-2'] = makeJob('attempt-2', 2, 'done', harness.fixture.baseSHA);
  });

  const first = await submitSpecRequirement(harness.deps, '增加一个导出入口', 'om-first');
  assert.match(first, /已创建文档 PR/);
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);
  assert.equal(harness.fakeGithub.prs.length, 2);

  const firstId = computeSpecRequestId('om-first');
  const replay = await submitSpecRequirement(harness.deps, '增加一个导出入口', 'om-first');
  assert.match(replay, new RegExp(firstId));
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);

  const oldSpecPR = harness.fakeGithub.prs.find((pr) => pr.meta?.kind === 'spec-request')!;
  oldSpecPR.state = 'closed';
  oldSpecPR.merged = true;
  const second = await submitSpecRequirement(harness.deps, '增加一个导出入口', 'om-second');
  assert.match(second, /已创建文档 PR/);
  assert.notEqual(computeSpecRequestId('om-second'), firstId);
  assert.equal(harness.piInvocations.length, 2);
  assert.equal(harness.fakeGithub.prCreateCalls, 2);
});

test('旧 schema1 状态缺少 specRequests 可正常加载；messageId 必须是稳定身份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-old-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      repo: 'owner/repo',
      cursorMainSha: null,
      requirements: {},
      jobs: {},
      deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
      opLog: [],
    }),
    'utf8',
  );
  const store = new StateStore(file);
  const loaded = store.load();
  assert.deepEqual(loaded.specRequests, {});

  const harness = createHarness();
  const missingId = await submitSpecRequirement(harness.deps, '有效需求', '');
  assert.match(missingId, /缺少飞书消息 ID/);
  assert.equal(harness.piInvocations.length, 0);
  assert.throws(() => computeSpecRequestId('   '), /缺少飞书消息 ID/);
  assert.throws(() => normalizeSpecDescription('   '), /描述为空/);
  assert.throws(() => normalizeSpecDescription('x'.repeat(2001)), /超过 2000/);
});

test('同 target 的 failed 请求、活动 Worker 与 open 代码 PR 都阻止并行交付；stale 释放', async () => {
  const failedHarness = createHarness();
  const failedReq = specRequestState(
    computeSpecRequestId('om-failed'),
    'om-failed',
    '失败请求',
    failedHarness.fixture.baseSHA,
  );
  failedReq.stage = 'failed';
  failedReq.failureStage = 'pi';
  failedReq.error = 'Pi failed';
  await failedHarness.state.update((state) => {
    state.specRequests[failedReq.requestId] = failedReq;
  });
  const blockedBySpec = await submitSpecRequirement(failedHarness.deps, '另一条需求', 'om-other');
  assert.match(blockedBySpec, /重试需求/);
  assert.equal(failedHarness.piInvocations.length, 0);

  const workerHarness = createHarness();
  await workerHarness.state.update((state) => {
    state.jobs.processing = makeJob('processing', 1, 'processing', workerHarness.fixture.baseSHA);
  });
  const blockedByWorker = await submitSpecRequirement(workerHarness.deps, '另一条需求', 'om-worker');
  assert.match(blockedByWorker, /活动 Worker #3/);
  assert.equal(workerHarness.piInvocations.length, 0);

  const prHarness = createHarness();
  prHarness.fakeGithub.addPR({
    number: 4,
    title: 'open code PR',
    body: '',
    state: 'open',
    merged: false,
    headRefName: 'pi/open',
    baseRefName: 'main',
    meta: { kind: 'code-pr', reqId: 'REQ-CNT-01' },
  });
  const blockedByPR = await submitSpecRequirement(prHarness.deps, '另一条需求', 'om-pr');
  assert.match(blockedByPR, /活动代码交付 PR/);
  assert.equal(prHarness.piInvocations.length, 0);

  const staleHarness = createHarness();
  const staleReq = specRequestState(
    computeSpecRequestId('om-stale'),
    'om-stale',
    '过期请求',
    'f'.repeat(40),
  );
  staleReq.stage = 'stale';
  await staleHarness.state.update((state) => {
    state.specRequests[staleReq.requestId] = staleReq;
  });
  const staleReleased = await submitSpecRequirement(staleHarness.deps, '新需求', 'om-new-after-stale');
  assert.match(staleReleased, /已创建文档 PR/);
  assert.equal(staleHarness.piInvocations.length, 1);
});

const invalidOutputs: Array<{ name: string; output: unknown }> = [
  {
    name: '额外字段',
    output: { summary: '摘要', content: updatedDoc('extra'), extra: true },
  },
  {
    name: '新增需求 ID',
    output: {
      summary: '摘要',
      content: `${updatedDoc('new-id')}\n### [REQ-CNT-02] 不应新增\n\n#### 功能\n- 越权\n`,
    },
  },
  {
    name: '不变文档',
    output: { summary: '摘要', content: BASE_DOC },
  },
  {
    name: '修改需求块外内容',
    output: { summary: '摘要', content: updatedDoc('outside').replace('# 计数器演示', '# 被改写') },
  },
  {
    name: '前导空行之外的 prefix 仍被改写',
    output: {
      summary: '摘要',
      content: `\n${updatedDoc('outside-with-leading-line').replace('# 计数器演示', '# 被改写')}`,
    },
  },
  {
    name: '非法需求格式',
    output: { summary: '摘要', content: BASE_DOC.replace('### [REQ-CNT-01]', '### [REQ-CNT-01') },
  },
];

for (const scenario of invalidOutputs) {
  test(`无效/越权模型输出被拒绝：${scenario.name}`, async () => {
    const harness = createHarness();
    harness.setPiResponder(() => successPi(scenario.output));
    const result = await submitSpecRequirement(harness.deps, '修改计数器', `om-invalid-${scenario.name}`);
    assert.match(result, /失败/);
    const requests = Object.values(harness.state.snapshot().specRequests);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.stage, 'failed');
    assert.equal(requests[0]?.failureStage, 'pi');
    assert.equal(harness.fakeGithub.branchSHAs.size, 0);
    assert.equal(harness.fakeGithub.prs.length, 0);
  });
}

test('模型候选仅在整份文档开头多出空行时接受，并保存原基线块外内容', async () => {
  const harness = createHarness();
  harness.setPiResponder(() =>
    successPi({ summary: '前导空行兼容', content: `\n${updatedDoc('leading-line')}` }),
  );
  const result = await submitSpecRequirement(harness.deps, '兼容模型前导空行', 'om-leading-line');
  assert.match(result, /已创建文档 PR/);

  const requestId = computeSpecRequestId('om-leading-line');
  const requestDir = join(harness.runDir, 'spec-intake', requestId);
  const expected = updatedDoc('leading-line');
  assert.equal(readFileSync(join(requestDir, 'doc.md'), 'utf8'), expected);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.docContent, expected);
  assert.equal(readFileSync(join(requestDir, 'repo', 'docs', 'specs', 'counter.md'), 'utf8'), expected);
});

test('原文档自身的前导空行会被保留，不因模型省略开头空行而丢失', async () => {
  const leadingBase = `\n\n${BASE_DOC}`;
  const harness = createHarness({ baseDoc: leadingBase });
  harness.setPiResponder(() =>
    successPi({ summary: '保留基线前导空行', content: updatedDoc('preserve-base-leading-lines') }),
  );
  const result = await submitSpecRequirement(harness.deps, '保留原文档前导空行', 'om-preserve-leading-lines');
  assert.match(result, /已创建文档 PR/);

  const requestId = computeSpecRequestId('om-preserve-leading-lines');
  const requestDir = join(harness.runDir, 'spec-intake', requestId);
  const expected = updatedDoc('preserve-base-leading-lines', leadingBase);
  assert.ok(expected.startsWith('\n\n# 计数器演示'));
  assert.equal(readFileSync(join(requestDir, 'doc.md'), 'utf8'), expected);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.docContent, expected);
  assert.equal(readFileSync(join(requestDir, 'repo', 'docs', 'specs', 'counter.md'), 'utf8'), expected);
});

test('spec-author 在独立空目录运行，快照经 stdin 提供；控制器只提交 counter.md 且 PR 使用固定 meta 模板', async () => {
  const harness = createHarness();
  harness.setPiResponder(() =>
    successPi({ summary: '不可信摘要不应进入 PR', content: updatedDoc('metadata') }),
  );
  const description = '增加导出入口\n并保留计数器';
  const result = await submitSpecRequirement(harness.deps, description, 'om-success');
  assert.match(result, /已创建文档 PR/);

  const requestId = computeSpecRequestId('om-success');
  const requestDir = join(harness.runDir, 'spec-intake', requestId);
  const invocation = harness.piInvocations[0]!;
  assert.equal(invocation.workDir, join(requestDir, 'pi'));
  assert.notEqual(invocation.workDir, harness.fixture.repoDir);
  assert.ok(!invocation.sandbox?.writableDirs.includes(harness.fixture.repoDir));
  assert.ok(!invocation.sandbox?.writableDirs.includes(join(requestDir, 'repo')));
  assert.match(invocation.prompt, /增加导出入口\n并保留计数器/);
  assert.match(invocation.prompt, /# 计数器演示/);

  const worktree = join(requestDir, 'repo');
  assert.equal(existsSync(worktree), true);
  assert.equal(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], worktree), 'docs/specs/counter.md');
  assert.equal(git(['rev-parse', 'HEAD^'], worktree), harness.fixture.baseSHA);
  assert.equal(git(['ls-files', '--stage', '--', 'docs/specs/counter.md'], worktree).split(/\s+/, 1)[0], '100644');

  const specPR = harness.fakeGithub.prs.find((pr) => pr.meta?.kind === 'spec-request')!;
  assert.match(specPR.body, /kind=spec-request/);
  assert.match(specPR.body, /sourceMainSha/);
  assert.match(specPR.body, new RegExp(harness.fixture.baseSHA));
  assert.ok(!specPR.body.includes('不可信摘要不应进入 PR'));
  assert.ok(!/Closes\s+#\d+/i.test(specPR.body));
  assert.equal(specPR.labels.includes('spec-patch'), true);
  const request = harness.state.snapshot().specRequests[requestId];
  assert.equal(request?.stage, 'pr-open');
  assert.equal(request?.labelsSynced, true);
});

test('Pi 超时进入显式 retry；已产出文档/commit 后不因 push 失败重跑 Pi', async () => {
  const harness = createHarness();
  harness.setPiResponder(() => ({
    ok: false,
    exitCode: 124,
    stdout: 'secret raw stdout',
    stderr: 'Bearer should-not-leak',
    output: undefined,
    durationMs: 100,
    timedOut: true,
    error: 'timeout',
  }));
  const first = await submitSpecRequirement(harness.deps, '增加超时恢复', 'om-timeout');
  const requestId = computeSpecRequestId('om-timeout');
  assert.match(first, /重试需求/);
  assert.ok(!first.includes('secret raw stdout'));
  assert.equal(harness.state.snapshot().specRequests[requestId]?.stage, 'failed');
  assert.equal(harness.state.snapshot().specRequests[requestId]?.failureStage, 'pi');

  harness.setPiResponder(() => successPi({ summary: '恢复成功', content: updatedDoc('retry') }));
  harness.trackingGit.failPush = true;
  const pushFailed = await retrySpecRequirement(harness.deps, requestId);
  assert.match(pushFailed, /需求重试失败/);
  assert.equal(harness.piInvocations.length, 2);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.failureStage, 'push');
  assert.equal(harness.fakeGithub.prCreateCalls, 0);

  harness.trackingGit.failPush = false;
  const recovered = await retrySpecRequirement(harness.deps, requestId);
  assert.match(recovered, /已创建文档 PR/);
  assert.equal(harness.piInvocations.length, 2);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);
  assert.equal(harness.fakeGithub.prs.length, 1);
});

test('有效 artifact 已落盘但 state 提交失败时，重启 retry 从 artifact 恢复且不重复 Pi', async () => {
  const harness = createHarness({
    stateFactory: (file, initialState) => new FailFirstDocPersistStateStore(file, initialState),
  });
  harness.setPiResponder(() => successPi({ summary: '落盘失败恢复', content: updatedDoc('artifact-window') }));

  const first = await submitSpecRequirement(harness.deps, '测试 artifact 恢复', 'om-artifact-window');
  assert.match(first, /失败/);
  const requestId = computeSpecRequestId('om-artifact-window');
  const artifact = join(harness.runDir, 'spec-intake', requestId, 'doc.md');
  assert.equal(existsSync(artifact), true);
  assert.equal(readFileSync(artifact, 'utf8'), updatedDoc('artifact-window'));
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.hasValidDoc, false);

  const restarted = new StateStore(harness.stateFile);
  restarted.load();
  harness.state = restarted;
  harness.deps.state = restarted;
  const recovered = await retrySpecRequirement(harness.deps, requestId);
  assert.match(recovered, /已创建文档 PR/);
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.hasValidDoc, true);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.stage, 'pr-open');
});

test('已落盘半写或无效 artifact 明确失败，不静默覆盖并重跑 Pi', async () => {
  const harness = createHarness();
  const messageId = 'om-invalid-artifact';
  const requestId = computeSpecRequestId(messageId);
  const request = {
    ...specRequestState(requestId, messageId, '无效 artifact', harness.fixture.baseSHA),
    stage: 'failed' as const,
    failureStage: 'pi' as const,
  };
  const requestDir = join(harness.runDir, 'spec-intake', requestId);
  mkdirSync(requestDir, { recursive: true });
  writeFileSync(join(requestDir, 'doc.md'), '# 半写文档', 'utf8');
  await harness.state.update((state) => {
    state.specRequests[requestId] = request;
  });

  const result = await retrySpecRequirement(harness.deps, requestId);
  assert.match(result, /需求重试失败/);
  assert.match(result, /已落盘需求文档无效，拒绝覆盖或重跑 Pi/);
  assert.equal(harness.piInvocations.length, 0);
});

test('分支读取网络错误 fail closed；retry 后复用已有 commit，不重跑 Pi', async () => {
  const harness = createHarness();
  harness.fakeGithub.failBranchRead = true;
  const result = await submitSpecRequirement(harness.deps, '测试分支对账', 'om-branch-fail');
  assert.match(result, /读取远端分支/);
  const requestId = computeSpecRequestId('om-branch-fail');
  assert.equal(harness.state.snapshot().specRequests[requestId]?.failureStage, 'push');
  assert.equal(harness.piInvocations.length, 1);

  harness.fakeGithub.failBranchRead = false;
  const recovered = await retrySpecRequirement(harness.deps, requestId);
  assert.match(recovered, /已创建文档 PR/);
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);
});

test('PR 创建响应丢失后先从 all PR 按 branch/meta 对账，不重复创建', async () => {
  const harness = createHarness();
  harness.fakeGithub.loseCreateResponse = true;
  const first = await submitSpecRequirement(harness.deps, '测试 PR 响应丢失', 'om-pr-response-lost');
  assert.match(first, /失败/);
  const requestId = computeSpecRequestId('om-pr-response-lost');
  assert.equal(harness.state.snapshot().specRequests[requestId]?.failureStage, 'pr');
  assert.equal(harness.fakeGithub.prCreateCalls, 1);

  harness.fakeGithub.loseCreateResponse = false;
  const recovered = await retrySpecRequirement(harness.deps, requestId);
  assert.match(recovered, /已创建文档 PR/);
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);
  assert.equal(harness.fakeGithub.prs.length, 1);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.labelsSynced, true);
});

test('spec-patch 标签失败后保留 PR 身份，retry/reconcile 幂等补齐标签', async () => {
  const harness = createHarness();
  harness.fakeGithub.failLabelOnce = true;
  const first = await submitSpecRequirement(harness.deps, '测试标签恢复', 'om-label-fail');
  assert.match(first, /失败/);
  const requestId = computeSpecRequestId('om-label-fail');
  const failed = harness.state.snapshot().specRequests[requestId];
  assert.equal(failed?.stage, 'failed');
  assert.equal(failed?.failureStage, 'pr-open');
  assert.equal(failed?.prNumber, 10);
  assert.equal(failed?.labelsSynced, false);

  const recovered = await retrySpecRequirement(harness.deps, requestId);
  assert.match(recovered, /已创建文档 PR/);
  assert.equal(harness.piInvocations.length, 1);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);
  assert.equal(harness.fakeGithub.prs[0]?.labels.includes('spec-patch'), true);
  assert.equal(harness.state.snapshot().specRequests[requestId]?.labelsSynced, true);
});

test('Pi 后 main 漂移立即 stale，不 push/PR；新消息以新主线重新提交', async () => {
  const harness = createHarness();
  let first = true;
  harness.setPiResponder(() => {
    if (first) {
      first = false;
      advanceRemote(harness.fixture, 'drift-after-pi');
    }
    return successPi({ summary: '漂移测试', content: updatedDoc('drift-safe') });
  });

  const oldResult = await submitSpecRequirement(harness.deps, '漂移期间的需求', 'om-drift-old');
  assert.match(oldResult, /重新发送需求/);
  const oldId = computeSpecRequestId('om-drift-old');
  assert.equal(harness.state.snapshot().specRequests[oldId]?.stage, 'stale');
  assert.equal(harness.fakeGithub.prCreateCalls, 0);
  assert.equal(existsSync(join(harness.runDir, 'spec-intake', oldId, 'repo')), false);

  const newResult = await submitSpecRequirement(harness.deps, '漂移期间的需求', 'om-drift-new');
  assert.match(newResult, /已创建文档 PR/);
  const newId = computeSpecRequestId('om-drift-new');
  assert.equal(harness.state.snapshot().specRequests[newId]?.baseSHA, git(['rev-parse', 'origin/main'], harness.fixture.repoDir));
  assert.equal(harness.piInvocations.length, 2);
  assert.equal(harness.fakeGithub.prCreateCalls, 1);
});

function remoteRequest(
  harness: Harness,
  messageId: string,
  stage: SpecRequest['stage'],
  prNumber: number,
  commitSHA: string,
  docContent: string,
): SpecRequest {
  const requestId = computeSpecRequestId(messageId);
  harness.fakeGithub.branchSHAs.set(`pi/spec-${requestId}`, commitSHA);
  const request: SpecRequest = {
    ...specRequestState(requestId, messageId, '远端恢复测试', harness.fixture.baseSHA),
    stage,
    hasValidDoc: true,
    docContent,
    summary: '远端恢复',
    commitSHA,
    prNumber,
    prUrl: `https://github.com/owner/repo/pull/${prNumber}`,
    labelsSynced: false,
  };
  return request;
}

function addRemoteSpecPR(
  harness: Harness,
  request: SpecRequest,
  prNumber: number,
  headSHA = request.commitSHA,
): FakePR {
  return harness.fakeGithub.addPR({
    number: prNumber,
    title: '[REQ-CNT-01] 文档恢复',
    body: 'kind=spec-request',
    state: 'open',
    merged: false,
    headRefName: request.branch,
    headSHA,
    baseRefName: 'main',
    meta: {
      kind: 'spec-request',
      reqId: 'REQ-CNT-01',
      requestId: request.requestId,
      specPath: 'docs/specs/counter.md',
      sourceMainSha: request.baseSHA,
      source: 'feishu-intake',
    },
    labels: [],
  });
}

test('远端已有 open spec PR 时绑定真实 docs-only commit 并补标签，不重跑 Pi 或重复建 PR', async () => {
  const harness = createHarness();
  const marker = 'remote-open';
  const commitSHA = createSpecCommit(harness, marker);
  const request = remoteRequest(harness, 'om-remote-open', 'failed', 20, commitSHA, updatedDoc(marker));
  request.failureStage = 'pr';
  addRemoteSpecPR(harness, request, 20);
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });

  const result = await retrySpecRequirement(harness.deps, request.requestId);
  assert.match(result, /pull\/20/);
  assert.equal(harness.piInvocations.length, 0);
  assert.equal(harness.fakeGithub.prCreateCalls, 0);
  assert.equal(harness.fakeGithub.prs[0]?.labels.includes('spec-patch'), true);
  assert.equal(harness.state.snapshot().specRequests[request.requestId]?.labelsSynced, true);
});

test('远端 PR head SHA 与 state commitSHA 不一致时拒绝恢复且不加标签', async () => {
  const harness = createHarness();
  const marker = 'head-mismatch';
  const commitSHA = createSpecCommit(harness, marker);
  const request = remoteRequest(harness, 'om-head-mismatch', 'failed', 22, commitSHA, updatedDoc(marker));
  request.failureStage = 'pr';
  addRemoteSpecPR(harness, request, 22, 'b'.repeat(40));
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });

  const result = await retrySpecRequirement(harness.deps, request.requestId);
  assert.match(result, /需求重试失败/);
  assert.match(result, /head SHA.*commitSHA.*不一致/);
  assert.equal(harness.fakeGithub.labelCalls.length, 0);
  assert.equal(harness.state.snapshot().specRequests[request.requestId]?.stage, 'failed');
});

test('远端 PR 缺少实际 head SHA 时拒绝恢复且不加标签', async () => {
  const harness = createHarness();
  const marker = 'missing-head';
  const commitSHA = createSpecCommit(harness, marker);
  const request = remoteRequest(harness, 'om-missing-head', 'failed', 23, commitSHA, updatedDoc(marker));
  request.failureStage = 'pr';
  addRemoteSpecPR(harness, request, 23);
  harness.fakeGithub.omitHeadSHA.add(23);
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });

  const result = await retrySpecRequirement(harness.deps, request.requestId);
  assert.match(result, /需求重试失败/);
  assert.match(result, /缺少实际 head SHA/);
  assert.equal(harness.fakeGithub.labelCalls.length, 0);
  assert.equal(harness.state.snapshot().specRequests[request.requestId]?.stage, 'failed');
});

test('远端 PR commit 内容与已验证 artifact 不一致时拒绝恢复', async () => {
  const harness = createHarness();
  const commitSHA = createSpecCommit(harness, 'committed-content');
  const request = remoteRequest(
    harness,
    'om-content-mismatch',
    'failed',
    24,
    commitSHA,
    updatedDoc('expected-content'),
  );
  request.failureStage = 'pr';
  addRemoteSpecPR(harness, request, 24);
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });

  const result = await retrySpecRequirement(harness.deps, request.requestId);
  assert.match(result, /需求重试失败/);
  assert.match(result, /提交内容与 state 中已校验文档 artifact 不一致/);
  assert.equal(harness.fakeGithub.labelCalls.length, 0);
});

test('远端 PR commit 的 counter.md 非普通 100644 文件时拒绝恢复', async () => {
  const harness = createHarness();
  const marker = 'executable';
  const commitSHA = createSpecCommit(harness, marker, { executable: true });
  const request = remoteRequest(harness, 'om-mode-mismatch', 'failed', 25, commitSHA, updatedDoc(marker));
  request.failureStage = 'pr';
  addRemoteSpecPR(harness, request, 25);
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });

  const result = await retrySpecRequirement(harness.deps, request.requestId);
  assert.match(result, /需求重试失败/);
  assert.match(result, /Git mode 必须是 100644，实际 100755/);
  assert.equal(harness.fakeGithub.labelCalls.length, 0);
});

test('远端对账失败不把已有 pr-open 误判为不存在或改写阶段', async () => {
  const harness = createHarness();
  const request = remoteRequest(harness, 'om-remote-fail', 'pr-open', 21, 'a'.repeat(40), updatedDoc('remote-fail'));
  request.labelsSynced = true;
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });
  harness.fakeGithub.failList = true;
  const result = await retrySpecRequirement(harness.deps, request.requestId);
  assert.match(result, /需求重试失败/);
  assert.equal(harness.state.snapshot().specRequests[request.requestId]?.stage, 'pr-open');
  assert.equal(harness.fakeGithub.prCreateCalls, 0);
});

function makeConfig(root: string): Config {
  return {
    repo: 'owner/repo',
    repoDir: join(root, 'repo'),
    runDir: join(root, 'run'),
    stateFile: join(root, 'runtime-state.json'),
    mainBranch: 'main',
    httpPort: 4000,
    previewPort: 5173,
    devPort: 5174,
    publicUrl: '',
    pollIntervalMs: 5000,
    piTimeoutMs: 300000,
    piGraceMs: 5000,
    buildTimeoutMs: 180000,
    verifyTimeoutMs: 300000,
    piAttempts: 2,
    piProvider: 'fake',
    piModel: 'fake/model',
    piAgentDir: join(root, 'agent'),
    errorDedupWindowMs: 600000,
    revisionBudget: 2,
    logRetentionDays: 7,
    reportToken: '',
    feishu: { enabled: false, allowedUserIds: [] },
  };
}

test('runtime createCore 使用真实 spec-intake 接线，status 只读与 require 共享的状态快照', async () => {
  const fixture = createRepoFixture();
  const config = makeConfig(fixture.root);
  config.repoDir = fixture.repoDir;
  config.runDir = join(fixture.root, 'runtime-run');
  config.stateFile = join(fixture.root, 'runtime-state.json');
  config.piAgentDir = join(fixture.root, 'runtime-agent');
  const core = createCore(config, 'owner/repo');
  const fakeGithub = new FakeGithub();
  const github = new GithubClient('owner/repo', fakeGithub.runner);
  const trackingGit = new TrackingGitClient(fakeGithub.branchSHAs);
  const piInvocations: PiInvocation[] = [];

  Object.assign(core.specIntakeDeps, {
    repoDir: fixture.repoDir,
    runDir: config.runDir,
    git: trackingGit,
    github,
    runPi: async (invocation: PiInvocation) => {
      piInvocations.push(invocation);
      return successPi({ summary: 'runtime 接线', content: updatedDoc('runtime') });
    },
  });
  await core.state.update((state) => {
    state.repo = 'owner/repo';
  });

  const result = await core.commands.require('运行接线测试', 'om-runtime-wire');
  assert.match(result, /已创建文档 PR/);
  assert.equal(piInvocations.length, 1);
  assert.equal(fakeGithub.prCreateCalls, 1);
  const listCallsBeforeStatus = fakeGithub.listCalls;
  const status = await core.commands.status();
  assert.match(status, new RegExp(computeSpecRequestId('om-runtime-wire')));
  assert.match(status, /pr-open/);
  assert.equal(fakeGithub.listCalls, listCallsBeforeStatus);
});

test('Pi 延迟执行期间 status 立即返回当前 stage', async () => {
  const harness = createHarness();
  let releasePi: ((result: PiResult) => void) | undefined;
  harness.setPiResponder(
    () =>
      new Promise<PiResult>((resolve) => {
        releasePi = resolve;
      }),
  );
  const pending = submitSpecRequirement(harness.deps, '延迟 Pi 状态查询', 'om-delayed-status');
  for (let attempt = 0; attempt < 100 && harness.piInvocations.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.piInvocations.length, 1);

  const commands = createCommands({
    repoDir: harness.fixture.repoDir,
    state: harness.state,
    github: harness.github,
    git: harness.trackingGit,
    logger: silentLogger,
    deploy: {} as Parameters<typeof createCommands>[0]['deploy'],
    worker: {} as Parameters<typeof createCommands>[0]['worker'],
  });
  const listCallsBeforeStatus = harness.fakeGithub.listCalls;
  const status = await Promise.race([
    commands.status(),
    new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('status 被延迟 Pi 阻塞')), 250);
    }),
  ]);
  assert.match(status, new RegExp(computeSpecRequestId('om-delayed-status')));
  assert.match(status, / pi(?:\n|\s|$)/);
  assert.equal(harness.fakeGithub.listCalls, listCallsBeforeStatus);

  assert.ok(releasePi, 'Pi responder 未被调用');
  releasePi(successPi({ summary: '延迟完成', content: updatedDoc('delayed-status') }));
  assert.match(await pending, /已创建文档 PR/);
});

test('reconcileSpecRequests 对远端列表错误 fail closed，不修改本地请求', async () => {
  const harness = createHarness();
  const request = specRequestState(
    computeSpecRequestId('om-reconcile-error'),
    'om-reconcile-error',
    '对账错误',
    harness.fixture.baseSHA,
  );
  await harness.state.update((state) => {
    state.specRequests[request.requestId] = request;
  });
  harness.fakeGithub.failList = true;
  await assert.rejects(() => reconcileSpecRequests(harness.deps), /fake network failure/);
  assert.equal(harness.state.snapshot().specRequests[request.requestId]?.stage, 'pi');
});
