import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { GitClient } from '../orchestrator/git.ts';
import { GithubClient, type GhRunner } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { createPreviewServer } from '../orchestrator/preview.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import {
  createBuild,
  createCore,
  runOneWorkerForInput,
  syncPendingSatisfiedReceipts,
  syncPendingStatusLabels,
  verifyReleaseOverHttp,
  type Core,
} from '../orchestrator/runtime.ts';
import { StateStore } from '../orchestrator/state.ts';
import type { Config } from '../orchestrator/config.ts';
import type { ManagedPR, OrchestratorState, Spec } from '../orchestrator/types.ts';
import {
  checkSatisfiedRevisionCurrent,
  runWorkerJob,
  type WorkerDeps,
  type WorkerInput,
  type WorkerOutcome,
} from '../orchestrator/worker.ts';

const execFileAsync = promisify(execFile);

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const sourceSha = '1'.repeat(40);
const workerHeadSha = '2'.repeat(40);

function makeConfig(dir: string): Config {
  return {
    repo: null,
    repoDir: dir,
    runDir: join(dir, '.orchestrator'),
    stateFile: join(dir, '.orchestrator-state.json'),
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
    piProvider: '',
    piModel: '',
    piAgentDir: join(dir, '.orchestrator', 'agent'),
    errorDedupWindowMs: 600000,
    revisionBudget: 2,
    logRetentionDays: 7,
    reportToken: '',
    feishu: {
      enabled: false,
      allowedUserIds: [],
    },
  };
}

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
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function requirementSpec(hash = 'h1'): Spec {
  return { id: 'REQ-A-01', title: '需求', path: 'docs/specs/REQ-A-01.md', body: '正文', hash };
}

function makeState(spec: Spec): OrchestratorState {
  return {
    schemaVersion: 1,
    repo: 'owner/repo',
    cursorMainSha: sourceSha,
    requirements: {
      [spec.id]: {
        issueNumber: 12,
        specHash: spec.hash,
        specPath: spec.path,
        sourceMainSha: sourceSha,
      },
    },
    jobs: {},
    deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
    specRequests: {},
    opLog: [],
  };
}

type GhCall =
  | { kind: 'remove'; labels: string[] }
  | { kind: 'add'; labels: string[] }
  | { kind: 'comment'; body: string };

function labelSequence(calls: GhCall[]): string[] {
  return calls
    .filter((call): call is Extract<GhCall, { kind: 'remove' | 'add' }> => call.kind !== 'comment')
    .map((call) => `${call.kind}:${call.kind === 'remove' ? 'all' : call.labels.join('+')}`);
}

interface WorkerHarness {
  core: Core;
  ghCalls: GhCall[];
  notifications: string[];
  workerInputs: WorkerInput[];
  setOutcome: (outcome: WorkerOutcome) => void;
  setIdle: () => void;
  setFailLabel: (label?: string) => void;
  setRemotePRs: (prs: ManagedPR[]) => void;
  setFailApi: (failed: boolean) => void;
  setFailCommentAfterDelivery: (failed: boolean) => void;
}

