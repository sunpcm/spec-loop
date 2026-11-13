import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands, type CommandsDeps } from '../orchestrator/commands.ts';
import { deployOnce, retryDeployForIssue, type DeployDeps } from '../orchestrator/deploy.ts';
import type { GitClient } from '../orchestrator/git.ts';
import { defaultGhRunner, GithubClient, type GhResult } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { planReconciliation } from '../orchestrator/reconciler.ts';
import { applyReconciliation, planForMain, type ReconcileContext } from '../orchestrator/scheduler.ts';
import { diffSpecs, parseSpecs } from '../orchestrator/specs.ts';
import { StateStore } from '../orchestrator/state.ts';
import type { WorkerInput } from '../orchestrator/worker.ts';
import type {
  JobState,
  ManagedIssue,
  ManagedMeta,
  ManagedPR,
  OrchestratorState,
  RequirementState,
  Spec,
} from '../orchestrator/types.ts';
import { emptyState } from '../orchestrator/types.ts';

const REQ_A = 'REQ-CNT-01';
const REQ_B = 'REQ-CNT-02';

const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function specDoc(id: string, body: string): string {
  return `### [${id}] 计数器\n\n${body}\n`;
}

function specsOf(files: Record<string, string>): Spec[] {
  return parseSpecs(files).specs;
}

function hashOf(doc: string): string {
  const specs = specsOf({ 'docs/specs/a.md': doc });
  assert.equal(specs.length, 1);
  return specs[0]!.hash;
}

function makeStore(initial?: OrchestratorState): { dir: string; file: string; store: StateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-consistency-'));
  const file = join(dir, 'state.json');
  const store = new StateStore(file, initial ?? emptyState());
  store.load();
  return { dir, file, store };
}

function stateWith(patch: Partial<OrchestratorState>): OrchestratorState {
  return { ...emptyState(), ...patch };
}

