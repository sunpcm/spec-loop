import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
  type PanelBinding,
} from '../orchestrator/delivery-profile.ts';
import type { FeishuActorContext } from '../orchestrator/feishu-contract.ts';
import { GitClient } from '../orchestrator/git.ts';
import {
  encodeMetaBlock,
  GithubClient,
  type GhRunner,
} from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { MergeService } from '../orchestrator/merge.ts';
import {
  prepareRetryBaseline,
  resumeRetryBaselines,
  type RetryBaselineDeps,
} from '../orchestrator/retry-baseline.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { StateStore } from '../orchestrator/state.ts';
import {
  emptyState,
  type DispatchRevision,
  type MergeRequestStage,
  type OrchestratorState,
  type Spec,
} from '../orchestrator/types.ts';
import { buildWorkerBranchName } from '../orchestrator/worker.ts';

const execFileAsync = promisify(execFile);
const REPO = 'owner/repo';
const REPO_ID = '9001';
const ISSUE_NUMBER = 18;
const PR_NUMBER = 42;
const MERGE_SHA = 'c'.repeat(40);
const FIXED_CODE = 'a1b2c3d4';
const PANEL_CASE_IDS = [
  'PANEL-WAIT-001',
  'PANEL-WAIT-002',
  'PANEL-WAIT-003',
] as const;
const PANEL_ACCEPTANCE_CASES = {
  A1: ['PANEL-WAIT-001'],
  A2: ['PANEL-WAIT-002'],
};
const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const actor: FeishuActorContext = {
  messageId: 'om_panel_preflight',
  actorId: 'ou_panel_owner',
  chatId: 'oc_panel_bound',
  senderType: 'user',
};

interface PanelFixture {
  root: string;
  repoDir: string;
  stateFile: string;
  trustedE2eRoot: string;
  anchorSha: string;
  sourceSha: string;
  sideSha: string;
  oldSpec: Spec;
  sourceSpec: Spec;
  branch: string;
  headSha: string;
  prFilePath: string;
  binding: PanelBinding;
  dispose: () => void;
}

interface FakeGithubState {
  issueState: 'open' | 'closed';
  merged: boolean;
  putCount: number;
  issueReads: number;
  repositoryReads: number;
}

function panelDoc(marker: string): string {
  return [
    `### [${PANEL_REQ_ID}] 只读等待面板`,
    '',
    '#### 功能',
    '',
    `- ${marker}`,
    '- 展示当前等待原因和下一步',
    '',
    '#### 验收',
    '',
    '- 面板能够展示当前冻结版本',
    '- 面板能够展示下一步操作',
    '',
  ].join('\n');
}

function specOf(text: string): Spec {
  const parsed = parseSpecs({ [PANEL_SPEC_PATH]: text });
  assert.equal(parsed.errors.length, 0);
  const spec = parsed.specs.find((candidate) => candidate.id === PANEL_REQ_ID);
  assert.ok(spec);
  return spec;
}

function panelContract(
  spec: Spec,
  acceptanceCases?: Record<string, string[]> | null,
): Record<string, unknown> {
  return {
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash: spec.hash,
    caseIds: [...PANEL_CASE_IDS],
    ...(acceptanceCases === null
      ? {}
      : { acceptanceCases: structuredClone(acceptanceCases ?? PANEL_ACCEPTANCE_CASES) }),
  };
}