function makeWorkerHarness(options?: { failLabel?: string }): WorkerHarness {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-runtime-'));
  const spec = requirementSpec();
  const state = new StateStore(join(dir, 'state.json'), makeState(spec));
  const ghCalls: GhCall[] = [];
  const notifications: string[] = [];
  const workerInputs: WorkerInput[] = [];
  let outcome: WorkerOutcome = { status: 'failed', error: '未设置 fake worker 结局' };
  let failLabel: string | undefined = options?.failLabel;
  let failApi = false;
  let failCommentAfterDelivery = false;
  const remotePRs: ManagedPR[] = [];

  const runner: GhRunner = async (args, opts) => {
    if (args[0] === 'issue' && args[1] === 'edit') {
      const flagIndex = args.findIndex((arg) => arg === '--add-label' || arg === '--remove-label');
      const kind = flagIndex >= 0 && args[flagIndex] === '--add-label' ? 'add' : 'remove';
      const labels = (args[flagIndex + 1] ?? '').split(',').filter(Boolean);
      ghCalls.push(kind === 'add' ? { kind, labels } : { kind, labels });
      if (kind === 'add' && failLabel && labels.includes(failLabel)) {
        return { stdout: '', stderr: `fake gh 拒绝添加 ${failLabel}`, code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      const bodyIndex = args.findIndex((arg) => arg === '--body-file');
      const body = bodyIndex >= 0 ? (await import('node:fs')).readFileSync(args[bodyIndex + 1]!, 'utf8') : '';
      ghCalls.push({ kind: 'comment', body });
      if (failCommentAfterDelivery) return { stdout: '', stderr: 'fake gh 评论响应丢失', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'api') {
      if (failApi) return { stdout: '', stderr: 'fake gh api 失败', code: 1 };
      const path = args[args.length - 1] ?? '';
      if (path.includes('/comments')) {
        const bodies = ghCalls
          .filter((call): call is Extract<GhCall, { kind: 'comment' }> => call.kind === 'comment')
          .map((call) => call.body);
        return {
          stdout: JSON.stringify([bodies.map((body, i) => ({ id: i + 1, body }))]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: JSON.stringify([remotePRs]), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  const gitRunner = async () => ({ stdout: '', stderr: '', code: 0 });
  const git = new GitClient(gitRunner);
  const github = new GithubClient('owner/repo', runner);
  const core = {
    state,
    git,
    github,
    repo: 'owner/repo',
    workerDeps: {
      repoDir: dir,
      runDir: dir,
      git,
      github,
      logger: silentLogger,
      notify: async (text: string) => {
        notifications.push(text);
      },
    },
    workerRunner: async (_deps: WorkerDeps, input: WorkerInput): Promise<WorkerOutcome> => {
      workerInputs.push(input);
      return outcome;
    },
  } as unknown as Core;

  return {
    core,
    ghCalls,
    notifications,
    workerInputs,
    setOutcome: (next) => {
      outcome = next;
    },
    setIdle: () => {
      outcome = undefined as unknown as WorkerOutcome;
    },
    setFailLabel: (next) => {
      failLabel = next;
    },
    setRemotePRs: (prs) => {
      remotePRs.splice(0, remotePRs.length, ...prs);
    },
    setFailApi: (failed) => {
      failApi = failed;
    },
    setFailCommentAfterDelivery: (failed) => {
      failCommentAfterDelivery = failed;
    },
  };
}

function input(harness: WorkerHarness, spec = requirementSpec()): WorkerInput {
  return {
    jobId: 'job-1',
    reqId: spec.id,
    issueNumber: 12,
    spec,
    sourceMainSha: sourceSha,
    attempt: 1,
  };
}

test('createCore 的通知封装共享实例且同步抛错、异步拒绝均不向外传播', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-notify-error-'));
  const syncCalls: string[] = [];
  const syncCore = createCore(makeConfig(dir), null, (text) => {
    syncCalls.push(text);
    throw new Error('同步通知失败');
  });

  assert.strictEqual(syncCore.workerDeps.notify, syncCore.deployDeps.notify);
  await assert.doesNotReject(async () => {
    await syncCore.workerDeps.notify?.('Worker 发布完成');
    await syncCore.deployDeps.notify?.('部署完成');
  });
  assert.deepEqual(syncCalls, ['Worker 发布完成', '部署完成']);

  const rejectCalls: string[] = [];
  const rejectCore = createCore(makeConfig(dir), null, async (text) => {
    rejectCalls.push(text);
    throw new Error('异步通知失败');
  });
  await assert.doesNotReject(() => rejectCore.workerDeps.notify?.('部署失败') ?? Promise.resolve());
  assert.deepEqual(rejectCalls, ['部署失败']);
});

test('createCore 的通知封装在 5 秒后中止永不返回的通知', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-notify-timeout-'));
  const calls: string[] = [];
  const core = createCore(makeConfig(dir), null, async (text) => {
    calls.push(text);
    await new Promise<void>(() => {});
  });
  const notify = core.workerDeps.notify;
  assert.ok(notify);

  const pending = notify('永不返回');
  await Promise.resolve();
  assert.deepEqual(calls, ['永不返回']);
  t.mock.timers.tick(5000);
  await assert.doesNotReject(pending);
});

test('runOneWorkerForInput 同步完整 processing → in-review 生命周期并带链接通知', async () => {
  const harness = makeWorkerHarness();
  harness.setOutcome({
    status: 'published',
    prNumber: 34,
    branch: 'pi/req',
    headSHA: workerHeadSha,
  });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.deepEqual(outcome, {
    status: 'published',
    prNumber: 34,
    branch: 'pi/req',
    headSHA: workerHeadSha,
  });
  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:processing',
    'remove:all',
    'add:pi-task+status:in-review',
  ]);
  assert.equal(harness.ghCalls.some((call) => call.kind === 'comment'), false);
  assert.equal(harness.workerInputs.length, 1);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'in-review');
  assert.equal(job?.prNumber, 34);
  assert.equal(job?.headSHA, workerHeadSha);
  assert.equal(
    harness.notifications.some((text) => text.includes('https://github.com/owner/repo/issues/12')),
    true,
  );
  assert.equal(
    harness.notifications.some((text) => text.includes('https://github.com/owner/repo/pull/34')),
    true,
  );
});

test('runOneWorkerForInput failed 结局同步 failed 标签并安全截断 Issue 评论', async () => {
  const harness = makeWorkerHarness();
  const longError = 'x'.repeat(5000);
  harness.setOutcome({
    status: 'failed',
    error: longError,
    failureStage: 'verify',
    resumeAction: 'worker',
  });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.equal(outcome.status, 'failed');
  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:processing',
    'remove:all',
    'add:pi-task+status:failed',
  ]);
  const comments = harness.ghCalls.filter((call): call is Extract<GhCall, { kind: 'comment' }> => call.kind === 'comment');
  assert.equal(comments.length, 1);
  assert.ok(comments[0]?.body.length <= 4000);
  assert.match(comments[0]?.body ?? '', /…\(已截断\)$/);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'failed');
  assert.equal(job?.failureStage, 'verify');
  assert.equal(job?.resumeAction, 'worker');
  assert.equal(
    harness.notifications.some((text) => text.includes('https://github.com/owner/repo/issues/12')),
    true,
  );
});

