import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BrowserGateOptions, BrowserGateResult } from '../orchestrator/browser-gate.ts';
import type { Config } from '../orchestrator/config.ts';
import {
  deployMergedPR,
  deployOnce,
  panelActivePointerPath,
  panelReleaseDir,
  readPanelActivePointer,
  retryDeployForIssue,
  writePanelActivePointer,
  type DeployDeps,
  type PanelActivePointer,
} from '../orchestrator/deploy.ts';
import {
  deliveryProfile,
  type DeliveryProfile,
  type PanelBinding,
} from '../orchestrator/delivery-profile.ts';
import type { GitClient } from '../orchestrator/git.ts';
import type { GithubClient } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import {
  createPanelServer,
  resolvePanelReleaseAsset,
} from '../orchestrator/panel-server.ts';
import { panelRunDirForStateFile } from '../orchestrator/panel.ts';
import { createBuild } from '../orchestrator/runtime.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { StateStore } from '../orchestrator/state.ts';
import { createTestEvidenceStore } from '../orchestrator/test-evidence.ts';
import {
  emptyState,
  type DispatchRevision,
  type DispatchTask,
  type JobState,
  type ManagedIssue,
  type ManagedPR,
  type OrchestratorState,
} from '../orchestrator/types.ts';
import type { CommandRunner } from '../orchestrator/validate.ts';

const REPO = 'sunpcm/spec-loop';
const REPOSITORY_ID = 'github-repository-id:9001';
const PANEL_REQ_ID = 'REQ-PANEL-01';
const PANEL_SPEC_PATH = 'docs/specs/pending/panel.md';
const ISSUE = 41;
const PR = 42;
const SOURCE_ANCHOR = '1'.repeat(40);
const SOURCE_R2 = '2'.repeat(40);
const MERGE_SHA = '3'.repeat(40);
const TREE_SHA = '4'.repeat(40);
const COUNTER_ACTIVE_SHA = '5'.repeat(40);
const OLD_PANEL_SHA = '6'.repeat(40);
const OUTSIDE_SPEC = '7'.repeat(40);
const PUBLISHED_AT = '2026-11-23T01:02:03.000Z';
const RECEIPT_AT = '2026-11-23T01:03:04.000Z';
const SWITCHED_AT = '2026-11-23T01:02:30.000Z';

const PANEL_DOC = `# 受控面板

### [REQ-PANEL-01] 受控面板框架

#### 功能

- 显示只读等待说明。

#### 验收

- A1 显示当前等待角色。
- A2 显示当前任务版本。
- A3 提供可信证据入口。
- A4 健康通过后提供部署回执。
- A5 缺失证据时明确待核实。
- A6 不把历史回执用于当前版本。
- A7 离线时保留上次观察时间。
- A8 冲突时不猜测角色。
`;

const PANEL_DOC_R2 = PANEL_DOC.replace(
  '- A8 冲突时不猜测角色。',
  '- A8 冲突时明确提示并停止猜测。',
);

const PANEL_HASH = parseSpecs({ [PANEL_SPEC_PATH]: PANEL_DOC }).specs[0]!.hash;
const PANEL_HASH_R2 = parseSpecs({ [PANEL_SPEC_PATH]: PANEL_DOC_R2 }).specs[0]!.hash;

const SILENT_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const TASK: DispatchTask = {
  goal: '实现只读等待说明',
  steps: [{ text: '提供后端投影', acceptanceRefs: ['A1'] }],
  acceptance: { A1: '显示当前等待角色。' },
  allowedPaths: ['panel/src/**'],
  dependsOn: [],
};

function panelBinding(patch: Partial<PanelBinding> = {}): PanelBinding {
  return {
    repo: REPO,
    mainBranch: 'main',
    repositoryId: REPOSITORY_ID,
    issueNumber: ISSUE,
    confirmedMainSha: SOURCE_ANCHOR,
    specHash: PANEL_HASH,
    ...patch,
  };
}

function revision(
  number: number,
  options: {
    specHash?: string;
    sourceMainSha?: string;
    published?: boolean;
  } = {},
): DispatchRevision {
  const published = options.published ?? true;
  return {
    reqId: PANEL_REQ_ID,
    repoId: REPOSITORY_ID,
    revision: number,
    issueNumber: ISSUE,
    specHash: options.specHash ?? PANEL_HASH,
    specPath: PANEL_SPEC_PATH,
    sourceMainSha: options.sourceMainSha ?? SOURCE_ANCHOR,
    task: TASK,
    ...(published
      ? {
          publishedAt: PUBLISHED_AT,
          publicationCommentId: 700 + number,
        }
      : {}),
  };
}

