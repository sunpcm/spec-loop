import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BrowserGateResult } from '../orchestrator/browser-gate.ts';
import { extractMeta, type GithubClient } from '../orchestrator/github.ts';
import type { GitClient } from '../orchestrator/git.ts';
import type { Logger } from '../orchestrator/log.ts';
import type { DispatchRevision, Spec } from '../orchestrator/types.ts';
import type { VerificationResult } from '../orchestrator/validate.ts';
import {
  buildWorkerBranchName,
  runWorkerJob,
  type WorkerDeps,
  type WorkerInput,
} from '../orchestrator/worker.ts';

const REQ_ID = 'REQ-CNT-01';
const ISSUE = 12;
const SPEC_HASH = 'a'.repeat(64);
const SOURCE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const TREE_SHA = 'd'.repeat(40);

const spec: Spec = {
  id: REQ_ID,
  title: '计数器翻倍',
  path: 'docs/specs/counter.md',
  body: 'REQ-CNT-01: 点击翻倍后保持原步长。',
  hash: SPEC_HASH,
};

const revision: DispatchRevision = {
  repoId: '123456',
  reqId: REQ_ID,
  issueNumber: ISSUE,
  revision: 2,
  specHash: SPEC_HASH,
  specPath: spec.path,
  sourceMainSha: SOURCE_SHA,
  task: {
    goal: '实现翻倍按钮并保留步长',
    steps: [{ text: '将当前值乘以 2', acceptanceRefs: ['A1'] }],
    acceptance: { A1: '当前值 3 翻倍后显示 6，随后按步长 2 增加显示 8。' },
    allowedPaths: ['src/**'],
    dependsOn: [],
  },
  publishedAt: '2026-11-21T08:00:00.000Z',
  publicationCommentId: 700,
};

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function okBrowserGate(): Promise<BrowserGateResult> {
  return Promise.resolve({
    ok: true,
    detail: '浏览器验收通过',
    reportDir: '/tmp/report',
    reportPath: '/tmp/report/results.json',
    stdoutLogPath: '/tmp/report/playwright.stdout.txt',
    stderrLogPath: '/tmp/report/playwright.stderr.txt',
  });
}

function workerInput(overrides: Partial<WorkerInput> = {}): WorkerInput {
  return {
    jobId: 'job-dispatch-worker',
    reqId: REQ_ID,
    issueNumber: ISSUE,
    spec,
    sourceMainSha: SOURCE_SHA,
    attempt: 1,
    dispatchRevision: structuredClone(revision),
    ...overrides,
  };
}

interface Harness {
  root: string;
  deps: WorkerDeps;
  input: WorkerInput;
  events: string[];
  prCalls: Array<{ title: string; body: string; head: string; base: string }>;
}