test('远端恢复保留已有可信 head，绝不用远端观察值补齐，也不调用 Worker', async () => {
  const harness = makeWorkerHarness();
  const remoteHeadSha = '3'.repeat(40);
  const meta = {
    kind: 'code-pr',
    reqId: 'REQ-A-01',
    specHash: 'h1',
    sourceMainSha: sourceSha,
  };
  harness.setRemotePRs([
    {
      number: 77,
      title: '[REQ-A-01] 需求',
      body: `<!-- spec-loop:meta\n${JSON.stringify(meta, null, 2)}\n-->`,
      state: 'open',
      merged: false,
      headRefName: 'pi/existing',
      headSHA: remoteHeadSha,
      baseRefName: 'main',
      meta,
    },
  ]);
  harness.setOutcome({ status: 'failed', error: '不应执行 Worker' });
  await harness.core.state.update((state) => {
    state.jobs['job-1'] = {
      jobId: 'job-1',
      reqId: 'REQ-A-01',
      issueNumber: 12,
      specHash: 'h1',
      sourceMainSha: sourceSha,
      attempt: 1,
      status: 'in-review',
      prNumber: 76,
      headSHA: workerHeadSha,
      startedAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    };
  });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.equal(outcome.status, 'published');
  assert.equal(outcome.prNumber, 77);
  assert.deepEqual(harness.workerInputs, []);
  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:in-review',
  ]);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'in-review');
  assert.equal(job?.prNumber, 77);
  assert.equal(job?.headSHA, workerHeadSha);
  assert.notEqual(job?.headSHA, remoteHeadSha);
  assert.equal(
    harness.notifications.some((text) => text.includes('https://github.com/owner/repo/pull/77')),
    true,
  );

  await harness.core.state.update((state) => {
    delete state.jobs['job-1']!.headSHA;
  });
  await runOneWorkerForInput(harness.core, input(harness));
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.headSHA, undefined);
  assert.deepEqual(harness.workerInputs, []);
});

test('published outcome 缺失或非法 head 时清除旧可信值，禁止跨 attempt 沿用', async () => {
  for (const badHead of [undefined, 'not-a-complete-sha']) {
    const harness = makeWorkerHarness();
    await harness.core.state.update((state) => {
      state.jobs['job-1'] = {
        jobId: 'job-1',
        reqId: 'REQ-A-01',
        issueNumber: 12,
        specHash: 'h1',
        sourceMainSha: sourceSha,
        attempt: 1,
        status: 'failed',
        prNumber: 75,
        headSHA: workerHeadSha,
        startedAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      };
    });
    harness.setOutcome({
      status: 'published',
      prNumber: 79,
      branch: 'pi/req',
      ...(badHead === undefined ? {} : { headSHA: badHead }),
    });

    await runOneWorkerForInput(harness.core, input(harness));

    const job = harness.core.state.snapshot().jobs['job-1'];
    assert.equal(job?.status, 'in-review');
    assert.equal(job?.prNumber, 79);
    assert.equal(job?.headSHA, undefined);
  }
});

test('远端交付预检失败时 fail closed，不执行 Worker', async () => {
  const harness = makeWorkerHarness();
  harness.setFailApi(true);

  await assert.rejects(() => runOneWorkerForInput(harness.core, input(harness)), /fake gh api 失败/);
  assert.deepEqual(harness.workerInputs, []);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'failed');
  assert.equal(job?.failureStage, 'remote-delivery-check');
  assert.equal(job?.resumeAction, 'remote-delivery-check');
});

test('closed 且未 merge 的当前 revision PR 不复用，允许重新交付', async () => {
  const harness = makeWorkerHarness();
  harness.setRemotePRs([
    {
      number: 78,
      title: '[REQ-A-01] 需求',
      body: '',
      state: 'closed',
      merged: false,
      headRefName: 'pi/closed',
      baseRefName: 'main',
      meta: { kind: 'code-pr', reqId: 'REQ-A-01', specHash: 'h1', sourceMainSha: sourceSha },
    },
  ]);
  harness.setOutcome({ status: 'published', prNumber: 34, branch: 'pi/new' });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.equal(outcome.prNumber, 34);
  assert.equal(harness.workerInputs.length, 1);
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.prNumber, 34);
});