function panelJob(
  number: number,
  options: {
    jobId?: string;
    specHash?: string;
    sourceMainSha?: string;
    status?: JobState['status'];
    resumeAction?: string;
  } = {},
): JobState {
  return {
    jobId: options.jobId ?? `panel-job-r${number}`,
    reqId: PANEL_REQ_ID,
    issueNumber: ISSUE,
    specHash: options.specHash ?? PANEL_HASH,
    sourceMainSha: options.sourceMainSha ?? SOURCE_ANCHOR,
    attempt: 1,
    status: options.status ?? 'in-review',
    prNumber: PR,
    dispatchRevision: number,
    startedAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    ...(options.resumeAction ? { resumeAction: options.resumeAction } : {}),
  };
}

function panelState(
  options: {
    revisionNumber?: number;
    specHash?: string;
    sourceMainSha?: string;
    includeAnchor?: boolean;
    published?: boolean;
  } = {},
): OrchestratorState {
  const number = options.revisionNumber ?? 1;
  const specHash = options.specHash ?? PANEL_HASH;
  const sourceMainSha = options.sourceMainSha ?? SOURCE_ANCHOR;
  const revisions = options.includeAnchor && number > 1
    ? [
        revision(1),
        revision(number, {
          specHash,
          sourceMainSha,
          published: options.published,
        }),
      ]
    : [
        revision(number, {
          specHash,
          sourceMainSha,
          published: options.published,
        }),
      ];
  return {
    ...emptyState(),
    repo: REPO,
    cursorMainSha: sourceMainSha,
    requirements: {
      [PANEL_REQ_ID]: {
        issueNumber: ISSUE,
        specHash,
        specPath: PANEL_SPEC_PATH,
        sourceMainSha,
      },
    },
    jobs: {
      [`panel-job-r${number}`]: panelJob(number, { specHash, sourceMainSha }),
    },
    dispatchRevisions: {
      [PANEL_REQ_ID]: revisions,
    },
  };
}

function panelPR(
  number: number,
  options: {
    jobId?: string;
    specHash?: string;
    sourceMainSha?: string;
  } = {},
): ManagedPR {
  const rev = number;
  const specHash = options.specHash ?? PANEL_HASH;
  const sourceMainSha = options.sourceMainSha ?? SOURCE_ANCHOR;
  return {
    number: PR,
    title: 'panel delivery',
    body: '',
    state: 'closed',
    merged: true,
    mergedAt: '2026-11-23T01:00:00.000Z',
    headRefName: `pi/req-panel-01-r${rev}`,
    headSHA: '8'.repeat(40),
    baseRefName: 'main',
    mergeCommitSha: MERGE_SHA,
    meta: {
      schema: 1,
      system: 'spec-loop',
      kind: 'code-pr',
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash,
      sourceMainSha,
      jobId: options.jobId ?? `panel-job-r${rev}`,
      dispatchRevision: rev,
    },
    labels: [],
  };
}

function panelPointer(): PanelActivePointer {
  return {
    schemaVersion: 1,
    project: 'panel',
    reqId: PANEL_REQ_ID,
    issueNumber: ISSUE,
    prNumber: PR,
    dispatchRevision: 1,
    jobId: 'panel-job-r1',
    activeSha: OLD_PANEL_SHA,
    releaseDir: join('/tmp/fake-run', 'panel-releases', OLD_PANEL_SHA),
    specHash: PANEL_HASH,
    sourceMainSha: SOURCE_ANCHOR,
    recordedAt: '2026-11-23T00:30:00.000Z',
  };
}

interface RemoteComment {
  id: number;
  marker: string;
  body: string;
  createdAt: string;
}

type EnsureMode = 'success' | 'fail-before-create' | 'lose-response';

class PanelRemote {
  issue: ManagedIssue = {
    number: ISSUE,
    title: '[REQ-PANEL-01] 受控面板',
    body: '',
    state: 'open',
    labels: ['pi-task', 'status:in-review'],
    meta: null,
    url: `https://github.com/${REPO}/issues/${ISSUE}`,
  };
  readonly comments: RemoteComment[] = [];
  readonly ensureCalls: Array<{ issue: number; marker: string; body: string }> = [];
  readonly commentsWritten: string[] = [];
  ensureMode: EnsureMode = 'success';
  onEnsure?: () => void;
  private nextCommentId = 900;

  async listIssues(): Promise<ManagedIssue[]> {
    return [structuredClone(this.issue)];
  }

  async removeLabels(_issue: number, labels: string[]): Promise<void> {
    this.issue.labels = this.issue.labels.filter((label) => !labels.includes(label));
  }