function makeHarness(options: {
  changed?: boolean;
  withDispatchChecker?: boolean;
  dispatchCurrent?: (() => boolean | Promise<boolean>) | undefined;
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-dispatch-worker-'));
  const repoDir = join(root, 'repo');
  const runDir = join(root, 'run');
  mkdirSync(repoDir, { recursive: true });
  const events: string[] = [];
  const prCalls: Harness['prCalls'] = [];
  const changed = options.changed ?? true;

  const git = {
    async createWorktree(_repo: string, workDir: string, _base: string, branch: string): Promise<void> {
      events.push(`createWorktree:${branch}`);
      mkdirSync(join(workDir, 'src'), { recursive: true });
      writeFileSync(join(workDir, 'src', 'counter.ts'), 'export let count = 0;\n', 'utf8');
    },
    async add(_workDir: string, paths: string[]): Promise<void> {
      events.push(`add:${paths.join(',')}`);
    },
    async diffNameOnly(): Promise<string[]> {
      return changed ? ['src/counter.ts'] : [];
    },
    async reset(): Promise<void> {
      events.push('reset');
    },
    async writeTree(): Promise<string> {
      return TREE_SHA;
    },
    async archive(_repo: string, _tree: string, target: string): Promise<void> {
      mkdirSync(target, { recursive: true });
    },
    async commit(): Promise<void> {
      events.push('commit');
    },
    async revParse(): Promise<string> {
      return HEAD_SHA;
    },
    async push(): Promise<void> {
      events.push('push');
    },
    async removeWorktree(): Promise<void> {
      events.push('removeWorktree');
    },
    async fetch(): Promise<void> {},
  } as unknown as GitClient;

  const github = {
    async createPR(title: string, body: string, head: string, base: string): Promise<number> {
      events.push('createPR');
      prCalls.push({ title, body, head, base });
      return 31;
    },
  } as unknown as GithubClient;

  const deps: WorkerDeps = {
    repoDir,
    runDir,
    git,
    github,
    logger: silentLogger,
    runPi: async () => ({
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: { files: [{ path: 'src/counter.ts', content: 'export const doubled = true;\n' }] },
      durationMs: 0,
      timedOut: false,
    }),
    verify: async (): Promise<VerificationResult[]> => [
      { name: 'test', ok: true, code: 0, stdout: '', stderr: '' },
    ],
    checkCurrent: async () => true,
    checkSatisfiedRevisionCurrent: async () => true,
    runBrowserGate: async () => {
      events.push('browserGate');
      return okBrowserGate();
    },
    notify: async () => {
      events.push('notify');
    },
  };
  if (options.withDispatchChecker !== false) {
    deps.checkDispatchCurrent = async () => {
      events.push('dispatchCheck');
      return options.dispatchCurrent ? options.dispatchCurrent() : true;
    };
  }

  return {
    root,
    deps,
    input: workerInput(),
    events,
    prCalls,
  };
}

test('Worker 分支名保留旧五参数格式，版本化作业追加冻结 rN 段', () => {
  const legacy = buildWorkerBranchName(REQ_ID, ISSUE, SPEC_HASH, SOURCE_SHA, 1);
  assert.equal(legacy, `pi/req-cnt-01-i12-r${SPEC_HASH.slice(0, 8)}-a1-s${SOURCE_SHA.slice(0, 8)}`);
  assert.equal(
    buildWorkerBranchName(REQ_ID, ISSUE, SPEC_HASH, SOURCE_SHA, 1, 2),
    `${legacy}-v2`,
  );
  assert.throws(() => buildWorkerBranchName(REQ_ID, ISSUE, SPEC_HASH, SOURCE_SHA, 1, 0), /正整数/);
});

test('版本化作业缺少 checkDispatchCurrent 时 fail closed，不启动 Pi', async (t) => {
  const harness = makeHarness({ withDispatchChecker: false });
  t.after(() => rmSync(harness.root, { recursive: true, force: true }));
  let piCalls = 0;
  harness.deps.runPi = async () => {
    piCalls += 1;
    throw new Error('不应启动');
  };

  const outcome = await runWorkerJob(harness.deps, harness.input);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureStage, 'publish');
  assert.match(outcome.error ?? '', /缺少 checkDispatchCurrent/);
  assert.equal(piCalls, 0);
  assert.deepEqual(harness.events, []);
});