test('runOneWorkerForInput stale 结局不再修改当前新需求的 GitHub 状态', async () => {
  const harness = makeWorkerHarness();
  harness.setOutcome({ status: 'stale', error: '主线需求已变化', failureStage: 'publish' });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.equal(outcome.status, 'stale');
  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:processing',
  ]);
  assert.equal(harness.ghCalls.some((call) => call.kind === 'comment'), false);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'failed');
  assert.equal(job?.failureStage, 'publish');
});

test('本地 requirement 已切到新 revision 时，旧期望作业直接 stale 且不写 GitHub', async () => {
  const harness = makeWorkerHarness();
  const newSpec = requirementSpec('h2');

  const outcome = await runOneWorkerForInput(harness.core, input(harness, newSpec));

  assert.equal(outcome.status, 'stale');
  assert.deepEqual(harness.ghCalls, []);
  assert.deepEqual(harness.workerInputs, []);
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.status, 'failed');
});

test('processing 标签同步失败时抛错且不执行 Worker', async () => {
  const harness = makeWorkerHarness({ failLabel: 'status:processing' });

  await assert.rejects(() => runOneWorkerForInput(harness.core, input(harness)), /fake gh 拒绝添加 status:processing/);
  assert.deepEqual(harness.workerInputs, []);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'failed');
  assert.equal(job?.failureStage, 'sync-status-label');
  assert.equal(job?.resumeAction, 'sync-status-label');
});

test('in-review 标签同步失败不能假成功，并保留补同步标记', async () => {
  const harness = makeWorkerHarness({ failLabel: 'status:in-review' });
  harness.setOutcome({ status: 'published', prNumber: 34, branch: 'pi/req' });

  await assert.rejects(() => runOneWorkerForInput(harness.core, input(harness)), /fake gh 拒绝添加 status:in-review/);
  assert.equal(harness.workerInputs.length, 1);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'in-review');
  assert.equal(job?.prNumber, 34);
  assert.equal(job?.resumeAction, 'sync-status-label');
});

test('syncPendingStatusLabels 为已发布 PR 只补 in-review 标签，不重跑 Worker', async () => {
  const harness = makeWorkerHarness({ failLabel: 'status:in-review' });
  harness.setOutcome({ status: 'published', prNumber: 34, branch: 'pi/req' });
  await assert.rejects(() => runOneWorkerForInput(harness.core, input(harness)), /fake gh 拒绝添加 status:in-review/);
  harness.setFailLabel(undefined);
  harness.ghCalls.length = 0;
  harness.workerInputs.length = 0;

  await syncPendingStatusLabels(harness.core);

  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:in-review',
  ]);
  assert.deepEqual(harness.workerInputs, []);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'in-review');
  assert.equal(job?.prNumber, 34);
  assert.equal(job?.failureStage, undefined);
  assert.equal(job?.resumeAction, undefined);
});

test('syncPendingStatusLabels 补 processing 失败后的 failed 标签并清除标记', async () => {
  const harness = makeWorkerHarness({ failLabel: 'status:processing' });
  await assert.rejects(() => runOneWorkerForInput(harness.core, input(harness)), /fake gh 拒绝添加 status:processing/);
  harness.ghCalls.length = 0;

  await syncPendingStatusLabels(harness.core);

  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:failed',
  ]);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'failed');
  assert.equal(job?.failureStage, undefined);
  assert.equal(job?.resumeAction, undefined);
});

test('syncPendingStatusLabels 遇过期 revision 只清标记，不污染当前 Issue', async () => {
  const harness = makeWorkerHarness();
  const state = harness.core.state.snapshot();
  state.jobs['job-old'] = {
    jobId: 'job-old',
    reqId: 'REQ-A-01',
    issueNumber: 12,
    specHash: 'old-hash',
    sourceMainSha: '0'.repeat(40),
    attempt: 1,
    status: 'in-review',
    prNumber: 34,
    failureStage: 'sync-status-label',
    resumeAction: 'sync-status-label',
    startedAt: '',
    updatedAt: '',
  };
  await harness.core.state.update((s) => {
    s.jobs['job-old'] = state.jobs['job-old']!;
    return undefined;
  });

  await syncPendingStatusLabels(harness.core);

  assert.deepEqual(harness.ghCalls, []);
  const job = harness.core.state.snapshot().jobs['job-old'];
  assert.equal(job?.status, 'in-review');
  assert.equal(job?.failureStage, undefined);
  assert.equal(job?.resumeAction, undefined);
});