function requirement(issueNumber: number, specHash: string): RequirementState {
  return { issueNumber, specHash, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' };
}

function job(patch: Partial<JobState> & { jobId: string; issueNumber: number }): JobState {
  return {
    reqId: patch.reqId ?? REQ_A,
    specHash: patch.specHash ?? 'h1',
    sourceMainSha: patch.sourceMainSha ?? 'sha0',
    attempt: patch.attempt ?? 1,
    status: patch.status ?? 'processing',
    failureStage: patch.failureStage,
    resumeAction: patch.resumeAction,
    prNumber: patch.prNumber,
    startedAt: '2026-11-14T00:00:00Z',
    updatedAt: '2026-11-14T00:00:00Z',
    ...patch,
  };
}

function managedIssue(
  number: number,
  meta: ManagedMeta,
  state: 'open' | 'closed' = 'open',
  labels: string[] = [],
): ManagedIssue {
  return { number, title: `task ${number}`, body: '', state, labels, meta, url: '' };
}

function mergedPR(
  number: number,
  reqId: string,
  specHash: string,
  mergedAt: string,
  mergeCommitSha?: string | null,
  sourceMainSha = 'sha0',
): ManagedPR {
  return {
    number,
    title: `PR #${number}`,
    body: '',
    state: 'closed',
    merged: true,
    mergedAt,
    headRefName: `pi/branch-${number}`,
    baseRefName: 'main',
    mergeCommitSha: mergeCommitSha === null ? undefined : (mergeCommitSha ?? `merge-${number}`),
    meta: { kind: 'code-pr', reqId, specHash, sourceMainSha },
    url: '',
  };
}

function openPR(number: number, reqId: string, specHash: string): ManagedPR {
  return {
    number,
    title: `PR #${number}`,
    body: '',
    state: 'open',
    merged: false,
    headRefName: `pi/branch-${number}`,
    baseRefName: 'main',
    meta: { kind: 'code-pr', reqId, specHash },
    url: '',
  };
}

interface ReconcileGhCalls {
  created: string[];
  reopened: number[];
  closedIssues: number[];
  closedPRs: number[];
  comments: string[];
  updatedBodies: string[];
  removedLabels: number[];
}

function reconcileGithub(issues: ManagedIssue[], prs: ManagedPR[] = []): { gh: GithubClient; calls: ReconcileGhCalls } {
  const calls: ReconcileGhCalls = {
    created: [],
    reopened: [],
    closedIssues: [],
    closedPRs: [],
    comments: [],
    updatedBodies: [],
    removedLabels: [],
  };
  const gh = {
    listIssues: async () => issues,
    listPRs: async () => prs,
    createIssue: async (title: string) => {
      calls.created.push(title);
      return 100 + calls.created.length;
    },
    updateIssueBody: async (_n: number, body: string) => {
      calls.updatedBodies.push(body);
    },
    reopenIssue: async (n: number) => {
      calls.reopened.push(n);
    },
    removeLabels: async (n: number) => {
      calls.removedLabels.push(n);
    },
    addLabels: async () => {},
    closeIssue: async (n: number) => {
      calls.closedIssues.push(n);
    },
    closePR: async (n: number) => {
      calls.closedPRs.push(n);
    },
    comment: async (_n: number, body: string) => {
      calls.comments.push(body);
    },
  } as unknown as GithubClient;
  return { gh, calls };
}

function reconcileCtx(store: StateStore, gh: GithubClient, git: Partial<GitClient> = {}): ReconcileContext {
  return {
    repoDir: '/tmp/fake-repo',
    git: {
      fetch: async () => {},
      revParse: async (_cwd: string, ref: string) => ref,
      readSpecSnapshot: async () => ({}),
      ...git,
    } as GitClient,
    github: gh,
    state: store,
    logger: silentLogger,
  };
}

interface DeployFixture {
  ctx: DeployDeps;
  builds: string[];
  switched: string[];
  closedIssues: number[];
  comments: string[];
  setBuildOk(ok: boolean): void;
}

function deployFixture(store: StateStore, prs: ManagedPR[], opts: { buildOk?: boolean } = {}): DeployFixture {
  const builds: string[] = [];
  const switched: string[] = [];
  const closedIssues: number[] = [];
  const comments: string[] = [];
  let buildOk = opts.buildOk ?? true;
  const ctx: DeployDeps = {
    repoDir: '/tmp/fake-repo',
    runDir: mkdtempSync(join(tmpdir(), 'spec-loop-consistency-deploy-')),
    git: { fetch: async () => {} } as unknown as GitClient,
    github: {
      listPRs: async () => prs,
      removeLabels: async () => {},
      addLabels: async () => {},
      closeIssue: async (n: number) => {
        closedIssues.push(n);
      },
      comment: async (_n: number, body: string) => {
        comments.push(body);
      },
    } as unknown as GithubClient,
    state: store,
    logger: silentLogger,
    build: async (sha: string) => {
      builds.push(sha);
      return { ok: buildOk, detail: buildOk ? '' : '构建失败（fake）' };
    },
    healthCheck: async () => true,
    switchPreview: async (sha: string) => {
      switched.push(sha);
    },
    notify: async () => {},
  };
  return { ctx, builds, switched, closedIssues, comments, setBuildOk: (ok: boolean) => { buildOk = ok; } };
}

test('F1 对账：需求更新关闭旧版本 open PR、保留当前版本 PR', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const v2 = specDoc(REQ_A, 'v2');
  const h1 = hashOf(v1);
  const h2 = hashOf(v2);
  const diff = diffSpecs(specsOf({ 'docs/specs/a.md': v1 }), specsOf({ 'docs/specs/a.md': v2 }));
  const issues = [managedIssue(12, { reqId: REQ_A, specHash: h1, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' })];
  const prs = [openPR(7, REQ_A, h1), openPR(9, REQ_A, h2), openPR(11, REQ_B, h1)];
  const ops = planReconciliation(diff, issues, 'sha1', prs);

  assert.ok(ops.some((op) => op.kind === 'close-pr' && op.prNumber === 7));
  assert.ok(!ops.some((op) => op.kind === 'close-pr' && op.prNumber === 9));
  assert.ok(!ops.some((op) => op.kind === 'close-pr' && op.prNumber === 11));

  const { dir, store } = makeStore();
  try {
    const { gh, calls } = reconcileGithub(issues, prs);
    await applyReconciliation(reconcileCtx(store, gh), ops, 'sha1');
    assert.deepEqual(calls.closedPRs, [7]);
    assert.equal(calls.comments.length, 1);
    assert.equal(store.snapshot().requirements[REQ_A]?.specHash, h2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 对账：需求删除关闭全部关联 open PR', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const diff = diffSpecs(specsOf({ 'docs/specs/a.md': specDoc(REQ_A, 'v1') }), []);
  const issues = [managedIssue(12, { reqId: REQ_A, specHash: h1, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' })];
  const prs = [openPR(7, REQ_A, h1)];
  const ops = planReconciliation(diff, issues, 'sha1', prs);
  assert.ok(ops.some((op) => op.kind === 'close-pr' && op.prNumber === 7));

  const { dir, store } = makeStore(stateWith({ requirements: { [REQ_A]: requirement(12, h1) } }));
  try {
    const { gh, calls } = reconcileGithub(issues, prs);
    await applyReconciliation(reconcileCtx(store, gh), ops, 'sha1');
    assert.deepEqual(calls.closedPRs, [7]);
    assert.deepEqual(calls.closedIssues, [12]);
    assert.equal(store.snapshot().requirements[REQ_A], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 部署：过期 revision 的合并 PR 不部署、不关单', async () => {
  const h2 = hashOf(specDoc(REQ_A, 'v2'));
  const { dir, store } = makeStore(stateWith({ requirements: { [REQ_A]: requirement(12, h2) } }));
  try {
    const fx = deployFixture(store, [mergedPR(5, REQ_A, hashOf(specDoc(REQ_A, 'v1')), '2026-11-14T01:00:00Z')]);
    const result = await deployOnce(fx.ctx);
    assert.equal(result.status, 'nothing');
    assert.deepEqual(fx.builds, []);
    assert.deepEqual(fx.switched, []);
    assert.deepEqual(fx.closedIssues, []);
    assert.deepEqual(store.snapshot().deploy.deployedPRs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2 部署：同窗口多 PR 按实际 mergedAt 升序切换，最新合并生效', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const h2 = specDoc(REQ_B, 'v1');
  const { dir, store } = makeStore(stateWith({
    requirements: {
      [REQ_A]: requirement(12, h1),
      [REQ_B]: { issueNumber: 13, specHash: hashOf(h2), specPath: 'docs/specs/b.md', sourceMainSha: 'sha0' },
    },
  }));
  try {
    const prs = [
      mergedPR(6, REQ_B, hashOf(h2), '2026-11-14T02:00:00Z'),
      mergedPR(5, REQ_A, h1, '2026-11-14T01:00:00Z'),
    ];
    const fx = deployFixture(store, prs);
    const result = await deployOnce(fx.ctx);
    assert.equal(result.status, 'deployed');
    assert.deepEqual(fx.switched, ['merge-5', 'merge-6']);
    assert.equal(store.snapshot().deploy.activeSha, 'merge-6');
    assert.deepEqual(store.snapshot().deploy.deployedPRs.sort(), [5, 6]);
    assert.deepEqual(fx.closedIssues.sort(), [12, 13]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3 对账：noop 回填远端受管 Issue 状态并推进游标', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const h1 = hashOf(v1);
  const diff = diffSpecs(specsOf({ 'docs/specs/a.md': v1 }), specsOf({ 'docs/specs/a.md': v1 }));
  const issues = [managedIssue(12, { reqId: REQ_A, specHash: h1, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' })];
  const ops = planReconciliation(diff, issues, 'sha1');
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, 'noop');

  const { dir, store } = makeStore();
  try {
    const { gh } = reconcileGithub(issues);
    await applyReconciliation(reconcileCtx(store, gh), ops, 'sha1');
    assert.deepEqual(store.snapshot().requirements[REQ_A], {
      issueNumber: 12,
      specHash: h1,
      specPath: 'docs/specs/a.md',
      sourceMainSha: 'sha0',
    });
    assert.equal(store.snapshot().cursorMainSha, 'sha1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3 对账：任一操作失败不推进游标并向调用方抛错，阻止本轮继续派发', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const diff = diffSpecs([], specsOf({ 'docs/specs/a.md': v1 }));
  const ops = planReconciliation(diff, [], 'sha1');
  assert.equal(ops[0]!.kind, 'create');

  const { dir, store } = makeStore(stateWith({ cursorMainSha: 'sha0' }));
  try {
    const gh = {
      listIssues: async () => [],
      listPRs: async () => [],
      createIssue: async () => {
        throw new Error('GitHub 不可用（fake）');
      },
    } as unknown as GithubClient;
    await assert.rejects(
      applyReconciliation(reconcileCtx(store, gh), ops, 'sha1'),
      /对账存在失败操作/,
    );
    assert.equal(store.snapshot().cursorMainSha, 'sha0');
    assert.equal(store.snapshot().requirements[REQ_A], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('基线：游标快照中的既有需求不派单，新增需求创建 Issue；游标不可解析时跳过对账', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const docB = specDoc(REQ_B, 'b1');
  const snapshots: Record<string, Record<string, string>> = {
    sha0: { 'docs/specs/a.md': v1 },
    sha1: { 'docs/specs/a.md': v1, 'docs/specs/b.md': docB },
  };
  const git = {
    revParse: async (_cwd: string, ref: string) => {
      if (ref === 'origin/main') return 'sha1';
      if (!snapshots[ref]) throw new Error('游标不可解析');
      return ref;
    },
    readSpecSnapshot: async (_cwd: string, ref: string) => snapshots[ref === 'origin/main' ? 'sha1' : ref] ?? {},
  };
  const { dir, store } = makeStore(stateWith({ cursorMainSha: 'sha0' }));
  try {
    const { gh, calls } = reconcileGithub([]);
    const summary = await planForMain(reconcileCtx(store, gh, git));
    assert.ok(summary);
    const created = summary.ops.filter((op) => op.kind === 'create');
    assert.equal(created.length, 1);
    assert.equal(created[0]!.reqId, REQ_B);
    assert.ok(!summary.ops.some((op) => op.reqId === REQ_A));
    assert.deepEqual(calls.created, []);

    const brokenCtx = reconcileCtx(store, gh, {
      ...git,
      revParse: async (_cwd: string, ref: string) => {
        if (ref === 'origin/main') return 'sha1';
        throw new Error('游标丢失');
      },
    });
    assert.equal(await planForMain(brokenCtx), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F4 重试：仅失败任务可重试，deploy-only 精确匹配原失败 PR', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const prs = [
    mergedPR(7, REQ_A, h1, '2026-11-14T02:00:00Z'),
    mergedPR(5, REQ_A, h1, '2026-11-14T01:00:00Z'),
  ];
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: {
      j0: job({ jobId: 'j0', issueNumber: 12, status: 'in-review', prNumber: 5, specHash: h1 }),
    },
  }));
  try {
    const fx = deployFixture(store, prs);
    const git = { fetch: async () => { throw new Error('不应进入 worker 重试'); } } as unknown as GitClient;
    const deps: CommandsDeps = {
      repoDir: '/tmp/fake-repo',
      state: store,
      github: {} as GithubClient,
      git,
      logger: silentLogger,
      deploy: fx.ctx,
      worker: {} as Parameters<typeof createCommands>[0]['worker'],
    };
    const commands = createCommands(deps);

    const inReview = await commands.retry(12);
    assert.ok(inReview.includes('仅失败任务可重试'));
    assert.deepEqual(fx.builds, []);

    const unknown = await commands.retry(99);
    assert.ok(unknown.includes('无失败任务记录'));

    await store.update((s) => {
      s.jobs.j0.status = 'failed';
      s.jobs.j0.failureStage = 'deploy';
      s.jobs.j0.resumeAction = 'deploy-only';
      return undefined;
    });
    const ok = await commands.retry(12);
    assert.ok(ok.includes('已重新部署'));
    assert.deepEqual(fx.builds, ['merge-5']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F4 重试：过期 PR 显式重试也拒绝部署', async () => {
  const h2 = hashOf(specDoc(REQ_A, 'v2'));
  const { dir, store } = makeStore(stateWith({ requirements: { [REQ_A]: requirement(12, h2) } }));
  try {
    const fx = deployFixture(store, [mergedPR(5, REQ_A, hashOf(specDoc(REQ_A, 'v1')), '2026-11-14T01:00:00Z')]);
    const result = await retryDeployForIssue(fx.ctx, 12, 5);
    assert.equal(result.status, 'nothing');
    assert.ok(result.error?.includes('过期'));
    assert.deepEqual(fx.builds, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F5 部署：失败 PR 轮询不自动重跑，重试命令精确恢复并清理失败记录', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: { j1: job({ jobId: 'j1', issueNumber: 12, status: 'in-review', prNumber: 5, specHash: h1 }) },
  }));
  try {
    const fx = deployFixture(store, [mergedPR(5, REQ_A, h1, '2026-11-14T01:00:00Z')], { buildOk: false });
    const first = await deployOnce(fx.ctx);
    assert.equal(first.status, 'failed');
    assert.deepEqual(store.snapshot().deploy.deployFailedPRs, [5]);
    assert.equal(store.snapshot().jobs.j1?.status, 'failed');
    assert.equal(store.snapshot().jobs.j1?.resumeAction, 'deploy-only');

    const second = await deployOnce(fx.ctx);
    assert.equal(second.status, 'nothing');
    assert.equal(fx.builds.length, 1);

    fx.setBuildOk(true);
    const retried = await retryDeployForIssue(fx.ctx, 12, 5);
    assert.equal(retried.status, 'deployed');
    assert.equal(fx.builds.length, 2);
    assert.equal(fx.builds[1], 'merge-5');
    assert.deepEqual(store.snapshot().deploy.deployedPRs, [5]);
    assert.deepEqual(store.snapshot().deploy.deployFailedPRs, []);
    assert.equal(store.snapshot().deploy.activeSha, 'merge-5');
    assert.equal(store.snapshot().jobs.j1?.status, 'done');
    assert.equal(store.snapshot().jobs.j1?.resumeAction, undefined);
    assert.deepEqual(fx.closedIssues, [12]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('部署：缺少 merge SHA 不猜测目标并按失败处理', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: { j1: job({ jobId: 'j1', issueNumber: 12, status: 'in-review', prNumber: 5, specHash: h1 }) },
  }));
  try {
    const fx = deployFixture(store, [mergedPR(5, REQ_A, h1, '2026-11-14T01:00:00Z', null)]);
    const result = await deployOnce(fx.ctx);
    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes('merge'));
    assert.deepEqual(fx.builds, []);
    assert.deepEqual(store.snapshot().deploy.deployFailedPRs, [5]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F6 状态：损坏文件备份并拒绝启动，ENOENT 才空状态，合法文件正常加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-consistency-state-'));
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, '不是 JSON', 'utf8');
    assert.throws(() => new StateStore(file).load(), /状态文件损坏/);
    const backups = readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);

    writeFileSync(file, JSON.stringify({ schemaVersion: 2 }), 'utf8');
    assert.throws(() => new StateStore(file).load(), /状态文件损坏/);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-')).length, 2);

    const missing = join(dir, 'nested', 'state.json');
    const fresh = new StateStore(missing).load();
    assert.equal(fresh.cursorMainSha, null);
    assert.deepEqual(fresh.requirements, {});

    writeFileSync(file, JSON.stringify({ ...emptyState(), cursorMainSha: 'sha9' }), 'utf8');
    const loaded = new StateStore(file).load();
    assert.equal(loaded.cursorMainSha, 'sha9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function commandDeps(
  store: StateStore,
  git: Partial<GitClient>,
  deployCtx: DeployDeps,
  retryWorker?: (input: WorkerInput) => Promise<{ status: string; prNumber?: number; branch?: string; error?: string }>,
): CommandsDeps {
  return {
    repoDir: '/tmp/fake-repo',
    state: store,
    github: {} as GithubClient,
    git: { fetch: async () => {}, readSpecSnapshot: async () => ({}), ...git } as GitClient,
    logger: silentLogger,
    deploy: deployCtx,
    worker: {} as Parameters<typeof createCommands>[0]['worker'],
    retryWorker: retryWorker as CommandsDeps['retryWorker'],
  };
}

test('R2 重试：经 retryWorker 生命周期成功后新 job 与 PR 状态可发现', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: { j1: job({ jobId: 'j1', issueNumber: 12, status: 'failed', failureStage: 'verify', resumeAction: 'worker', attempt: 1, specHash: h1 }) },
  }));
  try {
    const retryCalls: WorkerInput[] = [];
    const deps = commandDeps(
      store,
      { readSpecSnapshot: async () => ({ 'docs/specs/a.md': specDoc(REQ_A, 'v1') }) },
      deployFixture(store, []).ctx,
      async (input) => {
        retryCalls.push(input);
        await store.update((s) => {
          s.jobs[input.jobId] = job({
            jobId: input.jobId,
            issueNumber: 12,
            specHash: input.spec.hash,
            sourceMainSha: input.sourceMainSha,
            attempt: input.attempt,
            status: 'processing',
          });
          return undefined;
        });
        // 模拟 runOneWorker 在 published 后把 PR 关联进新 job。
        await store.update((s) => {
          const target = s.jobs[input.jobId];
          if (target) target.prNumber = 42;
          return undefined;
        });
        return { status: 'published', prNumber: 42 };
      },
    );
    const message = await createCommands(deps).retry(12);
    assert.ok(message.includes('已重新进入 review'));
    assert.ok(message.includes('42'));
    assert.equal(retryCalls.length, 1);
    assert.equal(retryCalls[0]!.attempt, 2);
    assert.equal(retryCalls[0]!.sourceMainSha, 'sha0');
    const snapshot = store.snapshot();
    const newJob = Object.values(snapshot.jobs).find((j) => j.jobId.startsWith('retry-'));
    assert.ok(newJob);
    assert.equal(newJob.status, 'processing');
    assert.equal(newJob.prNumber, 42);
    assert.equal(newJob.attempt, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 重试：retryWorker 未接线时明确拒绝，不进入旧重跑路径', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: { j1: job({ jobId: 'j1', issueNumber: 12, status: 'failed', failureStage: 'verify', resumeAction: 'worker', specHash: h1 }) },
  }));
  try {
    const deps = commandDeps(
      store,
      { fetch: async () => { throw new Error('不应进入 worker 重跑'); } },
      deployFixture(store, []).ctx,
    );
    const message = await createCommands(deps).retry(12);
    assert.ok(message.includes('未接线'));
    assert.ok(message.includes('拒绝'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 重试：旧版本高 attempt 不遮盖当前版本 job', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const h2 = hashOf(specDoc(REQ_A, 'v2'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: { issueNumber: 12, specHash: h2, specPath: 'docs/specs/a.md', sourceMainSha: 'sha1' } },
    jobs: {
      jOld: job({ jobId: 'jOld', issueNumber: 12, status: 'failed', attempt: 3, specHash: h1, sourceMainSha: 'sha0' }),
      jNew: job({ jobId: 'jNew', issueNumber: 12, status: 'failed', attempt: 1, specHash: h2, sourceMainSha: 'sha1' }),
    },
  }));
  try {
    const retryCalls: WorkerInput[] = [];
    const deps = commandDeps(
      store,
      { readSpecSnapshot: async () => ({ 'docs/specs/a.md': specDoc(REQ_A, 'v2') }) },
      deployFixture(store, []).ctx,
      async (input) => {
        retryCalls.push(input);
        return { status: 'published', prNumber: 43 };
      },
    );
    await createCommands(deps).retry(12);
    assert.equal(retryCalls.length, 1);
    assert.equal(retryCalls[0]!.attempt, 2);
    assert.equal(retryCalls[0]!.sourceMainSha, 'sha1');
    assert.equal(retryCalls[0]!.spec.hash, h2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 重试：main 快照与需求基线不一致时拒绝重试', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: { j1: job({ jobId: 'j1', issueNumber: 12, status: 'failed', failureStage: 'verify', resumeAction: 'worker', specHash: h1 }) },
  }));
  try {
    const retryCalls: WorkerInput[] = [];
    const deps = commandDeps(
      store,
      { readSpecSnapshot: async () => ({ 'docs/specs/a.md': specDoc(REQ_A, 'v2') }) },
      deployFixture(store, []).ctx,
      async (input) => {
        retryCalls.push(input);
        return { status: 'published', prNumber: 44 };
      },
    );
    const message = await createCommands(deps).retry(12);
    assert.ok(message.includes('需求版本与任务基线不一致'));
    assert.deepEqual(retryCalls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 对账：closePR 失败时抛错且游标不推进', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const v2 = specDoc(REQ_A, 'v2');
  const h1 = hashOf(v1);
  const h2 = hashOf(v2);
  const diff = diffSpecs(specsOf({ 'docs/specs/a.md': v1 }), specsOf({ 'docs/specs/a.md': v2 }));
  const issues = [managedIssue(12, { reqId: REQ_A, specHash: h1, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' })];
  const prs = [openPR(7, REQ_A, h1)];
  const ops = planReconciliation(diff, issues, 'sha1', prs);
  assert.ok(ops.some((op) => op.kind === 'close-pr'));

  const { dir, store } = makeStore(stateWith({ cursorMainSha: 'sha0' }));
  try {
    const gh = {
      listIssues: async () => issues,
      listPRs: async () => prs,
      updateIssueBody: async () => {},
      reopenIssue: async () => {},
      removeLabels: async () => {},
      addLabels: async () => {},
      closePR: async () => {
        throw new Error('PR 关闭失败（fake）');
      },
    } as unknown as GithubClient;
    await assert.rejects(
      applyReconciliation(reconcileCtx(store, gh), ops, 'sha1'),
      /对账存在失败操作/,
    );
    assert.equal(store.snapshot().cursorMainSha, 'sha0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 对账：body 已改但 labels/reopen 未完成时重放 update 修复，不判 noop', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const v2 = specDoc(REQ_A, 'v2');
  const h1 = hashOf(v1);
  const h2 = hashOf(v2);
  const diff = diffSpecs(specsOf({ 'docs/specs/a.md': v1 }), specsOf({ 'docs/specs/a.md': v2 }));
  // 上轮部分完成：远端 body/meta 已是新 hash，但状态与 labels 未修复，本地 state 仍指向旧版本。
  const issues = [managedIssue(
    12,
    { reqId: REQ_A, specHash: h2, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' },
    'open',
    ['pi-task', 'status:in-review'],
  )];
  const ops = planReconciliation(diff, issues, 'sha1');
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, 'update');

  const { dir, store } = makeStore(stateWith({ cursorMainSha: 'sha0' }));
  try {
    const { gh, calls } = reconcileGithub(issues);
    await applyReconciliation(reconcileCtx(store, gh), ops, 'sha1');
    assert.deepEqual(calls.reopened, [12]);
    assert.deepEqual(calls.removedLabels, [12]);
    assert.deepEqual(store.snapshot().requirements[REQ_A], {
      issueNumber: 12,
      specHash: h2,
      specPath: 'docs/specs/a.md',
      sourceMainSha: 'sha1',
    });
    assert.equal(store.snapshot().cursorMainSha, 'sha1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 对账：删除后恢复同内容时重新打开 closed Issue', async () => {
  const v1 = specDoc(REQ_A, 'v1');
  const h1 = hashOf(v1);
  // 游标基线中没有该需求（曾被删除），main 恢复同内容 → diff 为 add，但已有同 hash 的 closed Issue。
  const diff = diffSpecs([], specsOf({ 'docs/specs/a.md': v1 }));
  const issues = [managedIssue(
    12,
    { reqId: REQ_A, specHash: h1, specPath: 'docs/specs/a.md', sourceMainSha: 'sha0' },
    'closed',
    ['pi-task'],
  )];
  const ops = planReconciliation(diff, issues, 'sha1');
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, 'update');

  const { dir, store } = makeStore(stateWith({ cursorMainSha: 'sha0' }));
  try {
    const { gh, calls } = reconcileGithub(issues);
    await applyReconciliation(reconcileCtx(store, gh), ops, 'sha1');
    assert.deepEqual(calls.reopened, [12]);
    assert.deepEqual(calls.closedIssues, []);
    assert.equal(store.snapshot().requirements[REQ_A]?.specHash, h1);
    assert.equal(store.snapshot().requirements[REQ_A]?.sourceMainSha, 'sha1');
    assert.equal(store.snapshot().cursorMainSha, 'sha1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 部署：过期 job 的积压回执不关闭新版本任务', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const h2 = hashOf(specDoc(REQ_A, 'v2'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: { issueNumber: 12, specHash: h2, specPath: 'docs/specs/a.md', sourceMainSha: 'sha1' } },
    jobs: {
      jOld: job({
        jobId: 'jOld',
        issueNumber: 12,
        status: 'done',
        prNumber: 5,
        resumeAction: 'sync-deploy-receipt',
        specHash: h1,
        sourceMainSha: 'sha0',
      }),
      jNew: job({
        jobId: 'jNew',
        issueNumber: 12,
        status: 'in-review',
        prNumber: 6,
        specHash: h2,
        sourceMainSha: 'sha1',
      }),
    },
  }));
  try {
    // 只列出旧版本已合并 PR（新 PR 尚未合并），验证旧回执不会被套到当前任务上。
    const fx = deployFixture(store, [mergedPR(5, REQ_A, h1, '2026-11-14T01:00:00Z')]);
    await deployOnce(fx.ctx);
    assert.deepEqual(fx.builds, []);
    assert.deepEqual(fx.closedIssues, []);
    assert.equal(store.snapshot().jobs.jOld?.resumeAction, undefined);
    assert.equal(store.snapshot().jobs.jNew?.status, 'in-review');
    assert.deepEqual(store.snapshot().deploy.deployedPRs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2 部署：首次评论失败后补同步最终补发评论且不重复', async () => {
  const h1 = hashOf(specDoc(REQ_A, 'v1'));
  const { dir, store } = makeStore(stateWith({
    requirements: { [REQ_A]: requirement(12, h1) },
    jobs: { j1: job({ jobId: 'j1', issueNumber: 12, status: 'in-review', prNumber: 5, specHash: h1 }) },
  }));
  try {
    const fx = deployFixture(store, [mergedPR(5, REQ_A, h1, '2026-11-14T01:00:00Z')]);
    // 有状态 fake：远端 issue/评论可见，幂等回执据此去重。
    const issue: { number: number; state: 'open' | 'closed'; labels: string[] } = {
      number: 12,
      state: 'open',
      labels: ['pi-task', 'status:in-review'],
    };
    const comments: Array<{ id: number; body: string }> = [];
    let commentFailuresLeft = 2;
    const gh = fx.ctx.github as unknown as Record<string, unknown>;
    gh.listIssues = async () => [issue];
    gh.listIssueComments = async () => comments;
    gh.removeLabels = async (_n: number, labels: string[]) => {
      issue.labels = issue.labels.filter((l) => !labels.includes(l));
    };
    gh.addLabels = async (_n: number, labels: string[]) => {
      issue.labels.push(...labels.filter((l) => !issue.labels.includes(l)));
    };
    gh.closeIssue = async () => {
      issue.state = 'closed';
    };
    gh.comment = async (_n: number, body: string) => {
      if (commentFailuresLeft > 0) {
        commentFailuresLeft -= 1;
        throw new Error('评论失败（fake）');
      }
      comments.push({ id: comments.length + 1, body });
    };

    const first = await deployOnce(fx.ctx);
    assert.equal(first.status, 'deployed');
    assert.equal(comments.length, 0);
    assert.equal(issue.state, 'closed');
    assert.equal(store.snapshot().jobs.j1?.resumeAction, 'sync-deploy-receipt');

    const second = await deployOnce(fx.ctx);
    assert.equal(second.status, 'nothing');
    assert.equal(comments.length, 1);
    assert.ok(comments[0]!.body.includes('已部署'));
    assert.equal(store.snapshot().jobs.j1?.resumeAction, undefined);

    const third = await deployOnce(fx.ctx);
    assert.equal(third.status, 'nothing');
    assert.equal(comments.length, 1, 'marker 去重后不应重复评论');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3 github：REST pulls 列表无 merged 字段时按 merged_at 识别合并状态', async () => {
  // 真实 REST List pull requests 形状：只有 merged_at（可 null），没有 merged 布尔。
  const restPayload = [
    {
      number: 5,
      title: '已合并 PR',
      state: 'closed',
      merged_at: '2026-11-14T01:00:00Z',
      head: { ref: 'pi/a' },
      base: { ref: 'main' },
      merge_commit_sha: 'merge-5',
    },
    {
      number: 6,
      title: '普通关闭 PR',
      state: 'closed',
      merged_at: null,
      head: { ref: 'pi/b' },
      base: { ref: 'main' },
    },
  ];
  const runner = async (): Promise<GhResult> => ({
    stdout: JSON.stringify(restPayload),
    stderr: '',
    code: 0,
  });
  const client = new GithubClient('o/r', runner);
  const prs = await client.listPRs();
  assert.equal(prs.find((p) => p.number === 5)?.merged, true);
  assert.equal(prs.find((p) => p.number === 5)?.mergeCommitSha, 'merge-5');
  assert.equal(prs.find((p) => p.number === 6)?.merged, false);
});

test('R3 github：--paginate --slurp 双页数组 flatten 后完整解析', async () => {
  const calls: string[][] = [];
  const page1 = [{ number: 1, title: 'i1', state: 'open', body: '', labels: [] }];
  const page2 = [{ number: 2, title: 'i2', state: 'closed', body: '', labels: [] }];
  // 模拟 gh api --paginate --slurp：两页拼接成「页数组」输出。
  const runner = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    return { stdout: JSON.stringify([page1, page2]), stderr: '', code: 0 };
  };
  const client = new GithubClient('o/r', runner);
  const issues = await client.listIssues();
  assert.deepEqual(issues.map((i) => i.number), [1, 2]);
  assert.ok(calls[0]!.includes('--paginate'));
  assert.ok(calls[0]!.includes('--slurp'));
});

test('R3 github：initLabels 逐个调用 label create，每次只传一个 name', async () => {
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    return { stdout: '', stderr: '', code: 0 };
  };
  const client = new GithubClient('o/r', runner);
  const labels = ['pi-task', 'status:todo', 'status:done'];
  await client.initLabels(labels);
  assert.equal(calls.length, labels.length);
  labels.forEach((label, i) => {
    const args = calls[i]!;
    assert.equal(args[0], 'label');
    assert.equal(args[1], 'create');
    assert.ok(args.includes(label));
    assert.ok(args.includes('--force'));
    // 每次 gh 调用只携带一个 label name。
    assert.equal(args.filter((a) => labels.includes(a)).length, 1);
  });
});

test('R3.2 github：defaultGhRunner 按 SPEC_LOOP_GH_TIMEOUT_MS 超时，返回非 0 与摘要', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-gh-runner-timeout-'));
  const origPath = process.env.PATH;
  const origTimeout = process.env.SPEC_LOOP_GH_TIMEOUT_MS;
  try {
    // fake gh：exec 保证 SIGTERM 直接命中 sleep，不残留孤儿进程；不触真实 gh/网络。
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
    process.env.PATH = `${dir}:${origPath ?? ''}`;
    process.env.SPEC_LOOP_GH_TIMEOUT_MS = '200';

    const res = await defaultGhRunner(['issue', 'list']);
    assert.equal(res.code, 124);
    assert.ok(res.stderr.includes('超时'));
    assert.ok(res.stderr.includes('200'));
  } finally {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    if (origTimeout === undefined) delete process.env.SPEC_LOOP_GH_TIMEOUT_MS;
    else process.env.SPEC_LOOP_GH_TIMEOUT_MS = origTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3.2 github：defaultGhRunner 成功路径不受超时改动影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-gh-runner-ok-'));
  const origPath = process.env.PATH;
  try {
    writeFileSync(join(dir, 'gh'), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    process.env.PATH = `${dir}:${origPath ?? ''}`;

    const client = new GithubClient('o/r');
    const issues = await client.listIssues();
    assert.deepEqual(issues, []);
  } finally {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