test('首次与修复提示都携带冻结任务、原规格、固定来源和源码快照', async (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const prompts: string[] = [];
  harness.deps.runPi = async (invocation) => {
    prompts.push(invocation.prompt);
    if (prompts.length === 1) {
      return {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: '首次输出格式错误',
        output: undefined,
        durationMs: 0,
        timedOut: false,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: { files: [{ path: 'src/counter.ts', content: 'export const doubled = true;\n' }] },
      durationMs: 0,
      timedOut: false,
    };
  };

  const outcome = await runWorkerJob(harness.deps, harness.input);
  assert.equal(outcome.status, 'published');
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /## 冻结派工（唯一实施依据）/);
    assert.match(prompt, /实现翻倍按钮并保留步长/);
    assert.match(prompt, /当前值 3 翻倍后显示 6/);
    assert.match(prompt, /## 原规格（同版完整需求块）/);
    assert.match(prompt, /REQ-CNT-01: 点击翻倍后保持原步长。/);
    assert.match(prompt, new RegExp(SOURCE_SHA));
    assert.match(prompt, /export let count = 0;/);
  }
  assert.match(prompts[1]!, /## 上一次尝试失败摘要/);
});

test('版本化发布在每个外部动作前重查，PR 带独立分支和完整冻结元数据', async (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const checkedRevisions: DispatchRevision[] = [];
  harness.deps.checkDispatchCurrent = async (candidate) => {
    harness.events.push('dispatchCheck');
    checkedRevisions.push(structuredClone(candidate));
    return true;
  };

  const outcome = await runWorkerJob(harness.deps, harness.input);
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.prNumber, 31);
  assert.equal(outcome.headSHA, HEAD_SHA);

  const expectedBranch = `${buildWorkerBranchName(REQ_ID, ISSUE, SPEC_HASH, SOURCE_SHA, 1)}-v2`;
  assert.equal(outcome.branch, expectedBranch);
  assert.equal(harness.prCalls.length, 1);
  const pr = harness.prCalls[0]!;
  assert.equal(pr.head, expectedBranch);
  assert.deepEqual(checkedRevisions, checkedRevisions.map(() => revision));

  const meta = extractMeta(pr.body);
  assert.ok(meta);
  assert.equal(meta.repoId, revision.repoId);
  assert.equal(meta.issueNumber, ISSUE);
  assert.equal(meta.dispatchRevision, revision.revision);
  assert.equal(meta.reqId, REQ_ID);
  assert.equal(meta.specPath, spec.path);
  assert.equal(meta.specHash, SPEC_HASH);
  assert.equal(meta.sourceMainSha, SOURCE_SHA);
  assert.match(String(meta.operationKey), /:dispatch:r2$/);
  assert.match(pr.body, /派工版本：`r2`/);

  const commitIndex = harness.events.indexOf('commit');
  const pushIndex = harness.events.indexOf('push');
  const prIndex = harness.events.indexOf('createPR');
  const notifyIndex = harness.events.indexOf('notify');
  assert.ok(commitIndex > 0);
  assert.equal(harness.events[commitIndex - 1], 'dispatchCheck');
  assert.equal(harness.events[pushIndex - 1], 'dispatchCheck');
  assert.equal(harness.events[prIndex - 1], 'dispatchCheck');
  assert.equal(harness.events[notifyIndex - 1], 'dispatchCheck');
});

test('提交后版本变化返回 stale，不推送也不创建 PR', async (t) => {
  const harness = makeHarness({
    dispatchCurrent: () => !harness.events.includes('commit'),
  });
  t.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const outcome = await runWorkerJob(harness.deps, harness.input);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.branch, `${buildWorkerBranchName(REQ_ID, ISSUE, SPEC_HASH, SOURCE_SHA, 1)}-v2`);
  assert.equal(outcome.headSHA, HEAD_SHA);
  assert.match(outcome.error ?? '', /推送前已不是当前版本/);
  assert.ok(harness.events.includes('commit'));
  assert.ok(!harness.events.includes('push'));
  assert.ok(!harness.events.includes('createPR'));
});

test('无代码变更在返回 satisfied 前也必须核对冻结版本', async (t) => {
  let checks = 0;
  const harness = makeHarness({
    changed: false,
    dispatchCurrent: () => {
      checks += 1;
      return checks < 3;
    },
  });
  t.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const outcome = await runWorkerJob(harness.deps, harness.input);
  assert.equal(outcome.status, 'stale');
  assert.match(outcome.error ?? '', /发布或确认无变更前已不是当前版本/);
  assert.ok(!harness.events.includes('commit'));
  assert.ok(!harness.events.includes('push'));
  assert.ok(!harness.events.includes('createPR'));
});

test('冻结 allowedPaths 是 src 之上的额外写入上限', async (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.root, { recursive: true, force: true }));
  harness.input.dispatchRevision = {
    ...structuredClone(revision),
    task: { ...structuredClone(revision.task), allowedPaths: ['src/allowed.ts'] },
  };

  const outcome = await runWorkerJob(harness.deps, harness.input);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureStage, 'write');
  assert.match(outcome.error ?? '', /超出冻结任务 allowedPaths/);
  assert.ok(!harness.events.includes('browserGate'));
  assert.ok(!harness.events.includes('commit'));
});