test('syncPendingStatusLabels 跳过被新基线取代的旧 Job，保留其恢复字段与时间', async () => {
  const harness = makeWorkerHarness();
  const old = {
    jobId: 'job-old',
    reqId: 'REQ-A-01',
    issueNumber: 12,
    specHash: 'h1',
    sourceMainSha: sourceSha,
    attempt: 1,
    status: 'failed' as const,
    failureStage: 'sync-status-label',
    resumeAction: 'sync-status-label',
    startedAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
  };
  const marker = structuredClone(old);
  await harness.core.state.update((s) => {
    s.jobs['job-old'] = { ...old };
    s.retryBaselines = {
      'retry-baseline-aaaaaaaaaaaaaaaaaaaaaaaa': {
        operationId: 'retry-baseline-aaaaaaaaaaaaaaaaaaaaaaaa',
        reqId: 'REQ-A-01',
        issueNumber: 12,
        specPath: 'docs/specs/REQ-A-01.md',
        specHash: 'h1',
        fromJobId: 'job-old',
        fromSourceMainSha: sourceSha,
        targetSourceMainSha: sourceSha,
        newJobId: 'retry-baseline-aaaaaaaaaaaaaaaaaaaaaaaa-job',
        attempt: 2,
        stage: 'stale',
        createdAt: '2026-11-17T00:00:00Z',
        updatedAt: '2026-11-17T00:00:00Z',
      },
    };
    return undefined;
  });
  await syncPendingStatusLabels(harness.core);
  assert.deepEqual(harness.ghCalls, []);
  assert.deepEqual(
    ((snapshot) => {
      const job = snapshot.jobs['job-old']!;
      return { failureStage: job.failureStage, resumeAction: job.resumeAction, updatedAt: job.updatedAt };
    })(harness.core.state.snapshot()),
    { failureStage: marker.failureStage, resumeAction: marker.resumeAction, updatedAt: marker.updatedAt },
  );
});

test('runOneWorkerForInput satisfied 结局持久化 candidateTreeSha 并同步标签/回执，不部署不关单', async () => {
  const harness = makeWorkerHarness();
  harness.setOutcome({ status: 'satisfied', candidateTreeSha: '9'.repeat(40) });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.deepEqual(outcome, { status: 'satisfied', candidateTreeSha: '9'.repeat(40) });
  assert.deepEqual(labelSequence(harness.ghCalls), [
    'remove:all',
    'add:pi-task+status:processing',
    'remove:all',
    'add:pi-task+status:satisfied',
  ]);
  const comments = harness.ghCalls.filter((call): call is Extract<GhCall, { kind: 'comment' }> => call.kind === 'comment');
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? '', /已验收无需代码变更/);
  assert.match(comments[0]?.body ?? '', new RegExp('9'.repeat(40)));
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'satisfied');
  assert.equal(job?.candidateTreeSha, '9'.repeat(40));
  assert.equal(job?.prNumber, undefined);
  assert.equal(job?.headSHA, undefined);
  assert.equal(job?.resumeAction, undefined);
  assert.equal(harness.core.state.snapshot().deploy.activeSha, null);
  assert.equal(
    harness.notifications.some((text) => text.includes('已验收无需代码变更')),
    true,
  );
});

test('runOneWorkerForInput satisfied 回执失败保留 satisfied 状态并标记待补，不重跑 Worker', async () => {
  const harness = makeWorkerHarness({ failLabel: 'status:satisfied' });
  harness.setOutcome({ status: 'satisfied', candidateTreeSha: '8'.repeat(40) });

  const outcome = await runOneWorkerForInput(harness.core, input(harness));

  assert.equal(outcome.status, 'satisfied');
  assert.equal(harness.workerInputs.length, 1);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'satisfied');
  assert.equal(job?.resumeAction, 'sync-satisfied-receipt');
});

test('satisfied 状态与待回执标志同次落盘，StateStore 重载后补回执且不重跑 Pi', async () => {
  const harness = makeWorkerHarness();
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-satisfied-reload-'));
  const file = join(dir, 'state.json');
  const initialState = makeState(requirementSpec());
  class CrashAfterSatisfiedPersistStore extends StateStore {
    crashes = 0;

    protected override persist(state: OrchestratorState): void {
      super.persist(state);
      const job = state.jobs['job-1'];
      if (job?.status === 'satisfied' && this.crashes === 0) {
        this.crashes += 1;
        throw new Error('模拟成功状态落盘后的进程崩溃');
      }
    }
  }
  const firstStore = new CrashAfterSatisfiedPersistStore(file, initialState);
  firstStore.load();
  await firstStore.update((s) => {
    s.jobs['job-1'] = {
      jobId: 'job-1',
      reqId: 'REQ-A-01',
      issueNumber: 12,
      specHash: 'h1',
      sourceMainSha: sourceSha,
      attempt: 1,
      status: 'processing',
      startedAt: '',
      updatedAt: '',
    };
    return undefined;
  });
  harness.core.state = firstStore;
  harness.setOutcome({ status: 'satisfied', candidateTreeSha: 'a'.repeat(40) });
  await assert.rejects(
    () => runOneWorkerForInput(harness.core, input(harness)),
    /模拟成功状态落盘后的进程崩溃/,
  );
  assert.equal(firstStore.crashes, 1);

  const secondStore = new StateStore(file);
  const persisted = secondStore.load();
  const job = persisted.jobs['job-1'];
  assert.equal(job?.status, 'satisfied');
  assert.equal(job?.resumeAction, 'sync-satisfied-receipt');
  assert.equal(job?.candidateTreeSha, 'a'.repeat(40));
  const workerRunsBeforeRecovery = harness.workerInputs.length;
  assert.equal(workerRunsBeforeRecovery, 1);
  harness.core.state = secondStore;
  await syncPendingSatisfiedReceipts(harness.core);
  assert.equal(harness.workerInputs.length, workerRunsBeforeRecovery);
  assert.equal(secondStore.load().jobs['job-1']?.resumeAction, undefined);
  assert.equal(harness.ghCalls.filter((c) => c.kind === 'comment').length, 1);
});