  async addLabels(_issue: number, labels: string[]): Promise<void> {
    for (const label of labels) {
      if (!this.issue.labels.includes(label)) this.issue.labels.push(label);
    }
  }

  async closeIssue(): Promise<void> {
    this.issue.state = 'closed';
  }

  async reopenIssue(): Promise<void> {
    this.issue.state = 'open';
  }

  async comment(_issue: number, body: string): Promise<void> {
    this.commentsWritten.push(body);
  }

  async listIssueComments(): Promise<Array<{ id: number; body: string }>> {
    return this.comments.map((comment) => ({ id: comment.id, body: comment.body }));
  }

  async ensureDispatchComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<{ id: number; createdAt: string }> {
    this.ensureCalls.push({ issue: issueNumber, marker, body });
    this.onEnsure?.();
    if (this.ensureMode === 'fail-before-create') {
      throw new Error('模拟回执发布失败');
    }
    const existing = this.comments.find((comment) => comment.marker === marker);
    if (existing) {
      return { id: existing.id, createdAt: existing.createdAt };
    }
    const created: RemoteComment = {
      id: this.nextCommentId++,
      marker,
      body,
      createdAt: RECEIPT_AT,
    };
    this.comments.push(created);
    if (this.ensureMode === 'lose-response') {
      this.ensureMode = 'success';
      throw new Error('模拟评论已创建但响应丢失');
    }
    return { id: created.id, createdAt: created.createdAt };
  }
}

interface DeployCalls {
  builds: Array<{ sha: string; context?: Parameters<DeployDeps['build']>[1] }>;
  health: Array<{ sha: string; releaseDir?: string }>;
  switches: Array<{ sha: string | null; releaseDir: string | null }>;
  notifications: string[];
}

interface DeployFixture {
  store: StateStore;
  ctx: DeployDeps;
  calls: DeployCalls;
}

function createStore(
  state: OrchestratorState,
): { dir: string; file: string; runDir: string; store: StateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-panel-deploy-'));
  const file = join(dir, 'state.json');
  const runDir = join(dir, '.orchestrator');
  mkdirSync(runDir, { recursive: true });
  return { dir, file, runDir, store: new StateStore(file, structuredClone(state)) };
}

function deployFixture(options: {
  store: StateStore;
  runDir: string;
  prs: ManagedPR[];
  remote: PanelRemote;
  panelBinding?: PanelBinding;
  buildOk?: boolean;
  healthOk?: boolean;
}): DeployFixture {
  const calls: DeployCalls = {
    builds: [],
    health: [],
    switches: [],
    notifications: [],
  };
  const ctx: DeployDeps = {
    repoDir: '/tmp/fake-panel-repo',
    runDir: options.runDir,
    git: {
      fetch: async () => {},
    } as unknown as GitClient,
    github: options.remote as unknown as GithubClient,
    state: options.store,
    logger: SILENT_LOGGER,
    mainBranch: 'main',
    ...(options.panelBinding ? { panelBinding: options.panelBinding } : {}),
    build: async (sha, context) => {
      calls.builds.push({ sha, context });
      return options.buildOk === false
        ? { ok: false, detail: '模拟构建失败' }
        : { ok: true, detail: '构建成功' };
    },
    healthCheck: async (sha, releaseDir) => {
      calls.health.push({ sha, releaseDir });
      return options.healthOk ?? true;
    },
    switchPreview: async (sha, releaseDir, context) => {
      calls.switches.push({ sha, releaseDir });
      if (!context || context.profile.project !== 'panel') return;
      if (sha === null) {
        rmSync(panelActivePointerPath(options.runDir), { force: true });
        return;
      }
      if (!releaseDir) throw new Error('缺少面板发布目录');
      writePanelActivePointer(options.runDir, {
        schemaVersion: 1,
        project: 'panel',
        reqId: context.reqId,
        issueNumber: context.issueNumber,
        prNumber: context.prNumber,
        ...(context.dispatchRevision === undefined
          ? {}
          : { dispatchRevision: context.dispatchRevision }),
        jobId: context.jobId,
        activeSha: sha,
        releaseDir,
        specHash: context.specHash,
        sourceMainSha: context.sourceMainSha,
        recordedAt: SWITCHED_AT,
      });
    },
    notify: async (text) => {
      calls.notifications.push(text);
    },
  };
  // listPRs is only used by the deployment entry points.
  (ctx.github as unknown as { listPRs: () => Promise<ManagedPR[]> }).listPRs =
    async () => structuredClone(options.prs);
  return { store: options.store, ctx, calls };
}

