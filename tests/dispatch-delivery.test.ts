import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deliveryMatchesCurrentState,
  deployMergedPR,
  deployOnce,
  type DeployDeps,
} from '../orchestrator/deploy.ts';
import type { FeishuActorContext } from '../orchestrator/feishu-contract.ts';
import type { GitClient } from '../orchestrator/git.ts';
import {
  encodeMetaBlock,
  type GhResult,
  type GithubClient,
} from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { MergeService } from '../orchestrator/merge.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { StateStore } from '../orchestrator/state.ts';
import {
  emptyState,
  type DispatchRevision,
  type DispatchTask,
  type JobState,
  type ManagedIssue,
  type ManagedPR,
  type OrchestratorState,
  type RequirementState,
} from '../orchestrator/types.ts';
import {
  appendDispatchRevisionStatus,
  dispatchRevisionStatus,
} from '../orchestrator/status.ts';

const REQ_A = 'REQ-CNT-01';
const REQ_B = 'REQ-CNT-02';
const REPO = 'owner/repo';
const REPO_ID = '9001';
const ISSUE = 2;
const PR = 8;
const SOURCE_1 = 'a'.repeat(40);
const SOURCE_2 = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const OLD_MERGE = 'e'.repeat(40);
const SPEC_PATH = 'docs/specs/counter.md';
const COUNTER_DOC = `### [REQ-CNT-01] 计数器

#### 功能
- 加倍并保留步长。

#### 验收
- 当前值从 3 翻倍得到 6。
`;
const SPEC_HASH = parseSpecs({ [SPEC_PATH]: COUNTER_DOC }).specs[0]!.hash;
const HASH_OLD = '1'.repeat(64);
const HASH_NEW = '2'.repeat(64);

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const TASK: DispatchTask = {
  goal: '实现计数器翻倍并保留步长',
  steps: [{ text: '实现翻倍操作', acceptanceRefs: ['A1'] }],
  acceptance: { A1: '当前值为 3 时翻倍显示 6。' },
  allowedPaths: ['src/**'],
  dependsOn: [],
};

interface StoreFixture {
  dir: string;
  file: string;
  store: StateStore;
}

interface DeployCalls {
  builds: string[];
  healthChecks: string[];
  switches: Array<{ sha: string; releaseDir: string }>;
  reopened: number[];
  closed: number[];
  removedLabels: Array<{ issue: number; labels: string[] }>;
  addedLabels: Array<{ issue: number; labels: string[] }>;
  comments: string[];
  notifications: string[];
  apiCalls: string[][];
}

interface DeployOptions {
  build?: (sha: string) => Promise<{ ok: boolean; detail: string }>;
  healthCheck?: (sha: string) => Promise<boolean>;
  switchPreview?: (sha: string, releaseDir: string) => Promise<void>;
  issues?: ManagedIssue[] | (() => Promise<ManagedIssue[]>);
  comments?: string[];
  runApi?: (args: string[]) => Promise<GhResult>;
}

function requirement(
  specHash = SPEC_HASH,
  sourceMainSha = SOURCE_1,
  issueNumber = ISSUE,
): RequirementState {
  return { issueNumber, specHash, specPath: SPEC_PATH, sourceMainSha };
}

function revision(
  number: number,
  options: Partial<DispatchRevision> = {},
): DispatchRevision {
  return {
    reqId: REQ_A,
    repoId: REPO_ID,
    revision: number,
    issueNumber: ISSUE,
    specHash: SPEC_HASH,
    specPath: SPEC_PATH,
    sourceMainSha: SOURCE_1,
    task: TASK,
    ...options,
  };
}

function job(
  patch: Partial<JobState> & { jobId: string },
): JobState {
  return {
    reqId: REQ_A,
    issueNumber: ISSUE,
    specHash: SPEC_HASH,
    sourceMainSha: SOURCE_1,
    attempt: 1,
    status: 'in-review',
    prNumber: PR,
    headSHA: HEAD,
    startedAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    ...patch,
  };
}