test('satisfied 评论响应丢失后重试不重复评论，完整 revision 幂等键保持不变', async () => {
  const harness = makeWorkerHarness();
  harness.setFailCommentAfterDelivery(true);
  harness.setOutcome({ status: 'satisfied', candidateTreeSha: 'b'.repeat(40) });
  await runOneWorkerForInput(harness.core, input(harness));
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.resumeAction, 'sync-satisfied-receipt');
  const comment = harness.ghCalls.find((c) => c.kind === 'comment');
  assert.match(comment?.body ?? '', /回执幂等键/);
  assert.match(comment?.body ?? '', /h1/);
  assert.match(comment?.body ?? '', new RegExp(sourceSha));
  assert.match(comment?.body ?? '', new RegExp('b'.repeat(40)));
  await syncPendingSatisfiedReceipts(harness.core);
  assert.equal(harness.workerInputs.length, 1);
  assert.equal(harness.ghCalls.filter((c) => c.kind === 'comment').length, 1);
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.resumeAction, undefined);
});

test('satisfied 非法候选树 fail closed，不发布 succeeded 终态', async () => {
  const harness = makeWorkerHarness();
  harness.setOutcome({ status: 'satisfied', candidateTreeSha: 'not-a-tree' });
  const outcome = await runOneWorkerForInput(harness.core, input(harness));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureStage, 'publish');
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.status, 'failed');
  assert.equal(harness.core.state.snapshot().jobs['job-1']?.candidateTreeSha, undefined);
  assert.equal(harness.ghCalls.some((c) => c.kind === 'comment' && c.body.includes('已验收')), false);
});