function panelContext(
  profile: DeliveryProfile,
  number = 1,
  specHash = PANEL_HASH,
  sourceMainSha = SOURCE_ANCHOR,
) {
  return {
    profile,
    reqId: PANEL_REQ_ID,
    issueNumber: ISSUE,
    prNumber: PR,
    jobId: `panel-job-r${number}`,
    dispatchRevision: number,
    specHash,
    specPath: PANEL_SPEC_PATH,
    sourceMainSha,
  };
}

function buildConfig(root: string, binding: PanelBinding): Config {
  return {
    repoDir: join(root, 'repo'),
    runDir: join(root, 'repo', '.orchestrator'),
    buildTimeoutMs: 1_000,
    piAgentDir: join(root, 'repo', '.orchestrator', 'agent'),
    panelBinding: binding,
  } as Config;
}

function successfulGateResult(): BrowserGateResult {
  return {
    ok: true,
    detail: '浏览器验收通过',
    reportDir: '/tmp/panel-report',
    reportPath: '/tmp/panel-report/results.json',
    stdoutLogPath: '/tmp/panel-report/stdout.txt',
    stderrLogPath: '/tmp/panel-report/stderr.txt',
  };
}

function commandRunner(
  calls: Array<{ cmd: string; args: string[]; cwd: string }>,
): CommandRunner {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return { code: 0, stdout: 'ok', stderr: '' };
  };
}