function codePR(
  dispatchRevision?: number,
  options: {
    number?: number;
    reqId?: string;
    specHash?: string;
    sourceMainSha?: string;
    jobId?: string;
    mergeCommitSha?: string;
  } = {},
): ManagedPR {
  return {
    number: options.number ?? PR,
    title: `PR #${options.number ?? PR}`,
    body: '',
    state: 'closed',
    merged: true,
    mergedAt: '2026-11-21T00:00:00.000Z',
    headRefName: `pi/req-${options.number ?? PR}`,
    headSHA: HEAD,
    baseRefName: 'main',
    mergeCommitSha: options.mergeCommitSha ?? MERGE,
    meta: {
      kind: 'code-pr',
      reqId: options.reqId ?? REQ_A,
      specPath: SPEC_PATH,
      specHash: options.specHash ?? SPEC_HASH,
      sourceMainSha: options.sourceMainSha ?? SOURCE_1,
      jobId: options.jobId ?? 'j1',
      ...(dispatchRevision === undefined ? {} : { dispatchRevision }),
    },
  };
}

function stateWith(patch: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    ...emptyState(),
    repo: REPO,
    cursorMainSha: SOURCE_1,
    requirements: {},
    jobs: {},
    dispatchRevisions: {},
    ...patch,
  };
}

function makeStore(state: OrchestratorState): StoreFixture {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-dispatch-delivery-'));
  const file = join(dir, 'state.json');
  return { dir, file, store: new StateStore(file, state) };
}

function deployFixture(
  store: StateStore,
  prs: ManagedPR[],
  options: DeployOptions = {},
): { ctx: DeployDeps; calls: DeployCalls } {
  const calls: DeployCalls = {
    builds: [],
    healthChecks: [],
    switches: [],
    reopened: [],
    closed: [],
    removedLabels: [],
    addedLabels: [],
    comments: [],
    notifications: [],
    apiCalls: [],
  };
  const issues = options.issues ?? [];
  const ctx: DeployDeps = {
    repoDir: '/tmp/fake-repo',
    runDir: '/tmp/fake-run',
    git: { fetch: async () => {} } as unknown as GitClient,
    github: {
      listPRs: async () => prs,
      listIssues: async () =>
        typeof issues === 'function' ? await issues() : issues,
      listIssueComments: async () =>
        (options.comments ?? []).map((body, index) => ({ id: index + 1, body })),
      reopenIssue: async (issue: number) => {
        calls.reopened.push(issue);
      },
      closeIssue: async (issue: number) => {
        calls.closed.push(issue);
      },
      removeLabels: async (issue: number, labels: string[]) => {
        calls.removedLabels.push({ issue, labels });
      },
      addLabels: async (issue: number, labels: string[]) => {
        calls.addedLabels.push({ issue, labels });
      },
      comment: async (_issue: number, body: string) => {
        calls.comments.push(body);
      },
      runApi: async (args: string[]) => {
        calls.apiCalls.push(args);
        return options.runApi
          ? await options.runApi(args)
          : { stdout: '', stderr: 'unexpected API call', code: 1 };
      },
    } as unknown as GithubClient,
    state: store,
    logger: silentLogger,
    build: async (sha: string) => {
      calls.builds.push(sha);
      return options.build
        ? await options.build(sha)
        : { ok: true, detail: '' };
    },
    healthCheck: async (sha: string) => {
      calls.healthChecks.push(sha);
      return options.healthCheck ? await options.healthCheck(sha) : true;
    },
    switchPreview: async (sha: string, releaseDir: string) => {
      calls.switches.push({ sha, releaseDir });
      await options.switchPreview?.(sha, releaseDir);
    },
    notify: async (text: string) => {
      calls.notifications.push(text);
    },
  };
  return { ctx, calls };
}

async function appendRevision(
  store: StateStore,
  next: DispatchRevision,
): Promise<void> {
  await store.update((state) => {
    state.dispatchRevisions ??= {};
    state.dispatchRevisions[next.reqId] ??= [];
    state.dispatchRevisions[next.reqId]!.push(next);
    return undefined;
  });
}

function closedIssue(labels = ['pi-task', 'status:in-review']): ManagedIssue {
  return {
    number: ISSUE,
    title: 'counter',
    body: '',
    state: 'closed',
    labels,
    meta: null,
    url: '',
  };
}