test('真实 Git：same-spec 主线漂移及远端读取失败禁止 satisfied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-satisfied-git-'));
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  const gitEnv = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const run = async (cwd: string, args: string[]): Promise<string> =>
    (await execFileAsync('git', args, { cwd, encoding: 'utf8', env: gitEnv })).stdout.trim();
  try {
    await run(root, ['init', '--bare', '--initial-branch=main', remote]);
    mkdirSync(join(source, 'docs', 'specs'), { recursive: true });
    mkdirSync(join(source, 'src'), { recursive: true });
    await run(source, ['init', '-b', 'main']);
    const doc = '### [REQ-CNT-01] 计数器\n\n递增并保留步长。\n';
    writeFileSync(join(source, 'docs', 'specs', 'counter.md'), doc, 'utf8');
    writeFileSync(join(source, 'README.md'), 'v1\n', 'utf8');
    writeFileSync(join(source, 'src', 'main.ts'), 'export const counter = 1;\n', 'utf8');
    await run(source, ['add', '.']);
    await run(source, ['commit', '-m', 'source']);
    await run(source, ['remote', 'add', 'origin', remote]);
    await run(source, ['push', '-u', 'origin', 'main']);
    const sourceSha = await run(source, ['rev-parse', 'HEAD']);
    const sourceTree = await run(source, ['rev-parse', 'HEAD^{tree}']);
    await run(root, ['clone', remote, checkout]);
    const git = new GitClient();
    const parsed = parseSpecs({ 'docs/specs/counter.md': doc }).specs[0]!;
    await run(root, ['-C', checkout, 'checkout', '-b', 'work', `origin/main`]);
    assert.equal(await checkSatisfiedRevisionCurrent(git, checkout, 'main', sourceSha, sourceTree), true);
    assert.equal(await checkSatisfiedRevisionCurrent(git, checkout, 'main', sourceSha, '0'.repeat(40)), false);

    writeFileSync(join(source, 'README.md'), 'v2 same spec\n', 'utf8');
    await run(source, ['add', 'README.md']);
    await run(source, ['commit', '-m', 'same-spec drift']);
    const driftSha = await run(source, ['rev-parse', 'HEAD']);
    const driftTree = await run(source, ['rev-parse', 'HEAD^{tree}']);
    await run(source, ['push']);
    await run(root, ['-C', checkout, 'fetch', 'origin', 'main']);
    await run(root, ['-C', checkout, 'checkout', '-B', 'work', 'origin/main']);
    assert.notEqual(driftSha, sourceSha);
    assert.notEqual(driftTree, sourceTree);
    assert.equal(
      parseSpecs({ 'docs/specs/counter.md': readFileSync(join(source, 'docs/specs/counter.md'), 'utf8') })
        .specs[0]?.hash,
      parsed.hash,
    );
    assert.equal(await checkSatisfiedRevisionCurrent(git, checkout, 'main', sourceSha, sourceTree), false);

    let gateStarted = false;
    const outcomePromise = runWorkerJob({
      repoDir: checkout,
      runDir: join(root, 'run'),
      git,
      github: {} as GithubClient,
      logger: silentLogger,
      runPi: async () => ({
        ok: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: { files: [] },
        durationMs: 0,
        timedOut: false,
      }),
      verify: async () => [{ name: 't', ok: true, code: 0, stdout: '', stderr: '' }],
      checkCurrent: async () => true,
      runBrowserGate: async () => {
        gateStarted = true;
        writeFileSync(join(source, 'README.md'), 'v3 browser race\n', 'utf8');
        await run(source, ['add', 'README.md']);
        await run(source, ['commit', '-m', 'browser race']);
        await run(source, ['push']);
        return {
          ok: true,
          detail: '浏览器验收通过',
          reportDir: join(root, 'report'),
          reportPath: join(root, 'report', 'results.json'),
          stdoutLogPath: join(root, 'report', 'stdout.txt'),
          stderrLogPath: join(root, 'report', 'stderr.txt'),
          suiteFingerprint: 'suite',
        };
      },
    }, {
      jobId: 'real-git-drift',
      reqId: 'REQ-CNT-01',
      issueNumber: 1,
      spec: { ...parsed, path: 'docs/specs/counter.md' },
      sourceMainSha: driftSha,
      attempt: 1,
    });
    const outcome = await outcomePromise;
    assert.equal(gateStarted, true);
    assert.equal(outcome.status, 'stale');
    assert.match(outcome.error ?? '', /来源主线或候选树已漂移/);

    await run(checkout, ['remote', 'set-url', 'origin', join(root, 'missing.git')]);
    await assert.rejects(
      () => checkSatisfiedRevisionCurrent(git, checkout, 'main', sourceSha, sourceTree),
      /git fetch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncPendingSatisfiedReceipts 补同步标签与回执且不重复评论', async () => {
  const harness = makeWorkerHarness({ failLabel: 'status:satisfied' });
  harness.setOutcome({ status: 'satisfied', candidateTreeSha: '7'.repeat(40) });
  await runOneWorkerForInput(harness.core, input(harness));
  const commentsBefore = harness.ghCalls.filter((call) => call.kind === 'comment').length;
  assert.equal(commentsBefore, 1);
  harness.setFailLabel(undefined);

  await syncPendingSatisfiedReceipts(harness.core);

  assert.deepEqual(harness.workerInputs.length, 1);
  const commentsAfter = harness.ghCalls.filter((call) => call.kind === 'comment').length;
  assert.equal(commentsAfter, 1);
  const job = harness.core.state.snapshot().jobs['job-1'];
  assert.equal(job?.status, 'satisfied');
  assert.equal(job?.resumeAction, undefined);
  assert.equal(
    labelSequence(harness.ghCalls).filter((call) => call.startsWith('add:')).at(-1),
    'add:pi-task+status:satisfied',
  );
});

test('syncPendingSatisfiedReceipts 遇旧 revision 只清标记，不污染当前 Issue', async () => {
  const harness = makeWorkerHarness();
  await harness.core.state.update((s) => {
    s.jobs['job-old-sat'] = {
      jobId: 'job-old-sat',
      reqId: 'REQ-A-01',
      issueNumber: 12,
      specHash: 'old-hash',
      sourceMainSha: '0'.repeat(40),
      attempt: 1,
      status: 'satisfied',
      candidateTreeSha: '0'.repeat(40),
      resumeAction: 'sync-satisfied-receipt',
      startedAt: '',
      updatedAt: '',
    };
    return undefined;
  });

  await syncPendingSatisfiedReceipts(harness.core);

  assert.deepEqual(harness.ghCalls, []);
  const job = harness.core.state.snapshot().jobs['job-old-sat'];
  assert.equal(job?.status, 'satisfied');
  assert.equal(job?.resumeAction, undefined);
});