function writePanelContract(
  trustedE2eRoot: string,
  spec: Spec,
  acceptanceCases?: Record<string, string[]> | null,
): void {
  writeFileSync(
    join(trustedE2eRoot, 'tests', 'e2e', 'contracts', 'panel.json'),
    JSON.stringify(panelContract(spec, acceptanceCases)),
  );
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

function dispatchRevision(
  fx: Pick<PanelFixture, 'oldSpec' | 'sourceSpec' | 'anchorSha' | 'sourceSha' | 'sideSha'>,
  revision: number,
  sourceMainSha: string,
  spec: Spec,
): DispatchRevision {
  return {
    reqId: PANEL_REQ_ID,
    repoId: `github-repository-id:${REPO_ID}`,
    revision,
    issueNumber: ISSUE_NUMBER,
    specHash: spec.hash,
    specPath: PANEL_SPEC_PATH,
    sourceMainSha,
    task: {
      goal: '实现只读等待面板',
      steps: [{ text: '按规格实现面板等待状态', acceptanceRefs: ['A1', 'A2'] }],
      acceptance: {
        A1: '面板能够展示当前冻结版本',
        A2: '面板能够展示下一步操作',
      },
      allowedPaths: ['panel/src/**'],
      dependsOn: [],
    },
    publishedAt: '2026-11-22T00:00:00.000Z',
    publicationCommentId: 7000 + revision,
  };
}

function panelState(
  fx: PanelFixture,
  options: {
    revision?: number;
    jobRevision?: number;
    requirementSourceSha?: string;
    jobSourceSha?: string;
    currentGrant?: boolean;
    oldGrantOnly?: boolean;
    jobStatus?: 'failed' | 'in-review';
    linkedPr?: boolean;
  } = {},
): OrchestratorState {
  const revision = options.revision ?? 2;
  const currentRevision = dispatchRevision(fx, revision, fx.sourceSha, fx.sourceSpec);
  if (options.currentGrant !== false) {
    currentRevision.grant = {
      eventId: 8102,
      actorId: '4242',
      grantedAt: '2026-11-22T00:01:00.000Z',
    };
  }
  const anchorRevision = dispatchRevision(fx, 1, fx.anchorSha, fx.oldSpec);
  if (options.oldGrantOnly) {
    anchorRevision.grant = {
      eventId: 8101,
      actorId: '4242',
      grantedAt: '2026-11-21T00:01:00.000Z',
    };
  }
  return {
    ...emptyState(),
    repo: REPO,
    cursorMainSha: options.requirementSourceSha ?? fx.sourceSha,
    requirements: {
      [PANEL_REQ_ID]: {
        issueNumber: ISSUE_NUMBER,
        specHash: fx.sourceSpec.hash,
        specPath: PANEL_SPEC_PATH,
        sourceMainSha: options.requirementSourceSha ?? fx.sourceSha,
      },
    },
    jobs: {
      oldPanelJob: {
        jobId: 'oldPanelJob',
        reqId: PANEL_REQ_ID,
        issueNumber: ISSUE_NUMBER,
        specHash: fx.sourceSpec.hash,
        sourceMainSha: options.jobSourceSha ?? fx.sourceSha,
        attempt: 1,
        status: options.jobStatus ?? 'failed',
        failureStage: 'verify',
        resumeAction: 'worker',
        ...(options.linkedPr ? { prNumber: PR_NUMBER } : {}),
        headSHA: fx.headSha,
        dispatchRevision: options.jobRevision ?? revision,
        startedAt: '2026-11-22T00:02:00.000Z',
        updatedAt: '2026-11-22T00:03:00.000Z',
      },
    },
    dispatchRevisions: {
      [PANEL_REQ_ID]: [anchorRevision, currentRevision],
    },
  };
}

async function createPanelFixture(prFilePath = 'panel/src/wait.ts'): Promise<PanelFixture> {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-retry-merge-'));
  const repoDir = join(root, 'repo');
  const remoteDir = join(root, 'remote.git');
  const trustedE2eRoot = join(root, 'trusted-controller');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(remoteDir, { recursive: true });
  await git(root, ['init', '-q', '--bare', '--initial-branch=main', remoteDir]);
  await git(root, ['init', '-q', '--initial-branch=main', repoDir]);
  await git(repoDir, ['remote', 'add', 'origin', remoteDir]);

  const oldText = panelDoc('r1 只展示基础等待状态');
  mkdirSync(dirname(join(repoDir, PANEL_SPEC_PATH)), { recursive: true });
  mkdirSync(join(repoDir, 'panel', 'src'), { recursive: true });
  writeFileSync(join(repoDir, PANEL_SPEC_PATH), oldText);
  writeFileSync(
    join(repoDir, 'panel', 'src', 'App.tsx'),
    'export const panelFixture = "r1";\n',
  );
  await git(repoDir, ['add', '.']);
  await git(repoDir, ['commit', '-qm', 'panel anchor']);
  const anchorSha = await git(repoDir, ['rev-parse', 'HEAD']);
  await git(repoDir, ['push', '-q', '-u', 'origin', 'main']);

  const sourceText = panelDoc('r2 展示当前冻结版本的等待原因');
  writeFileSync(join(repoDir, PANEL_SPEC_PATH), sourceText);
  await git(repoDir, ['add', PANEL_SPEC_PATH]);
  await git(repoDir, ['commit', '-qm', 'panel r2 spec']);
  const sourceSha = await git(repoDir, ['rev-parse', 'HEAD']);
  await git(repoDir, ['push', '-q', 'origin', 'main']);

  await git(repoDir, ['checkout', '-q', '-b', 'side-source', sourceSha]);
  writeFileSync(join(repoDir, 'side.txt'), 'not on main\n');
  await git(repoDir, ['add', 'side.txt']);
  await git(repoDir, ['commit', '-qm', 'side source']);
  const sideSha = await git(repoDir, ['rev-parse', 'HEAD']);
  await git(repoDir, ['checkout', '-q', 'main']);

  const oldSpec = specOf(oldText);
  const sourceSpec = specOf(sourceText);
  const branch = buildWorkerBranchName(
    PANEL_REQ_ID,
    ISSUE_NUMBER,
    sourceSpec.hash,
    sourceSha,
    1,
    2,
  );
  await git(repoDir, ['checkout', '-q', '-b', branch, sourceSha]);
  mkdirSync(dirname(join(repoDir, prFilePath)), { recursive: true });
  writeFileSync(join(repoDir, prFilePath), 'export const panelWait = "r2";\n');
  await git(repoDir, ['add', prFilePath]);
  await git(repoDir, ['commit', '-qm', 'panel candidate']);
  const headSha = await git(repoDir, ['rev-parse', 'HEAD']);
  await git(repoDir, ['checkout', '-q', 'main']);

  mkdirSync(join(trustedE2eRoot, 'tests', 'e2e', 'contracts'), { recursive: true });
  writePanelContract(trustedE2eRoot, sourceSpec);
  return {
    root,
    repoDir,
    stateFile: join(root, 'state.json'),
    trustedE2eRoot,
    anchorSha,
    sourceSha,
    sideSha,
    oldSpec,
    sourceSpec,
    branch,
    headSha,
    prFilePath,
    binding: {
      repo: REPO,
      mainBranch: 'main',
      repositoryId: `github-repository-id:${REPO_ID}`,
      issueNumber: ISSUE_NUMBER,
      confirmedMainSha: anchorSha,
      specHash: oldSpec.hash,
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function issueBody(fx: PanelFixture, revision = 2): string {
  const meta = {
    schema: 1,
    system: 'spec-loop',
    kind: 'requirement',
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash: fx.sourceSpec.hash,
    sourceMainSha: fx.sourceSha,
    operationKey: `${fx.sourceSpec.hash}:${fx.sourceSha}:r${revision}`,
  };
  return `面板 r${revision} 待排期\n\n${encodeMetaBlock(meta)}`;
}

function retryGithub(fx: PanelFixture, calls: string[]): GithubClient {
  const runner: GhRunner = async (args) => {
    const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
    calls.push(path);
    if (path === `repos/${REPO}`) {
      return { stdout: JSON.stringify({ id: Number(REPO_ID) }), stderr: '', code: 0 };
    }
    if (path === `repos/${REPO}/issues?state=all&per_page=100`) {
      return {
        stdout: JSON.stringify([[
          {
            number: ISSUE_NUMBER,
            title: `[${PANEL_REQ_ID}] 只读等待面板`,
            body: issueBody(fx),
            state: 'open',
            labels: [],
            html_url: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
          },
        ]]),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/pulls?state=all&per_page=100`) {
      return { stdout: JSON.stringify([[]]), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: `unexpected retry path: ${path}`, code: 1 };
  };
  return new GithubClient(REPO, runner);
}

function retryDeps(
  fx: PanelFixture,
  state: StateStore,
  github: GithubClient,
  binding?: PanelBinding,
): RetryBaselineDeps {
  return {
    repoDir: fx.repoDir,
    state,
    git: new GitClient(undefined, binding),
    github,
    logger,
    retryDeploy: async () => ({ status: 'nothing' }),
    trustedE2eRoot: fx.trustedE2eRoot,
    mainBranch: 'main',
    ...(binding ? { panelBinding: binding } : {}),
  };
}

interface MergeHarness {
  state: StateStore;
  service: MergeService;
  githubState: FakeGithubState;
  notifications: string[];
}

function mergeHarness(
  fx: PanelFixture,
  options: {
    state?: OrchestratorState;
    binding?: PanelBinding | null;
    trustedE2eRoot?: string;
    githubState?: Partial<FakeGithubState>;
  } = {},
): MergeHarness {
  const state = new StateStore(
    fx.stateFile,
    options.state ?? panelState(fx, { jobStatus: 'in-review', linkedPr: true }),
  );
  const githubState: FakeGithubState = {
    issueState: 'open',
    merged: false,
    putCount: 0,
    issueReads: 0,
    repositoryReads: 0,
    ...options.githubState,
  };
  const prBody = [
    '面板 r2 候选',
    '',
    encodeMetaBlock({
      schema: 1,
      system: 'spec-loop',
      kind: 'code-pr',
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash: fx.sourceSpec.hash,
      sourceMainSha: fx.sourceSha,
      jobId: 'oldPanelJob',
      attempt: 1,
      dispatchRevision: 2,
      operationKey: 'panel-merge-fixture',
    }),
  ].join('\n');
  const runner: GhRunner = async (args) => {
    const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PUT') {
      githubState.putCount += 1;
      githubState.merged = true;
      githubState.issueState = 'closed';
      return {
        stdout: JSON.stringify({ merged: true, sha: MERGE_SHA }),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/pulls/${PR_NUMBER}`) {
      return {
        stdout: JSON.stringify({
          number: PR_NUMBER,
          title: 'panel: r2 等待状态',
          body: prBody,
          state: githubState.merged ? 'closed' : 'open',
          draft: false,
          merged: githubState.merged,
          mergeable: githubState.merged ? null : true,
          mergeable_state: githubState.merged ? 'unknown' : 'clean',
          head: { ref: fx.branch, sha: fx.headSha, repo: { full_name: REPO } },
          base: { ref: 'main', sha: fx.sourceSha, repo: { full_name: REPO } },
          merge_commit_sha: githubState.merged ? MERGE_SHA : undefined,
          html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
          changed_files: 1,
        }),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`) {
      return {
        stdout: JSON.stringify([[{ filename: fx.prFilePath, status: 'added' }]]),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/git/trees/${fx.headSha}?recursive=1`) {
      return {
        stdout: JSON.stringify({
          sha: fx.headSha,
          truncated: false,
          tree: [{
            path: fx.prFilePath,
            mode: '100644',
            type: 'blob',
            sha: `blob-${fx.headSha}`,
          }],
        }),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/commits/${fx.headSha}/check-runs?per_page=100`) {
      return {
        stdout: JSON.stringify([{ total_count: 0, check_runs: [] }]),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/commits/${fx.headSha}/status?per_page=100`) {
      return {
        stdout: JSON.stringify([{
          sha: fx.headSha,
          total_count: 0,
          state: 'success',
          statuses: [],
        }]),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}`) {
      githubState.repositoryReads += 1;
      return { stdout: JSON.stringify({ id: Number(REPO_ID) }), stderr: '', code: 0 };
    }
    if (path === `repos/${REPO}/issues/${ISSUE_NUMBER}`) {
      githubState.issueReads += 1;
      return {
        stdout: JSON.stringify({
          number: ISSUE_NUMBER,
          title: `[${PANEL_REQ_ID}] 只读等待面板`,
          body: issueBody(fx),
          state: githubState.issueState,
          labels: [],
          html_url: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
        }),
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '', stderr: `unexpected merge path: ${path}`, code: 1 };
  };
  const binding = options.binding === null ? undefined : (options.binding ?? fx.binding);
  const gitClient = new GitClient(undefined, binding);
  const service = new MergeService({
    repo: REPO,
    repoDir: fx.repoDir,
    state,
    git: gitClient,
    github: new GithubClient(REPO, runner),
    logger,
    mainBranch: 'main',
    ...(binding ? { panelBinding: binding } : {}),
    trustedE2eRoot: options.trustedE2eRoot ?? fx.trustedE2eRoot,
    now: () => Date.parse('2026-11-22T01:00:00.000Z'),
    confirmationCodeFactory: () => FIXED_CODE,
    notify: async (text) => {
      harness.notifications.push(text);
    },
  });
  const harness: MergeHarness = {
    state,
    service,
    githubState,
    notifications: [],
  };
  return harness;
}

function mergeServices(
  fx: PanelFixture,
  options: {
    state?: OrchestratorState;
    binding?: PanelBinding | null;
    trustedE2eRoot?: string;
    githubState?: Partial<FakeGithubState>;
  } = {},
): MergeHarness {
  return mergeHarness(fx, options);
}

function confirmationCode(message: string): string {
  const match = /确认合并 #\d+ ([0-9a-f]{8})/.exec(message);
  assert.ok(match, message);
  return match[1]!;
}

function codeMergedResult(prNumber = PR_NUMBER): string {
  return `代码 PR #${prNumber} 已合并，仅确认代码。发布结果请查看同版本的健康检查和发布回执。`;
}

function mergeStage(state: StateStore): MergeRequestStage | undefined {
  return Object.values(state.snapshot().mergeRequests ?? {})[0]?.stage;
}

test('面板 r2 显式重试接受初始 r1 锚点后的来源、当前版本与当前授权', async () => {
  const fx = await createPanelFixture();
  try {
    const state = new StateStore(fx.stateFile, panelState(fx));
    const calls: string[] = [];
    const checked = await prepareRetryBaseline(
      retryDeps(fx, state, retryGithub(fx, calls), fx.binding),
      ISSUE_NUMBER,
    );
    assert.ok(
      'oldJob' in checked,
      'message' in checked ? checked.message : '重试预检未返回结果',
    );
    assert.equal(checked.dispatchRevision?.revision, 2);
    assert.equal(checked.dispatchRevision?.sourceMainSha, fx.sourceSha);
    assert.equal(checked.dispatchRevision?.specHash, fx.sourceSpec.hash);
    assert.equal(checked.baseline.targetSourceMainSha, fx.sourceSha);
    assert.equal(checked.newJob.dispatchRevision, 2);
    assert.equal(checked.newJob.attempt, 2);
    assert.equal(checked.dispatchRevision?.task.allowedPaths[0], 'panel/src/**');
    assert.equal(state.snapshot().requirements[PANEL_REQ_ID]?.sourceMainSha, fx.sourceSha);
    assert.deepEqual(state.snapshot().retryBaselines, {});
  } finally {
    fx.dispose();
  }
});

test('面板显式重试拒绝仅 smoke、缺项、多余或错版契约且不调用 Worker', async (t) => {
  const cases: Array<{
    name: string;
    pattern: RegExp;
    acceptanceCases?: Record<string, string[]> | null;
    wrongVersion?: boolean;
  }> = [
    {
      name: '仅 smoke',
      pattern: /缺少 acceptanceCases/,
      acceptanceCases: null,
    },
    {
      name: '缺项',
      pattern: /缺失 \[A2\]/,
      acceptanceCases: { A1: ['PANEL-WAIT-001'] },
    },
    {
      name: '多余',
      pattern: /多余 \[A3\]/,
      acceptanceCases: {
        ...PANEL_ACCEPTANCE_CASES,
        A3: ['PANEL-WAIT-003'],
      },
    },
    {
      name: '错版',
      pattern: /版本不一致/,
      wrongVersion: true,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const fx = await createPanelFixture();
    t.after(() => fx.dispose());
    if (entry.wrongVersion) {
      writeFileSync(
        join(fx.trustedE2eRoot, 'tests', 'e2e', 'contracts', 'panel.json'),
        JSON.stringify({ ...panelContract(fx.sourceSpec), specHash: 'f'.repeat(64) }),
      );
    } else {
      writePanelContract(fx.trustedE2eRoot, fx.sourceSpec, entry.acceptanceCases);
    }

    const state = new StateStore(join(fx.root, 'contract-' + index + '.json'), panelState(fx));
    let workerCalls = 0;
    const base = retryDeps(fx, state, retryGithub(fx, []), fx.binding);
    const deps: RetryBaselineDeps = {
      ...base,
      retryWorker: async () => {
        workerCalls += 1;
        throw new Error('契约不完整时不得调用 Worker');
      },
    };
    const before = structuredClone(state.snapshot());
    const result = await prepareRetryBaseline(deps, ISSUE_NUMBER);
    assert.ok('status' in result, 'entry ' + index + ' 未返回阻断结果');
    assert.equal(result.status, 'blocked', entry.name);
    assert.match(result.message, entry.pattern, entry.name);
    assert.equal(workerCalls, 0, entry.name);
    assert.deepEqual(state.snapshot(), before, entry.name);
  }
});

test('面板重试未绑定、错卡、错路径、错版、旧授权和错来源均无副作用', async (t) => {
  const fx = await createPanelFixture();
  t.after(() => fx.dispose());

  const cases: Array<{
    name: string;
    pattern: RegExp;
    build: () => {
      state: StateStore;
      deps: RetryBaselineDeps;
    };
  }> = [
    {
      name: '未绑定',
      pattern: /未配置面板受信绑定/,
      build: () => {
        const state = new StateStore(join(fx.root, 'unbound.json'), panelState(fx));
        return { state, deps: retryDeps(fx, state, retryGithub(fx, [])) };
      },
    },
    {
      name: '错 Issue',
      pattern: /未决准备|与受信卡|Issue/,
      build: () => {
        const state = new StateStore(join(fx.root, 'wrong-card.json'), panelState(fx));
        return {
          state,
          deps: retryDeps(fx, state, retryGithub(fx, []), {
            ...fx.binding,
            issueNumber: ISSUE_NUMBER + 1,
          }),
        };
      },
    },
    {
      name: '错路径',
      pattern: /本地需求绑定|规格|路径/,
      build: () => {
        const initial = panelState(fx);
        initial.requirements[PANEL_REQ_ID] = {
          ...initial.requirements[PANEL_REQ_ID]!,
          specPath: 'docs/specs/counter.md',
        };
        const state = new StateStore(join(fx.root, 'wrong-path.json'), initial);
        return { state, deps: retryDeps(fx, state, retryGithub(fx, []), fx.binding) };
      },
    },
    {
      name: '错版本',
      pattern: /冻结依据不一致/,
      build: () => {
        const state = new StateStore(
          join(fx.root, 'wrong-version.json'),
          panelState(fx, { jobRevision: 1 }),
        );
        return { state, deps: retryDeps(fx, state, retryGithub(fx, []), fx.binding) };
      },
    },
    {
      name: '当前无授权',
      pattern: /有效开工授权/,
      build: () => {
        const state = new StateStore(
          join(fx.root, 'no-grant.json'),
          panelState(fx, { currentGrant: false }),
        );
        return { state, deps: retryDeps(fx, state, retryGithub(fx, []), fx.binding) };
      },
    },
    {
      name: '仅旧授权',
      pattern: /有效开工授权/,
      build: () => {
        const state = new StateStore(
          join(fx.root, 'old-grant.json'),
          panelState(fx, { currentGrant: false, oldGrantOnly: true }),
        );
        return { state, deps: retryDeps(fx, state, retryGithub(fx, []), fx.binding) };
      },
    },
    {
      name: '错来源',
      pattern: /不是当前 main 的祖先/,
      build: () => {
        const initial = panelState(fx);
        initial.dispatchRevisions![PANEL_REQ_ID]![1]!.sourceMainSha = fx.sideSha;
        const state = new StateStore(join(fx.root, 'wrong-source.json'), initial);
        return { state, deps: retryDeps(fx, state, retryGithub(fx, []), fx.binding) };
      },
    },
  ];

  for (const entry of cases) {
    const { state, deps } = entry.build();
    const before = structuredClone(state.snapshot());
    const result = await prepareRetryBaseline(deps, ISSUE_NUMBER);
    assert.ok(
      'status' in result,
      `${entry.name}: ${'message' in result ? result.message : '重试预检未返回结果'}`,
    );
    assert.equal(result.status, 'blocked', entry.name);
    assert.match(result.message, entry.pattern, entry.name);
    assert.deepEqual(state.snapshot(), before, entry.name);
  }
});

test('面板 prepared 启动恢复只接受当前 r2 授权，不拿旧 r1 授权或旧版来源续跑', async () => {
  const fx = await createPanelFixture();
  try {
    const initial = panelState(fx, { currentGrant: false, oldGrantOnly: true });
    initial.jobs.preparedPanelJob = {
      jobId: 'preparedPanelJob',
      reqId: PANEL_REQ_ID,
      issueNumber: ISSUE_NUMBER,
      specHash: fx.sourceSpec.hash,
      sourceMainSha: fx.sourceSha,
      attempt: 2,
      status: 'failed',
      failureStage: 'retry-baseline',
      resumeAction: 'retry-baseline',
      dispatchRevision: 2,
      startedAt: '2026-11-22T00:04:00.000Z',
      updatedAt: '2026-11-22T00:04:00.000Z',
    };
    initial.retryBaselines = {
      'retry-baseline-aaaaaaaaaaaaaaaaaaaaaaaa': {
        operationId: 'retry-baseline-aaaaaaaaaaaaaaaaaaaaaaaa',
        reqId: PANEL_REQ_ID,
        issueNumber: ISSUE_NUMBER,
        specPath: PANEL_SPEC_PATH,
        specHash: fx.sourceSpec.hash,
        fromJobId: 'oldPanelJob',
        fromSourceMainSha: fx.anchorSha,
        targetSourceMainSha: fx.sourceSha,
        newJobId: 'preparedPanelJob',
        attempt: 2,
        stage: 'prepared',
        createdAt: '2026-11-22T00:04:00.000Z',
        updatedAt: '2026-11-22T00:04:00.000Z',
      },
    };
    const state = new StateStore(fx.stateFile, initial);
    const calls: string[] = [];
    const deps = retryDeps(fx, state, retryGithub(fx, calls), fx.binding);
    const before = structuredClone(state.snapshot());
    await resumeRetryBaselines(deps);
    assert.deepEqual(state.snapshot(), before);
    assert.deepEqual(calls, [], '授权检查失败时不得读取或写远端');
  } finally {
    fx.dispose();
  }
});

test('面板 r2 代码 PR 合并正例只允许 panel/src/**，预检与确认使用同一绑定', async () => {
  const fx = await createPanelFixture();
  try {
    const h = mergeServices(fx);
    const preview = await h.service.preflight(PR_NUMBER, actor);
    assert.match(preview, /合并预检通过/);
    assert.match(preview, /任务版本: r2/);
    assert.equal(mergeStage(h.state), 'confirmable');
    assert.equal(h.githubState.putCount, 0);

    const code = confirmationCode(preview);
    const merged = await h.service.confirm(PR_NUMBER, code, actor);
    assert.equal(merged, codeMergedResult());
    assert.equal(h.githubState.putCount, 1);
    assert.equal(mergeStage(h.state), 'merged');
    assert.equal(h.state.snapshot().jobs.oldPanelJob?.status, 'in-review');
    assert.equal(
      Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.result,
      codeMergedResult(),
    );
    assert.equal(h.notifications.length, 1);
  } finally {
    fx.dispose();
  }
});

test('面板代码 PR 拒绝 src/** 越界写集且不生成确认码或 PUT', async () => {
  const fx = await createPanelFixture('src/escaped.ts');
  try {
    const h = mergeServices(fx);
    const preview = await h.service.preflight(PR_NUMBER, actor);
    assert.match(preview, /拒绝合并/);
    assert.match(preview, /越权或未知文件状态/);
    assert.equal(mergeStage(h.state), undefined);
    assert.equal(h.githubState.putCount, 0);
  } finally {
    fx.dispose();
  }
});

test('面板代码 PR 预检拒绝仅 smoke、缺项、多余或错版契约且不生成确认码', async (t) => {
  const cases: Array<{
    name: string;
    pattern: RegExp;
    acceptanceCases?: Record<string, string[]> | null;
    wrongVersion?: boolean;
  }> = [
    {
      name: '仅 smoke',
      pattern: /缺少 acceptanceCases/,
      acceptanceCases: null,
    },
    {
      name: '缺项',
      pattern: /缺失 \[A2\]/,
      acceptanceCases: { A1: ['PANEL-WAIT-001'] },
    },
    {
      name: '多余',
      pattern: /多余 \[A3\]/,
      acceptanceCases: {
        ...PANEL_ACCEPTANCE_CASES,
        A3: ['PANEL-WAIT-003'],
      },
    },
    {
      name: '错版',
      pattern: /版本不一致/,
      wrongVersion: true,
    },
  ];

  for (const entry of cases) {
    const fx = await createPanelFixture();
    t.after(() => fx.dispose());
    if (entry.wrongVersion) {
      writeFileSync(
        join(fx.trustedE2eRoot, 'tests', 'e2e', 'contracts', 'panel.json'),
        JSON.stringify({ ...panelContract(fx.sourceSpec), specHash: 'f'.repeat(64) }),
      );
    } else {
      writePanelContract(fx.trustedE2eRoot, fx.sourceSpec, entry.acceptanceCases);
    }

    const h = mergeServices(fx);
    const preview = await h.service.preflight(PR_NUMBER, actor);
    assert.match(preview, /拒绝合并/, entry.name);
    assert.match(preview, entry.pattern, entry.name);
    assert.doesNotMatch(preview, /确认合并 #\d+ [0-9a-f]{8}/, entry.name);
    assert.equal(mergeStage(h.state), undefined, entry.name);
    assert.equal(h.githubState.putCount, 0, entry.name);
  }
});

test('面板预检后契约降级再确认会拒绝且不发送 PUT', async () => {
  const fx = await createPanelFixture();
  try {
    const h = mergeServices(fx);
    const preview = await h.service.preflight(PR_NUMBER, actor);
    assert.match(preview, /合并预检通过/);
    const code = confirmationCode(preview);
    assert.equal(mergeStage(h.state), 'confirmable');

    writePanelContract(fx.trustedE2eRoot, fx.sourceSpec, null);
    const rejected = await h.service.confirm(PR_NUMBER, code, actor);
    assert.match(rejected, /拒绝合并/);
    assert.match(rejected, /缺少 acceptanceCases/);
    assert.equal(h.githubState.putCount, 0);
    assert.equal(mergeStage(h.state), 'confirmable');
  } finally {
    fx.dispose();
  }
});

test('面板代码 PR 的错卡、错版本、错锚点哈希、缺失绑定或错受信契约均 fail closed', async (t) => {
  const cases: Array<{
    name: string;
    pattern: RegExp;
    path?: string;
    setup: (fx: PanelFixture) => {
      state: OrchestratorState;
      binding?: PanelBinding | null;
      trustedRoot?: string;
    };
  }> = [
    {
      name: '错卡',
      pattern: /Issue|受信绑定/,
      setup: (fx) => ({
        state: panelState(fx, { jobStatus: 'in-review', linkedPr: true }),
        binding: { ...fx.binding, issueNumber: ISSUE_NUMBER + 1 },
      }),
    },
    {
      name: '错版本',
      pattern: /dispatchRevision|任务版本/,
      setup: (fx) => {
        const state = panelState(fx, {
          jobRevision: 1,
          jobStatus: 'in-review',
          linkedPr: true,
        });
        return { state, binding: fx.binding };
      },
    },
    {
      name: '错锚点哈希',
      pattern: /锚点|哈希/,
      setup: (fx) => ({
        state: panelState(fx, { jobStatus: 'in-review', linkedPr: true }),
        binding: { ...fx.binding, specHash: '0'.repeat(64) },
      }),
    },
    {
      name: '缺失绑定',
      pattern: /缺少合法受信绑定/,
      setup: (fx) => ({
        state: panelState(fx, { jobStatus: 'in-review', linkedPr: true }),
        binding: null,
      }),
    },
    {
      name: '受信契约错版',
      pattern: /受信验收契约|契约/,
      setup: (fx) => {
        const wrongRoot = join(fx.root, 'wrong-trusted');
        mkdirSync(join(wrongRoot, 'tests', 'e2e', 'contracts'), { recursive: true });
        writeFileSync(
          join(wrongRoot, 'tests', 'e2e', 'contracts', 'panel.json'),
          JSON.stringify({ ...panelContract(fx.sourceSpec), specHash: 'f'.repeat(64) }),
        );
        return {
          state: panelState(fx, { jobStatus: 'in-review', linkedPr: true }),
          binding: fx.binding,
          trustedRoot: wrongRoot,
        };
      },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const fx = await createPanelFixture(entry.path);
    t.after(() => fx.dispose());
    const setup = entry.setup(fx);
    const h = mergeHarness(fx, {
      state: setup.state,
      binding: setup.binding,
      trustedE2eRoot: setup.trustedRoot,
    });
    const preview = await h.service.preflight(PR_NUMBER, actor);
    assert.match(preview, /拒绝合并/, `${index}:${entry.name}`);
    assert.match(preview, entry.pattern, `${index}:${entry.name}`);
    assert.equal(mergeStage(h.state), undefined, entry.name);
    assert.equal(h.githubState.putCount, 0, entry.name);
  }
});

test('面板预检后换绑定不能复用确认码，恢复已合并记录也必须复核同一绑定', async () => {
  const fx = await createPanelFixture();
  try {
    const first = mergeServices(fx);
    const preview = await first.service.preflight(PR_NUMBER, actor);
    const code = confirmationCode(preview);
    const changedBinding = {
      ...fx.binding,
      issueNumber: ISSUE_NUMBER + 1,
    };
    const changed = mergeServices(fx, {
      state: first.state.snapshot(),
      binding: changedBinding,
    });
    const rejected = await changed.service.confirm(PR_NUMBER, code, actor);
    assert.match(rejected, /拒绝合并/);
    assert.match(rejected, /Issue|受信绑定/);
    assert.equal(changed.githubState.putCount, 0);
    assert.equal(mergeStage(changed.state), 'confirmable');

    const merged = await first.service.confirm(
      PR_NUMBER,
      confirmationCode(await first.service.preflight(PR_NUMBER, {
        ...actor,
        messageId: 'om_panel_second_preflight',
      })),
      actor,
    );
    assert.equal(merged, codeMergedResult());
    assert.equal(first.githubState.putCount, 1);

    const recovery = mergeServices(fx, {
      state: first.state.snapshot(),
      binding: changedBinding,
      githubState: { merged: true, issueState: 'closed' },
    });
    const replay = await recovery.service.preflight(PR_NUMBER, {
      ...actor,
      messageId: 'om_panel_recovery_preflight',
    });
    assert.match(replay, /拒绝合并/);
    assert.match(replay, /已合并记录无法通过受管绑定复核|Issue|受信绑定/);
    assert.equal(recovery.githubState.putCount, 0);
    assert.equal(mergeStage(recovery.state), 'merged');
  } finally {
    fx.dispose();
  }
});