function openIssue(labels = ['pi-task', 'status:in-review']): ManagedIssue {
  return { ...closedIssue(labels), state: 'open' };
}

function issueEvents(...events: Array<Record<string, unknown>>): GhResult {
  return { stdout: JSON.stringify([events]), stderr: '', code: 0 };
}

function realIssueEvent(options: {
  id: number;
  event: 'closed' | 'reopened';
  commit_id?: string | null;
  created_at?: string;
}): Record<string, unknown> {
  const { id, event, commit_id = null, created_at } = options;
  return {
    id,
    node_id: `MDEyOklzc3VlRXZlbnQ${id}`,
    url: `https://api.github.com/repos/${REPO}/issues/events/${id}`,
    actor: {
      login: 'sunpcm',
      id: 21031067,
      node_id: 'MDQ6VXNlcjIxMDMxMDY3',
      avatar_url: 'https://avatars.githubusercontent.com/u/21031067?v=4',
      gravatar_id: '',
      url: 'https://api.github.com/users/sunpcm',
      html_url: 'https://github.com/sunpcm',
      followers_url: 'https://api.github.com/users/sunpcm/followers',
      following_url: 'https://api.github.com/users/sunpcm/following{/other_user}',
      gists_url: 'https://api.github.com/users/sunpcm/gists{/gist_id}',
      starred_url: 'https://api.github.com/users/sunpcm/starred{/owner}{/repo}',
      subscriptions_url: 'https://api.github.com/users/sunpcm/subscriptions',
      organizations_url: 'https://api.github.com/users/sunpcm/orgs',
      repos_url: 'https://api.github.com/users/sunpcm/repos',
      events_url: 'https://api.github.com/users/sunpcm/events{/privacy}',
      received_events_url: 'https://api.github.com/users/sunpcm/received_events',
      type: 'User',
      user_view_type: 'public',
      site_admin: false,
    },
    event,
    commit_id,
    commit_url: commit_id
      ? `https://api.github.com/repos/${REPO}/commits/${commit_id}`
      : null,
    ...(created_at === undefined ? {} : { created_at }),
    performed_via_github_app: null,
    state_reason: event === 'closed' ? 'completed' : null,
  };
}

test('状态加载严格拒绝缺少 task 的伪造版本记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-dispatch-state-'));
  const file = join(dir, 'state.json');
  const invalid = revision(1) as unknown as Record<string, unknown>;
  delete invalid.task;
  const state = stateWith({
    dispatchRevisions: {
      [REQ_A]: [invalid as unknown as DispatchRevision],
      [REQ_B]: [revision(7, { reqId: REQ_B, issueNumber: 4 })],
    },
  });
  try {
    writeFileSync(file, JSON.stringify(state), 'utf8');
    assert.throws(() => new StateStore(file).load(), /dispatchRevisions 记录畸形/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧交付仅在 PR 与 job 都无版本证据时兼容，冻结版本按末项精确匹配', () => {
  const legacy = stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1' }) },
  });
  assert.equal(deliveryMatchesCurrentState(legacy, codePR()), true);

  assert.equal(
    deliveryMatchesCurrentState(legacy, codePR(1)),
    false,
    '无冻结记录时不能凭版本化 PR 绕过',
  );
  assert.equal(
    deliveryMatchesCurrentState(
      stateWith({
        requirements: { [REQ_A]: requirement() },
        jobs: { j1: job({ jobId: 'j1', dispatchRevision: 1 }) },
      }),
      codePR(),
    ),
    false,
    '无冻结记录时 job 的版本证据也不能反推',
  );
  const unboundPR = codePR();
  delete unboundPR.meta?.jobId;
  assert.equal(
    deliveryMatchesCurrentState(
      stateWith({
        requirements: { [REQ_A]: requirement() },
        jobs: { j1: job({ jobId: 'j1', dispatchRevision: 1 }) },
      }),
      unboundPR,
    ),
    false,
    'PR 省略 jobId 也不能掩盖同交付的版本化 job',
  );

  const current = stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 2 }) },
    dispatchRevisions: { [REQ_A]: [revision(1), revision(2)] },
  });
  assert.equal(deliveryMatchesCurrentState(current, codePR(2)), true);
  assert.equal(deliveryMatchesCurrentState(current, codePR(1)), false);
});