test('createBuild 在沙箱前创建 outDir，注入版本资源 base 且不泄漏凭据 env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-build-'));
  const sha = '2'.repeat(40);
  const config = {
    repoDir: dir,
    runDir: join(dir, '.orchestrator'),
    buildTimeoutMs: 1000,
    piAgentDir: join(dir, '.orchestrator', 'agent'),
  } as Config;
  const git = {
    archive: async (_cwd: string, _sha: string, destDir: string) => {
      mkdirSync(destDir, { recursive: true });
    },
  } as unknown as GitClient;
  const runs: Array<{ cwd: string; env: Record<string, string> }> = [];

  const build = createBuild(
    config,
    git,
    async (_cmd, _args, opts) => {
      assert.equal(existsSync(join(config.runDir, 'releases', sha)), true);
      runs.push({ cwd: opts.cwd, env: opts.env });
      return { code: 0, stdout: 'ok', stderr: '' };
    },
    async () => ({
      ok: true,
      detail: '浏览器验收通过',
      reportDir: '/tmp/report',
      reportPath: '/tmp/report/results.json',
      stdoutLogPath: '/tmp/report/playwright.stdout.txt',
      stderrLogPath: '/tmp/report/playwright.stderr.txt',
    }),
  );
  const result = await build(sha);

  assert.deepEqual(result, { ok: true, detail: '构建成功' });
  assert.equal(runs.length, 3);
  assert.equal(runs[0]?.cwd, join(config.runDir, 'build', sha));
  assert.equal(runs[0]?.env.SPEC_LOOP_ASSET_BASE, `/releases/${sha}/`);
  assert.equal(runs[0]?.env.SPEC_LOOP_VERSION, sha);
  assert.equal(runs[0]?.env.HOME, join(config.runDir, 'tmp', sha));
  assert.equal(runs[0]?.env.GITHUB_TOKEN, undefined);
  assert.equal(runs[0]?.env.GH_TOKEN, undefined);
  assert.equal(runs[0]?.env.PI_PROVIDER, undefined);
  assert.equal(runs[0]?.env.PI_MODEL, undefined);
});

test('createBuild 浏览器验收失败时返回失败且不继续成功发布', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-build-fail-'));
  const sha = '3'.repeat(40);
  const config = {
    repoDir: dir,
    runDir: join(dir, '.orchestrator'),
    buildTimeoutMs: 1000,
    piAgentDir: join(dir, '.orchestrator', 'agent'),
  } as Config;
  const git = {
    archive: async (_cwd: string, _sha: string, destDir: string) => {
      mkdirSync(destDir, { recursive: true });
    },
  } as unknown as GitClient;

  const build = createBuild(
    config,
    git,
    async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    async () => ({
      ok: false,
      detail: 'Playwright 退出码 1；报告目录 /tmp/report；stdout /tmp/report/stdout；stderr /tmp/report/stderr',
      reportDir: '/tmp/report',
      reportPath: '/tmp/report/results.json',
      stdoutLogPath: '/tmp/report/stdout',
      stderrLogPath: '/tmp/report/stderr',
    }),
  );

  const result = await build(sha);
  assert.equal(result.ok, false);
  assert.match(result.detail, /浏览器验收失败/);
  assert.match(result.detail, /退出码 1/);
});

test('预览服务当前/历史版本同路径可用，并阻止非法 SHA 与 symlink 逃逸', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实 HTTP 集成测试仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试网络');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实 HTTP 测试但不降级为 mock');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-preview-'));
  const releases = join(dir, 'releases');
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  const releaseA = join(releases, shaA);
  const releaseB = join(releases, shaB);
  mkdirSync(join(releaseA, 'assets'), { recursive: true });
  mkdirSync(releaseB, { recursive: true });
  writeFileSync(
    join(releaseA, 'index.html'),
    `<script src="/releases/${shaA}/assets/app.js"></script>`,
  );
  writeFileSync(join(releaseA, 'assets', 'app.js'), 'export const version = 1;', 'utf8');
  writeFileSync(join(releaseB, 'index.html'), '<main>old</main>', 'utf8');
  const outside = join(dir, 'outside-secret.txt');
  writeFileSync(outside, 'secret', 'utf8');
  symlinkSync(outside, join(releaseA, 'escape.txt'));

  let active = { activeSha: shaA, releaseDir: releaseA };
  const server = createPreviewServer(() => active, silentLogger);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const status = async (pathname: string): Promise<number> => {
    const res = await fetch(origin + pathname, { redirect: 'manual' });
    await res.arrayBuffer();
    return res.status;
  };

  try {
    assert.equal(await status('/'), 200);
    assert.equal(await status('/__version'), 200);
    assert.equal(await status(`/releases/${shaA}/`), 200);
    assert.equal(await status(`/releases/${shaA}/assets/app.js`), 200);
    assert.equal(await status(`/releases/${shaB}/index.html`), 200);
    assert.equal(await status(`/releases/${shaA}`), 308);
    assert.equal(await status(`/releases/not-a-git-sha/index.html`), 404);
    assert.equal(await status(`/releases/${shaA}/escape.txt`), 403);

    active = { activeSha: shaB, releaseDir: releaseB };
    assert.equal(await status('/'), 200);
    assert.equal(await status(`/releases/${shaA}/assets/app.js`), 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('verifyReleaseOverHttp 使用 /releases/<sha>/ 同一路径验证候选资源', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实 HTTP 集成测试仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试网络');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实 HTTP 测试但不降级为 mock');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-release-http-'));
  const sha = 'c'.repeat(40);
  const release = join(dir, 'releases', sha);
  mkdirSync(join(release, 'assets'), { recursive: true });
  writeFileSync(join(release, 'index.html'), `<script src="/releases/${sha}/assets/app.js"></script>`, 'utf8');
  writeFileSync(join(release, 'assets', 'app.js'), 'ok', 'utf8');

  assert.equal(await verifyReleaseOverHttp(release, sha), true);
});