test('面板合并构建从实际归档读取精确 pending 规格并运行 build:panel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-build-'));
  try {
    const binding = panelBinding();
    const config = buildConfig(root, binding);
    // 工作树中的旧副本不能替代本版归档正文。
    mkdirSync(join(config.repoDir, 'docs', 'specs', 'pending'), { recursive: true });
    writeFileSync(
      join(config.repoDir, PANEL_SPEC_PATH),
      PANEL_DOC_R2,
      'utf8',
    );
    const git = {
      revParse: async () => TREE_SHA,
      archive: async (_cwd: string, _sha: string, destination: string) => {
        mkdirSync(join(destination, 'docs', 'specs', 'pending'), { recursive: true });
        writeFileSync(join(destination, PANEL_SPEC_PATH), PANEL_DOC, 'utf8');
      },
    } as unknown as GitClient;
    const commands: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    let gate: BrowserGateOptions | undefined;
    const build = createBuild(
      config,
      git,
      commandRunner(commands),
      async (options) => {
        gate = options;
        return successfulGateResult();
      },
    );
    const profile = deliveryProfile(PANEL_REQ_ID, binding)!;
    const result = await build(
      MERGE_SHA,
      panelContext(profile),
    );

    assert.deepEqual(result, { ok: true, detail: '构建成功' });
    assert.ok(
      commands.some(
        (entry) => entry.cmd === 'npm' && entry.args.join(' ') === 'run build:panel',
      ),
    );
    assert.equal(gate?.project, 'panel');
    assert.equal(gate?.mountPath, `/releases/${MERGE_SHA}/`);
    assert.equal(gate?.specFiles[PANEL_SPEC_PATH], PANEL_DOC);
    assert.notEqual(gate?.specFiles[PANEL_SPEC_PATH], PANEL_DOC_R2);
    assert.equal(gate?.artifactDir, panelReleaseDir(config.runDir, MERGE_SHA));
    assert.equal(gate?.jobId, 'panel-job-r1');
    assert.equal(gate?.reqId, PANEL_REQ_ID);
    assert.equal(gate?.specPath, PANEL_SPEC_PATH);
    assert.equal(gate?.dispatchRevision, 1);
    assert.equal(gate?.sourceMainSha, SOURCE_ANCHOR);
    assert.equal(gate?.candidateTreeSha, TREE_SHA);

    const evidence = createTestEvidenceStore({
      rootDir: join(config.runDir, 'test-runs'),
    }).listRuns();
    const nodeRun = evidence.runs.find((run) => run.stage === 'build');
    assert.ok(nodeRun, '合并构建必须落盘 node:test 证据');
    assert.equal(nodeRun.reqId, PANEL_REQ_ID);
    assert.equal(nodeRun.specPath, PANEL_SPEC_PATH);
    assert.equal(nodeRun.dispatchRevision, 1);
    assert.equal(nodeRun.specHash, PANEL_HASH);
    assert.equal(nodeRun.sourceMainSha, SOURCE_ANCHOR);
    assert.equal(nodeRun.candidateTreeSha, TREE_SHA);
    assert.equal(nodeRun.version, MERGE_SHA);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('实际归档缺失、错哈希或规格路径符号链接时在构建和浏览器验收前失败', async (t) => {
  const cases: Array<{
    name: string;
    prepare: (root: string, destination: string, outside: string) => void;
    expectedHash?: string;
    expected: RegExp;
  }> = [
    {
      name: '缺少 pending/panel.md',
      prepare: () => {},
      expected: /归档缺少受信规格/,
    },
    {
      name: '归档正文与冻结哈希不符',
      prepare: (_root, destination) => {
        mkdirSync(join(destination, 'docs', 'specs', 'pending'), { recursive: true });
        writeFileSync(join(destination, PANEL_SPEC_PATH), PANEL_DOC_R2, 'utf8');
      },
      expected: /冻结身份不一致/,
    },
    {
      name: '规格文件是指向归档外的符号链接',
      prepare: (_root, destination, outside) => {
        mkdirSync(join(destination, 'docs', 'specs', 'pending'), { recursive: true });
        symlinkSync(outside, join(destination, PANEL_SPEC_PATH));
      },
      expected: /包含符号链接/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-build-reject-'));
      try {
        const binding = panelBinding();
        const config = buildConfig(root, binding);
        const outside = join(root, 'outside-panel.md');
        writeFileSync(outside, PANEL_DOC, 'utf8');
        const git = {
          revParse: async () => TREE_SHA,
          archive: async (_cwd: string, _sha: string, destination: string) => {
            mkdirSync(destination, { recursive: true });
            item.prepare(root, destination, outside);
          },
        } as unknown as GitClient;
        let runnerCalls = 0;
        let gateCalls = 0;
        const build = createBuild(
          config,
          git,
          async () => {
            runnerCalls += 1;
            return { code: 0, stdout: 'ok', stderr: '' };
          },
          async () => {
            gateCalls += 1;
            return successfulGateResult();
          },
        );
        const profile = deliveryProfile(PANEL_REQ_ID, binding)!;
        const result = await build(MERGE_SHA, panelContext(profile));

        assert.equal(result.ok, false);
        assert.match(result.detail, item.expected);
        assert.equal(runnerCalls, 0);
        assert.equal(gateCalls, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('合并构建缺少实际 merge tree 元数据时 fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-build-tree-'));
  try {
    const binding = panelBinding();
    const config = buildConfig(root, binding);
    let archiveCalls = 0;
    let runnerCalls = 0;
    const git = {
      revParse: async () => 'not-a-tree',
      archive: async () => {
        archiveCalls += 1;
      },
    } as unknown as GitClient;
    const build = createBuild(
      config,
      git,
      async () => {
        runnerCalls += 1;
        return { code: 0, stdout: 'ok', stderr: '' };
      },
      async () => successfulGateResult(),
    );
    const result = await build(
      MERGE_SHA,
      panelContext(deliveryProfile(PANEL_REQ_ID, binding)!),
    );

    assert.equal(result.ok, false);
    assert.match(result.detail, /tree SHA 无效/);
    assert.equal(archiveCalls, 0);
    assert.equal(runnerCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未绑定、错 Issue、错仓库 ID、未发布或失效 revision 在构建前拒绝部署', async (t) => {
  const cases: Array<{
    name: string;
    state: OrchestratorState;
    pr: ManagedPR;
    binding?: PanelBinding;
  }> = [
    {
      name: '未启用面板绑定',
      state: panelState(),
      pr: panelPR(1),
      binding: undefined,
    },
    {
      name: '绑定 Issue 不一致',
      state: panelState(),
      pr: panelPR(1),
      binding: panelBinding({ issueNumber: ISSUE + 1 }),
    },
    {
      name: '冻结仓库数字 ID 不一致',
      state: panelState(),
      pr: panelPR(1),
      binding: panelBinding({ repositoryId: 'github-repository-id:9999' }),
    },
    {
      name: '当前 r2 尚未完成可信发布',
      state: panelState({
        revisionNumber: 2,
        includeAnchor: true,
        published: false,
      }),
      pr: panelPR(2),
      binding: panelBinding(),
    },
    {
      name: '最新 r2 不接受同 hash 的 r1 Job',
      state: {
        ...panelState({
          revisionNumber: 2,
          includeAnchor: true,
        }),
        jobs: {
          'panel-job-r1': panelJob(1),
        },
      },
      pr: panelPR(1),
      binding: panelBinding(),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = createStore(item.state);
      try {
        const remote = new PanelRemote();
        const deploy = deployFixture({
          store: fixture.store,
          runDir: fixture.runDir,
          prs: [item.pr],
          remote,
          ...(item.binding ? { panelBinding: item.binding } : {}),
        });
        const result = await deployOnce(deploy.ctx);

        assert.equal(result.status, 'nothing');
        assert.deepEqual(deploy.calls.builds, []);
        assert.deepEqual(deploy.calls.health, []);
        assert.deepEqual(deploy.calls.switches, []);
        assert.deepEqual(remote.ensureCalls, []);
        assert.equal(
          Object.values(fixture.store.snapshot().jobs).some((job) => job.status === 'done'),
          false,
        );
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });
  }
});

test('面板健康通过后才切换独立活动指针，并生成同版本真实回执', async () => {
  const initial = panelState();
  initial.deploy.activeSha = COUNTER_ACTIVE_SHA;
  initial.deploy.releaseDir = join('/tmp/fake-run', 'releases', COUNTER_ACTIVE_SHA);
  const fixture = createStore(initial);
  try {
    const binding = panelBinding();
    writePanelActivePointer(fixture.runDir, panelPointer());
    const remote = new PanelRemote();
    let stateAtEnsure: OrchestratorState | undefined;
    remote.onEnsure = () => {
      stateAtEnsure = fixture.store.snapshot();
    };
    const deploy = deployFixture({
      store: fixture.store,
      runDir: fixture.runDir,
      prs: [panelPR(1)],
      remote,
      panelBinding: binding,
    });

    const result = await deployOnce(deploy.ctx);

    assert.equal(result.status, 'deployed');
    assert.deepEqual(deploy.calls.builds.map((call) => call.sha), [MERGE_SHA]);
    assert.equal(deploy.calls.builds[0]?.context?.profile.project, 'panel');
    assert.equal(deploy.calls.builds[0]?.context?.profile.buildScript, 'build:panel');
    assert.deepEqual(deploy.calls.health, [{
      sha: MERGE_SHA,
      releaseDir: panelReleaseDir(fixture.runDir, MERGE_SHA),
    }]);
    assert.deepEqual(deploy.calls.switches, [{
      sha: MERGE_SHA,
      releaseDir: panelReleaseDir(fixture.runDir, MERGE_SHA),
    }]);

    const pointer = readPanelActivePointer(fixture.runDir);
    assert.equal(pointer?.activeSha, MERGE_SHA);
    assert.equal(pointer?.jobId, 'panel-job-r1');
    assert.equal(pointer?.dispatchRevision, 1);
    assert.equal(fixture.store.snapshot().deploy.activeSha, COUNTER_ACTIVE_SHA);
    assert.equal(fixture.store.snapshot().deploy.releaseDir, initial.deploy.releaseDir);

    const job = fixture.store.snapshot().jobs['panel-job-r1'];
    assert.equal(job?.status, 'done');
    assert.equal(job?.resumeAction, undefined);
    assert.deepEqual(job?.deployReceipt, {
      issueNumber: ISSUE,
      prNumber: PR,
      dispatchRevision: 1,
      mergeSha: MERGE_SHA,
      commentId: 900,
      recordedAt: RECEIPT_AT,
    });
    assert.equal(remote.comments.length, 1);
    assert.match(remote.comments[0]?.body ?? '', /健康检查：通过/);
    assert.equal(stateAtEnsure?.jobs['panel-job-r1']?.status, 'done');
    assert.equal(
      stateAtEnsure?.jobs['panel-job-r1']?.resumeAction,
      'sync-deploy-receipt',
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('面板健康检查失败时保留旧活动指针，不写 done、回执或成功通知', async () => {
  const fixture = createStore(panelState());
  try {
    const binding = panelBinding();
    writePanelActivePointer(fixture.runDir, panelPointer());
    const remote = new PanelRemote();
    const deploy = deployFixture({
      store: fixture.store,
      runDir: fixture.runDir,
      prs: [panelPR(1)],
      remote,
      panelBinding: binding,
      healthOk: false,
    });

    const result = await deployOnce(deploy.ctx);

    assert.equal(result.status, 'failed');
    assert.deepEqual(deploy.calls.switches, []);
    assert.equal(readPanelActivePointer(fixture.runDir)?.activeSha, OLD_PANEL_SHA);
    const job = fixture.store.snapshot().jobs['panel-job-r1'];
    assert.equal(job?.status, 'failed');
    assert.equal(job?.failureStage, 'deploy');
    assert.equal(job?.deployReceipt, undefined);
    assert.deepEqual(remote.ensureCalls, []);
    assert.deepEqual(deploy.calls.notifications, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('回执创建成功但响应丢失时，重启后同一 Job 补回执且不重复评论', async () => {
  const fixture = createStore(panelState());
  try {
    const binding = panelBinding();
    const remote = new PanelRemote();
    remote.ensureMode = 'lose-response';
    const firstDeploy = deployFixture({
      store: fixture.store,
      runDir: fixture.runDir,
      prs: [panelPR(1)],
      remote,
      panelBinding: binding,
    });

    const first = await deployMergedPR(firstDeploy.ctx, panelPR(1), ISSUE);

    assert.equal(first.status, 'deployed');
    assert.equal(remote.comments.length, 1, '远端评论已经创建');
    const pending = fixture.store.snapshot().jobs['panel-job-r1'];
    assert.equal(pending?.status, 'done');
    assert.equal(pending?.resumeAction, 'sync-deploy-receipt');
    assert.equal(pending?.deployReceipt, undefined);

    // 模拟控制器重启：只从落盘状态恢复，不保留上一轮内存 Job。
    const reloaded = new StateStore(fixture.file);
    reloaded.load();
    const restarted = deployFixture({
      store: reloaded,
      runDir: fixture.runDir,
      prs: [panelPR(1)],
      remote,
      panelBinding: binding,
    });
    const second = await deployOnce(restarted.ctx);

    assert.equal(second.status, 'nothing');
    assert.equal(remote.comments.length, 1);
    assert.ok(remote.ensureCalls.length >= 2);
    const completed = reloaded.snapshot().jobs['panel-job-r1'];
    assert.equal(completed?.resumeAction, undefined);
    assert.equal(completed?.deployReceipt?.commentId, 900);
    assert.equal(completed?.deployReceipt?.mergeSha, MERGE_SHA);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('同 PR/SHA 的其他 Job 不会收到本版回执，其伪 pending 标记会被清除', async () => {
  const fixture = createStore(panelState());
  try {
    const binding = panelBinding();
    const remote = new PanelRemote();
    remote.ensureMode = 'fail-before-create';
    const firstDeploy = deployFixture({
      store: fixture.store,
      runDir: fixture.runDir,
      prs: [panelPR(1)],
      remote,
      panelBinding: binding,
    });
    const first = await deployMergedPR(firstDeploy.ctx, panelPR(1), ISSUE);
    assert.equal(first.status, 'deployed');
    assert.equal(
      fixture.store.snapshot().jobs['panel-job-r1']?.resumeAction,
      'sync-deploy-receipt',
    );

    await fixture.store.update((state) => {
      state.jobs.decoy = {
        ...panelJob(1, {
          jobId: 'decoy',
          specHash: PANEL_HASH_R2,
          status: 'done',
          resumeAction: 'sync-deploy-receipt',
        }),
      };
      return undefined;
    });
    remote.ensureMode = 'success';
    const restarted = deployFixture({
      store: fixture.store,
      runDir: fixture.runDir,
      prs: [panelPR(1)],
      remote,
      panelBinding: binding,
    });

    await deployOnce(restarted.ctx);

    const state = fixture.store.snapshot();
    assert.equal(state.jobs['panel-job-r1']?.deployReceipt?.commentId, 900);
    assert.equal(state.jobs['panel-job-r1']?.resumeAction, undefined);
    assert.equal(state.jobs.decoy?.deployReceipt, undefined);
    assert.equal(state.jobs.decoy?.resumeAction, undefined);
    assert.equal(remote.comments.length, 1);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('confirmedMainSha/specHash 只作为首次接续锚点，不同 mainSHA 的 r2 可部署和显式重试', async () => {
  const binding = panelBinding();
  const initial = panelState({
    revisionNumber: 2,
    includeAnchor: true,
    specHash: PANEL_HASH_R2,
    sourceMainSha: SOURCE_R2,
  });
  const state = initial;
  const pr = panelPR(2, {
    specHash: PANEL_HASH_R2,
    sourceMainSha: SOURCE_R2,
  });

  const directFixture = createStore(state);
  try {
    const remote = new PanelRemote();
    const deploy = deployFixture({
      store: directFixture.store,
      runDir: directFixture.runDir,
      prs: [pr],
      remote,
      panelBinding: binding,
    });
    const result = await deployOnce(deploy.ctx);

    assert.equal(result.status, 'deployed');
    const context = deploy.calls.builds[0]?.context;
    assert.equal(context?.dispatchRevision, 2);
    assert.equal(context?.sourceMainSha, SOURCE_R2);
    assert.equal(context?.specHash, PANEL_HASH_R2);
    assert.notEqual(binding.confirmedMainSha, context?.sourceMainSha);
    assert.notEqual(binding.specHash, context?.specHash);
    const pointer = readPanelActivePointer(directFixture.runDir);
    assert.equal(pointer?.dispatchRevision, 2);
    assert.equal(pointer?.sourceMainSha, SOURCE_R2);
    assert.equal(pointer?.specHash, PANEL_HASH_R2);
    assert.equal(
      directFixture.store.snapshot().jobs['panel-job-r2']?.deployReceipt?.dispatchRevision,
      2,
    );
  } finally {
    rmSync(directFixture.dir, { recursive: true, force: true });
  }

  const retryFixture = createStore(state);
  try {
    const remote = new PanelRemote();
    const deploy = deployFixture({
      store: retryFixture.store,
      runDir: retryFixture.runDir,
      prs: [pr],
      remote,
      panelBinding: binding,
    });
    const result = await retryDeployForIssue(deploy.ctx, ISSUE, PR);

    assert.equal(result.status, 'deployed');
    assert.deepEqual(deploy.calls.builds.map((call) => call.sha), [MERGE_SHA]);
    assert.equal(deploy.calls.builds[0]?.context?.dispatchRevision, 2);
    assert.equal(readPanelActivePointer(retryFixture.runDir)?.activeSha, MERGE_SHA);
  } finally {
    rmSync(retryFixture.dir, { recursive: true, force: true });
  }
});

test('面板只读资源路由只服务活动版本的安全 index 与 assets 文件', () => {
  assert.equal(
    resolvePanelReleaseAsset(
      `/releases/${MERGE_SHA}/assets/app.js`,
      MERGE_SHA,
    )?.file,
    join('assets', 'app.js'),
  );
  assert.equal(
    resolvePanelReleaseAsset(`/releases/${MERGE_SHA}/`, MERGE_SHA)?.file,
    'index.html',
  );
  assert.equal(
    resolvePanelReleaseAsset(`/releases/${OLD_PANEL_SHA}/assets/app.js`, MERGE_SHA),
    null,
  );
  assert.equal(
    resolvePanelReleaseAsset(`/releases/${MERGE_SHA}/assets/../secret.txt`, MERGE_SHA),
    null,
  );
  assert.equal(
    resolvePanelReleaseAsset(`/releases/${MERGE_SHA}/assets/app.css`, MERGE_SHA)?.file,
    join('assets', 'app.css'),
    '只接受白名单 JS/CSS 文件',
  );
});

test('面板状态文件两种布局都映射到同一控制器 runDir', () => {
  assert.equal(
    panelRunDirForStateFile('/tmp/spec-loop/.orchestrator-state.json'),
    '/tmp/spec-loop/.orchestrator',
  );
  assert.equal(
    panelRunDirForStateFile('/tmp/spec-loop/.orchestrator/state.json'),
    '/tmp/spec-loop/.orchestrator',
  );
});

async function localListenAllowed(): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

test('真实面板 HTTP 只从活动发布目录服务 /releases/<sha>/assets 并阻止逃逸', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实 HTTP 集成测试仅在 SPEC_LOOP_VERIFY=1 主验收执行');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM）');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-server-'));
  const releaseRoot = join(root, 'panel-releases');
  const activeRelease = join(releaseRoot, MERGE_SHA);
  const otherRelease = join(releaseRoot, OLD_PANEL_SHA);
  mkdirSync(join(activeRelease, 'assets'), { recursive: true });
  mkdirSync(join(otherRelease, 'assets'), { recursive: true });
  writeFileSync(join(activeRelease, 'index.html'), '<main>active</main>', 'utf8');
  writeFileSync(join(activeRelease, 'assets', 'app.js'), 'export const active = true;', 'utf8');
  writeFileSync(join(otherRelease, 'index.html'), '<main>other</main>', 'utf8');
  writeFileSync(join(otherRelease, 'assets', 'app.js'), 'export const other = true;', 'utf8');
  const outside = join(root, 'outside.js');
  writeFileSync(outside, 'secret', 'utf8');
  symlinkSync(outside, join(activeRelease, 'assets', 'escape.js'));

  const server = createPanelServer({
    readView: async () => null as never,
    assetsDir: join(root, 'legacy-dist'),
    panelReleaseRootDir: releaseRoot,
    readActivePanelSha: () => MERGE_SHA,
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const request = async (pathname: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(origin + pathname, { redirect: 'manual' });
    return { status: response.status, body: await response.text() };
  };

  try {
    const activeAsset = await request(`/releases/${MERGE_SHA}/assets/app.js`);
    assert.equal(activeAsset.status, 200);
    assert.match(activeAsset.body, /active = true/);
    assert.equal((await request(`/releases/${MERGE_SHA}/`)).status, 200);
    assert.equal((await request(`/releases/${OLD_PANEL_SHA}/assets/app.js`)).status, 404);
    assert.equal((await request(`/releases/${MERGE_SHA}/assets/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await request(`/releases/${MERGE_SHA}/assets/escape.js`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