test('旧版本 PR 在构建前被拒绝，不产生部署或回执副作用', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 1 }) },
    dispatchRevisions: { [REQ_A]: [revision(2)] },
  }));
  try {
    const { ctx, calls } = deployFixture(fixture.store, [codePR(1)]);
    const result = await deployOnce(ctx);
    assert.equal(result.status, 'nothing');
    assert.deepEqual(calls.builds, []);
    assert.deepEqual(calls.switches, []);
    assert.deepEqual(calls.comments, []);
    assert.equal(fixture.store.snapshot().jobs.j1?.status, 'in-review');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('无冻结记录但有版本 PR 时部署不能绕过', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 1 }) },
  }));
  try {
    const { ctx, calls } = deployFixture(fixture.store, [codePR(1)]);
    const result = await deployOnce(ctx);
    assert.equal(result.status, 'nothing');
    assert.deepEqual(calls.builds, []);
    assert.deepEqual(calls.comments, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('构建期间改版后不健康检查、不切换、不写 done 或回执', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 2 }) },
    dispatchRevisions: { [REQ_A]: [revision(2)] },
  }));
  try {
    const { ctx, calls } = deployFixture(fixture.store, [codePR(2)], {
      build: async () => {
        await appendRevision(fixture.store, revision(3));
        return { ok: true, detail: '' };
      },
    });
    const result = await deployMergedPR(ctx, codePR(2), ISSUE);
    assert.equal(result.status, 'nothing');
    assert.match(result.error ?? '', /构建期间/);
    assert.deepEqual(calls.healthChecks, []);
    assert.deepEqual(calls.switches, []);
    assert.deepEqual(calls.comments, []);
    assert.equal(fixture.store.snapshot().jobs.j1?.status, 'in-review');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('健康检查期间改版后不切换预览，也不写完成状态', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 2 }) },
    dispatchRevisions: { [REQ_A]: [revision(2)] },
  }));
  try {
    const { ctx, calls } = deployFixture(fixture.store, [codePR(2)], {
      healthCheck: async () => {
        await appendRevision(fixture.store, revision(3));
        return true;
      },
    });
    const result = await deployMergedPR(ctx, codePR(2), ISSUE);
    assert.equal(result.status, 'nothing');
    assert.match(result.error ?? '', /健康检查期间/);
    assert.deepEqual(calls.switches, []);
    assert.deepEqual(calls.comments, []);
    assert.equal(fixture.store.snapshot().jobs.j1?.status, 'in-review');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('预览切换期间改版后恢复旧预览，不写 done 或旧回执', async () => {
  const oldSha = 'f'.repeat(40);
  const initial = stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 2 }) },
    dispatchRevisions: { [REQ_A]: [revision(2)] },
  });
  initial.deploy = {
    activeSha: oldSha,
    releaseDir: '/tmp/fake-run/releases/old',
    deployedPRs: [],
  };
  const fixture = makeStore(initial);
  try {
    let switchCalls = 0;
    const { ctx, calls } = deployFixture(fixture.store, [codePR(2)], {
      switchPreview: async (sha, releaseDir) => {
        switchCalls += 1;
        await fixture.store.update((state) => {
          state.deploy.activeSha = sha;
          state.deploy.releaseDir = releaseDir;
          return undefined;
        });
        if (switchCalls === 1) await appendRevision(fixture.store, revision(3));
      },
    });
    const result = await deployMergedPR(ctx, codePR(2), ISSUE);
    assert.equal(result.status, 'nothing');
    assert.match(result.error ?? '', /切换期间/);
    assert.deepEqual(calls.switches.map((call) => call.sha), [MERGE, oldSha]);
    const state = fixture.store.snapshot();
    assert.equal(state.deploy.activeSha, oldSha);
    assert.deepEqual(state.deploy.deployedPRs, []);
    assert.equal(state.jobs.j1?.status, 'in-review');
    assert.deepEqual(calls.comments, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('本地写 done 后回执前改版会撤销完成标记且不贴标、不关单、不评论', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { j1: job({ jobId: 'j1', dispatchRevision: 2 }) },
    dispatchRevisions: { [REQ_A]: [revision(2)] },
  }));
  try {
    let issueCalls = 0;
    const { ctx, calls } = deployFixture(fixture.store, [codePR(2)], {
      issues: async () => {
        issueCalls += 1;
        if (issueCalls === 1) await appendRevision(fixture.store, revision(3));
        return [openIssue()];
      },
    });
    const result = await deployOnce(ctx);
    assert.equal(result.status, 'nothing');
    const state = fixture.store.snapshot();
    assert.equal(state.deploy.activeSha, null);
    assert.deepEqual(state.deploy.deployedPRs, []);
    assert.equal(state.jobs.j1?.status, 'in-review');
    assert.deepEqual(calls.addedLabels, []);
    assert.deepEqual(calls.closed, []);
    assert.deepEqual(calls.comments, []);
    assert.deepEqual(calls.notifications, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('旧 pending 回执在改版后只清自身恢复动作', async () => {
  const oldJob = job({
    jobId: 'jOld',
    dispatchRevision: 1,
    status: 'done',
    resumeAction: 'sync-deploy-receipt',
    specHash: HASH_OLD,
  });
  const initial = stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: { jOld: oldJob },
    dispatchRevisions: { [REQ_A]: [revision(2)] },
  });
  initial.deploy.activeSha = OLD_MERGE;
  initial.deploy.releaseDir = '/tmp/fake-run/releases/old';
  const fixture = makeStore(initial);
  try {
    const oldPR = codePR(1, {
      specHash: HASH_OLD,
      jobId: 'jOld',
      mergeCommitSha: OLD_MERGE,
    });
    const { ctx, calls } = deployFixture(fixture.store, [oldPR], {
      issues: [openIssue()],
    });
    await deployOnce(ctx);
    assert.equal(fixture.store.snapshot().jobs.jOld?.resumeAction, undefined);
    assert.deepEqual(calls.closed, []);
    assert.deepEqual(calls.addedLabels, []);
    assert.deepEqual(calls.comments, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('旧 PR 的 Closes 自动关单仅在关闭提交精确匹配时恢复', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: {
      jOld: job({
        jobId: 'jOld',
        dispatchRevision: 1,
        specHash: HASH_OLD,
      }),
    },
    dispatchRevisions: {
      [REQ_A]: [
        revision(1, { specHash: HASH_OLD }),
        revision(2, {
          publishedAt: '2026-11-21T08:00:00.000Z',
          publicationCommentId: 700,
        }),
      ],
    },
  }));
  try {
    const oldPR = codePR(1, {
      specHash: HASH_OLD,
      jobId: 'jOld',
      mergeCommitSha: OLD_MERGE,
    });
    const { ctx, calls } = deployFixture(fixture.store, [oldPR], {
      issues: [closedIssue()],
      runApi: async () =>
        issueEvents(
          realIssueEvent({
            id: 10,
            event: 'closed',
            commit_id: OLD_MERGE,
            created_at: '2026-11-21T08:05:00.000Z',
          }),
          realIssueEvent({
            id: 200,
            event: 'reopened',
            created_at: '2026-11-21T08:04:00.000Z',
          }),
        ),
    });
    await deployOnce(ctx);
    assert.deepEqual(calls.reopened, [ISSUE]);
    assert.ok(calls.comments.some((body) => body.includes('旧 PR #8')));
    assert.ok(calls.removedLabels.some((entry) => entry.issue === ISSUE));
    assert.deepEqual(calls.builds, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('最新人工关单、后续 reopen 或不匹配提交都保持 Issue 关闭', async (t) => {
  const cases = [
    {
      name: '最新人工 close 无 commit_id',
      events: [
        realIssueEvent({
          id: 20,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        }),
        realIssueEvent({
          id: 21,
          event: 'closed',
          created_at: '2026-11-21T08:06:00.000Z',
        }),
      ],
    },
    {
      name: '自动关单后已有 reopen',
      events: [
        realIssueEvent({
          id: 20,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        }),
        realIssueEvent({
          id: 21,
          event: 'reopened',
          created_at: '2026-11-21T08:06:00.000Z',
        }),
      ],
    },
    {
      name: '关闭提交不匹配旧 PR',
      events: [realIssueEvent({
        id: 20,
        event: 'closed',
        commit_id: MERGE,
        created_at: '2026-11-21T08:05:00.000Z',
      })],
    },
    {
      name: 'id 较大但时间较早的自动关单不能覆盖之后的人工关单',
      events: [
        realIssueEvent({
          id: 200,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        }),
        realIssueEvent({
          id: 10,
          event: 'closed',
          created_at: '2026-11-21T08:06:00.000Z',
        }),
      ],
    },
    {
      name: '最新状态事件同一时间无法排除人工关单',
      events: [
        realIssueEvent({
          id: 20,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        }),
        realIssueEvent({
          id: 21,
          event: 'reopened',
          created_at: '2026-11-21T08:05:00.000Z',
        }),
      ],
    },
    {
      name: '状态事件缺少 created_at',
      events: [realIssueEvent({ id: 20, event: 'closed', commit_id: OLD_MERGE })],
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = makeStore(stateWith({
        requirements: { [REQ_A]: requirement() },
        jobs: {
          jOld: job({
            jobId: 'jOld',
            dispatchRevision: 1,
            specHash: HASH_OLD,
          }),
        },
        dispatchRevisions: {
          [REQ_A]: [
            revision(1, { specHash: HASH_OLD }),
            revision(2, {
              publishedAt: '2026-11-21T08:00:00.000Z',
              publicationCommentId: 700,
            }),
          ],
        },
      }));
      try {
        const oldPR = codePR(1, {
          specHash: HASH_OLD,
          jobId: 'jOld',
          mergeCommitSha: OLD_MERGE,
        });
        const { ctx, calls } = deployFixture(fixture.store, [oldPR], {
          issues: [closedIssue()],
          runApi: async () => issueEvents(...item.events),
        });
        await deployOnce(ctx);
        assert.deepEqual(calls.reopened, []);
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });
  }
});

test('旧 Closes 恢复只作用于已发布的新计数器版本，普通需求不发生副作用', async () => {
  const fixture = makeStore(stateWith({
    requirements: {
      [REQ_B]: requirement(HASH_OLD, SOURCE_2),
    },
    jobs: {
      other: job({
        jobId: 'other',
        reqId: REQ_B,
        dispatchRevision: 7,
        specHash: HASH_OLD,
        sourceMainSha: SOURCE_2,
      }),
    },
    dispatchRevisions: {
      [REQ_B]: [
        revision(7, {
          reqId: REQ_B,
          specHash: HASH_OLD,
          sourceMainSha: SOURCE_2,
          publishedAt: '2026-11-21T08:00:00.000Z',
          publicationCommentId: 701,
        }),
      ],
    },
  }));
  try {
    const otherPR = codePR(7, {
      reqId: REQ_B,
      specHash: HASH_OLD,
      sourceMainSha: SOURCE_2,
      jobId: 'other',
      mergeCommitSha: OLD_MERGE,
    });
    const { ctx, calls } = deployFixture(fixture.store, [otherPR], {
      issues: [closedIssue()],
      runApi: async () => issueEvents(realIssueEvent({
          id: 20,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        })),
    });
    await deployOnce(ctx);
    assert.deepEqual(calls.apiCalls, []);
    assert.deepEqual(calls.reopened, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('计数器最新冻结版本尚未发布时不读取 Issue 事件', async () => {
  const fixture = makeStore(stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: {
      old: job({
        jobId: 'old',
        dispatchRevision: 1,
        specHash: HASH_OLD,
      }),
    },
    dispatchRevisions: {
      [REQ_A]: [
        revision(1, { specHash: HASH_OLD }),
        revision(2),
      ],
    },
  }));
  try {
    const oldPR = codePR(1, {
      specHash: HASH_OLD,
      jobId: 'old',
      mergeCommitSha: OLD_MERGE,
    });
    const { ctx, calls } = deployFixture(fixture.store, [oldPR], {
      issues: [closedIssue()],
      runApi: async () => issueEvents(realIssueEvent({
          id: 20,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        })),
    });
    await deployOnce(ctx);
    assert.deepEqual(calls.apiCalls, []);
    assert.deepEqual(calls.reopened, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('当前任务已完成部署时，很旧 Closes 记录不会重开 Issue', async () => {
  const initial = stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: {
      current: job({ jobId: 'current', dispatchRevision: 2, status: 'done' }),
      old: job({
        jobId: 'old',
        dispatchRevision: 1,
        specHash: HASH_OLD,
        prNumber: 9,
      }),
    },
    dispatchRevisions: {
      [REQ_A]: [
        revision(1, { specHash: HASH_OLD }),
        revision(2, {
          publishedAt: '2026-11-21T08:00:00.000Z',
          publicationCommentId: 700,
        }),
      ],
    },
  });
  initial.deploy.deployedPRs = [PR];
  initial.deploy.activeSha = MERGE;
  initial.deploy.releaseDir = `/tmp/fake-run/releases/${MERGE}`;
  const fixture = makeStore(initial);
  try {
    const oldPR = codePR(1, {
      number: 9,
      specHash: HASH_OLD,
      jobId: 'old',
      mergeCommitSha: OLD_MERGE,
    });
    const { ctx, calls } = deployFixture(fixture.store, [oldPR], {
      issues: [closedIssue()],
      runApi: async () => issueEvents(realIssueEvent({
          id: 20,
          event: 'closed',
          commit_id: OLD_MERGE,
          created_at: '2026-11-21T08:05:00.000Z',
        })),
    });
    await deployOnce(ctx);
    assert.deepEqual(calls.apiCalls, []);
    assert.deepEqual(calls.reopened, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('status 展示正式结构的最后一个冻结版本，并保留其他 REQ 历史', () => {
  const other = revision(7, {
    reqId: REQ_B,
    issueNumber: 4,
    specHash: HASH_OLD,
    sourceMainSha: SOURCE_2,
  });
  const state = stateWith({
    requirements: {
      [REQ_A]: requirement(),
      [REQ_B]: requirement(HASH_OLD, SOURCE_2, 4),
    },
    dispatchRevisions: {
      [REQ_A]: [
        revision(1),
        revision(3, {
          specHash: HASH_NEW,
          publishedAt: '2026-11-21T08:00:00.000Z',
          publicationCommentId: 700,
        }),
      ],
      [REQ_B]: [other],
    },
  });
  const text = appendDispatchRevisionStatus('基础状态', state);
  assert.match(text, /基础状态/);
  assert.match(text, /REQ-CNT-01: r3/);
  assert.match(text, /REQ-CNT-02: r7/);
  assert.match(text, /Issue #2/);
  assert.match(text, new RegExp(HASH_NEW.slice(0, 8)));
  assert.match(dispatchRevisionStatus(state), /发布 2026-11-21T08:00:00\.000Z/);
});

const actor: FeishuActorContext = {
  messageId: 'om_dispatch_delivery',
  actorId: 'ou_allowed',
  chatId: 'oc_bound',
  senderType: 'user',
};

function mergePullRequest(dispatchRevision: number): Record<string, unknown> {
  return {
    number: PR,
    title: 'counter delivery',
    body: encodeMetaBlock({
      schema: 1,
      system: 'spec-loop',
      kind: 'code-pr',
      reqId: REQ_A,
      specPath: SPEC_PATH,
      specHash: SPEC_HASH,
      sourceMainSha: SOURCE_1,
      jobId: 'j1',
      attempt: 1,
      dispatchRevision,
    }),
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: {
      ref: `pi/req-cnt-01-i2-r${SPEC_HASH.slice(0, 8)}-a1-s${SOURCE_1.slice(0, 8)}-v${dispatchRevision}`,
      sha: HEAD,
      repo: { full_name: REPO },
    },
    base: {
      ref: 'main',
      sha: SOURCE_1,
      repo: { full_name: REPO },
    },
    html_url: `https://github.com/${REPO}/pull/${PR}`,
    changed_files: 1,
  };
}

function mergeFixture(options: {
  latestRevision?: number;
  jobRevision?: number;
  prRevision?: number;
}): {
  dir: string;
  store: StateStore;
  service: MergeService;
  apiCalls: string[][];
} {
  const latestRevision = options.latestRevision;
  const jobRevision = options.jobRevision;
  const prRevision = options.prRevision ?? 1;
  const state = stateWith({
    requirements: { [REQ_A]: requirement() },
    jobs: {
      j1: job({
        jobId: 'j1',
        ...(jobRevision === undefined ? {} : { dispatchRevision: jobRevision }),
      }),
    },
    dispatchRevisions: latestRevision === undefined
      ? {}
      : { [REQ_A]: [revision(latestRevision)] },
  });
  const fixture = makeStore(state);
  const apiCalls: string[][] = [];
  const github = {
    runApi: async (args: string[]): Promise<GhResult> => {
      apiCalls.push(args);
      if (
        args.length === 2
        && args[0] === 'api'
        && args[1] === `repos/${REPO}/pulls/${PR}`
      ) {
        return {
          stdout: JSON.stringify(mergePullRequest(prRevision)),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: 'unexpected API call', code: 1 };
    },
  } as unknown as GithubClient;
  const git = {
    fetch: async () => {},
    revParse: async () => SOURCE_1,
    readSpecSnapshot: async () => ({ [SPEC_PATH]: COUNTER_DOC }),
    raw: async () => '',
  } as unknown as GitClient;
  return {
    dir: fixture.dir,
    store: fixture.store,
    service: new MergeService({
      repo: REPO,
      repoDir: '/tmp/fake-repo',
      state: fixture.store,
      git,
      github,
      logger: silentLogger,
      now: () => Date.parse('2026-11-21T00:00:00.000Z'),
      confirmationCodeFactory: () => 'deadbeef',
    }),
    apiCalls,
  };
}

test('合并预检在冻结版本已更新时拒绝旧 job/PR 版本', async () => {
  const fixture = mergeFixture({
    latestRevision: 2,
    jobRevision: 1,
    prRevision: 1,
  });
  try {
    const result = await fixture.service.preflight(PR, actor);
    assert.match(result, /拒绝合并/);
    assert.match(result, /任务版本/);
    assert.ok(fixture.apiCalls.every((args) => !args.includes('PUT')));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('无冻结记录但 PR/job 带版本时合并预检拒绝，不能用旧兼容路径绕过', async () => {
  const fixture = mergeFixture({
    latestRevision: undefined,
    jobRevision: 1,
    prRevision: 1,
  });
  try {
    const result = await fixture.service.preflight(PR, actor);
    assert.match(result, /拒绝合并/);
    assert.match(result, /缺少对应冻结/);
    assert.ok(fixture.apiCalls.every((args) => !args.includes('PUT')));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('确认前任务版本变化使确认码 invalidated，且绝不发送 PUT', async () => {
  const fixture = mergeFixture({
    latestRevision: 2,
    jobRevision: 1,
    prRevision: 1,
  });
  try {
    await fixture.store.update((state) => {
      state.mergeRequests = {
        pending: {
          requestId: 'pending',
          repo: REPO,
          prNumber: PR,
          prTitle: 'counter delivery',
          prUrl: `https://github.com/${REPO}/pull/${PR}`,
          type: 'code',
          headSHA: HEAD,
          baseSHA: SOURCE_1,
          operatorId: actor.actorId,
          chatId: actor.chatId,
          originalMessageId: actor.messageId,
          preflightMessageIds: [actor.messageId],
          confirmationMessageIds: [],
          confirmationCode: 'deadbeef',
          checksSummary: 'ok',
          localValidation: 'ok',
          stage: 'confirmable',
          createdAt: '2026-11-21T00:00:00.000Z',
          expiresAt: '2026-11-21T00:10:00.000Z',
          updatedAt: '2026-11-21T00:00:00.000Z',
        },
      };
      return undefined;
    });
    const result = await fixture.service.confirm(PR, 'deadbeef', actor);
    assert.match(result, /拒绝合并/);
    assert.match(result, /任务版本/);
    assert.equal(
      fixture.store.snapshot().mergeRequests?.pending?.stage,
      'invalidated',
    );
    assert.ok(fixture.apiCalls.every((args) => !args.includes('PUT')));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
