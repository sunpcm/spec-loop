import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildBrowserGateEnv,
  parseE2eContract,
  readCandidateSpecFile,
  runBrowserGate,
  verifyPanelAcceptanceCoverage,
  type BrowserGateOptions,
  type BrowserGateResult,
  type BrowserGateRunnerResult,
} from '../orchestrator/browser-gate.ts';
import {
  readPanelArtifactVersion,
  resolveBrowserGateCliPlan,
} from '../orchestrator/browser-gate-cli.ts';
import type { GitClient } from '../orchestrator/git.ts';
import type { GithubClient } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import type { DispatchRevision } from '../orchestrator/types.ts';
import { assertNoSymlinkRoot, type VerificationResult } from '../orchestrator/validate.ts';
import { runWorkerJob, type WorkerDeps, type WorkerInput } from '../orchestrator/worker.ts';

const SILENT_LOGGER: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const COUNTER_PATH = 'docs/specs/counter.md';
const PANEL_REQ_ID = 'REQ-PANEL-01';
const PANEL_SPEC_PATH = 'docs/specs/pending/panel.md';
const PANEL_SOURCE_SHA = '1'.repeat(40);
const PANEL_HEAD_SHA = '2'.repeat(40);
const PANEL_TREE_SHA = '3'.repeat(40);

const COUNTER_BODY = `# 计数器规格

### [REQ-CNT-01] 计数器翻倍

#### 功能

- 点击后翻倍。
`;

const PANEL_SPEC_BODY = `# 面板规格

### [REQ-PANEL-01] 面板交付

#### 功能

- 展示受控流程。

#### 验收

- A1 展示当前流程。
- A2 展示节点详情。
`;

function specHashOf(content: string, path: string, reqId: string): string {
  const parsed = parseSpecs({ [path]: content });
  assert.deepEqual(parsed.errors, []);
  const spec = parsed.specs.find((candidate) => candidate.id === reqId);
  assert.ok(spec, `未找到 ${reqId}`);
  return spec.hash;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'spec-loop-framework-delivery-'));
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function panelRevision(specHash: string): DispatchRevision {
  return {
    repoId: '9001',
    reqId: PANEL_REQ_ID,
    revision: 1,
    issueNumber: 1901,
    specHash,
    specPath: PANEL_SPEC_PATH,
    sourceMainSha: PANEL_SOURCE_SHA,
    task: {
      goal: '实现面板交付',
      steps: [{ text: '实现面板', acceptanceRefs: ['A1', 'A2'] }],
      acceptance: { A1: '展示当前流程。', A2: '展示节点详情。' },
      allowedPaths: ['panel/src/**'],
      dependsOn: [],
    },
    publishedAt: '2026-11-23T00:00:00.000Z',
    publicationCommentId: 701,
  };
}

function okBrowserGate(): BrowserGateResult {
  return {
    ok: true,
    detail: '浏览器验收通过',
    reportDir: '/tmp/report',
    reportPath: '/tmp/report/results.json',
    stdoutLogPath: '/tmp/report/playwright.stdout.txt',
    stderrLogPath: '/tmp/report/playwright.stderr.txt',
    productBinding: 'bound',
  };
}

function writeE2eFixture(
  root: string,
  project: 'counter' | 'panel',
  contract: Record<string, unknown>,
): void {
  mkdirSync(join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
  mkdirSync(join(root, 'tests', 'e2e', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '@playwright', 'test', 'cli.js'), '// fake cli\n', 'utf8');
  writeFileSync(join(root, 'playwright.config.ts'), 'export default {};\n', 'utf8');
  writeFileSync(
    join(root, 'tests', 'e2e', 'contracts', `${project}.json`),
    JSON.stringify(contract),
    'utf8',
  );
}

function playwrightReport(caseIds: string[], project: 'counter' | 'panel'): unknown {
  return {
    errors: [],
    suites: [
      {
        title: `${project}.spec.ts`,
        file: `${project}.spec.ts`,
        specs: caseIds.map((caseId) => ({
          title: `${caseId} 自动验收`,
          ok: true,
          tests: [
            {
              expectedStatus: 'passed',
              projectName: project,
              status: 'expected',
              results: [{ status: 'passed', retry: 0, duration: 1 }],
            },
          ],
        })),
      },
    ],
    stats: { expected: caseIds.length, unexpected: 0, skipped: 0, flaky: 0 },
  };
}

async function loopbackListenAvailable(): Promise<boolean> {
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

function panelInput(): WorkerInput {
  return {
    jobId: 'job-panel',
    reqId: PANEL_REQ_ID,
    issueNumber: 1901,
    spec: {
      id: PANEL_REQ_ID,
      title: '面板',
      path: PANEL_SPEC_PATH,
      body: '面板需求正文',
      hash: '2'.repeat(64),
    },
    sourceMainSha: '1'.repeat(40),
    attempt: 1,
  };
}

test('readCandidateSpecFile 按冻结身份读取精确路径整份文件', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, COUNTER_PATH), COUNTER_BODY, 'utf8');
    const hash = specHashOf(COUNTER_BODY, COUNTER_PATH, 'REQ-CNT-01');
    assert.deepEqual(readCandidateSpecFile(root, {
      reqId: 'REQ-CNT-01',
      specPath: COUNTER_PATH,
      specHash: hash,
    }), { [COUNTER_PATH]: COUNTER_BODY });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCandidateSpecFile 候选缺失返回空，交由真实门禁 fail closed', () => {
  const root = tempRoot();
  try {
    assert.deepEqual(readCandidateSpecFile(root, {
      reqId: 'REQ-CNT-01',
      specPath: COUNTER_PATH,
      specHash: '1'.repeat(64),
    }), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCandidateSpecFile 符号链接规格 fail closed', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'outside.md'), COUNTER_BODY, 'utf8');
    symlinkSync(join(root, 'outside.md'), join(root, COUNTER_PATH), 'file');
    assert.throws(
      () => readCandidateSpecFile(root, {
        reqId: 'REQ-CNT-01',
        specPath: COUNTER_PATH,
        specHash: specHashOf(COUNTER_BODY, COUNTER_PATH, 'REQ-CNT-01'),
      }),
      /普通文件|符号链接/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCandidateSpecFile 父目录符号链接 fail closed', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'outside', 'specs'), { recursive: true });
    writeFileSync(join(root, 'outside', 'specs', 'counter.md'), COUNTER_BODY, 'utf8');
    symlinkSync(join(root, 'outside'), join(root, 'docs'), 'dir');
    assert.throws(
      () => readCandidateSpecFile(root, {
        reqId: 'REQ-CNT-01',
        specPath: COUNTER_PATH,
        specHash: specHashOf(COUNTER_BODY, COUNTER_PATH, 'REQ-CNT-01'),
      }),
      /符号链接/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCandidateSpecFile 哈希不符 fail closed', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, COUNTER_PATH), COUNTER_BODY, 'utf8');
    assert.throws(
      () => readCandidateSpecFile(root, {
        reqId: 'REQ-CNT-01',
        specPath: COUNTER_PATH,
        specHash: '0'.repeat(64),
      }),
      /不一致|哈希|身份/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCandidateSpecFile 拒绝路径穿越', () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => readCandidateSpecFile(root, {
        reqId: 'REQ-CNT-01',
        specPath: '../../etc/passwd',
        specHash: '1'.repeat(64),
      }),
      /非法/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertNoSymlinkRoot 拒绝符号链接源码根', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'real-src'), { recursive: true });
    symlinkSync(join(root, 'real-src'), join(root, 'src'), 'dir');
    assert.throws(() => assertNoSymlinkRoot(root, 'src'), /符号链接/);
    mkdirSync(join(root, 'real-panel'), { recursive: true });
    symlinkSync(join(root, 'real-panel'), join(root, 'panel'), 'dir');
    assert.throws(() => assertNoSymlinkRoot(root, 'panel/src'), /符号链接/);
    rmSync(join(root, 'panel'));
    mkdirSync(join(root, 'panel'), { recursive: true });
    symlinkSync(join(root, 'real-panel'), join(root, 'panel', 'src'), 'dir');
    assert.throws(() => assertNoSymlinkRoot(root, 'panel/src'), /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertNoSymlinkRoot 接受普通源码目录，缺失不报错', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'panel', 'src'), { recursive: true });
    assert.doesNotThrow(() => assertNoSymlinkRoot(root, 'panel/src'));
    assert.doesNotThrow(() => assertNoSymlinkRoot(root, 'src'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runWorkerJob 面板需求缺少 PanelBinding 在创建 worktree/模型前失败', async () => {
  const deps = { logger: SILENT_LOGGER } as unknown as WorkerDeps;
  const outcome = await runWorkerJob(deps, panelInput());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureStage, 'plan');
  assert.match(outcome.error ?? '', /PanelBinding/);
});

test('runWorkerJob 面板需求有绑定但缺少冻结派工版本在创建 worktree/模型前失败', async () => {
  const deps = {
    logger: SILENT_LOGGER,
    panelBinding: {
      repo: 'sunpcm/spec-loop',
      mainBranch: 'main',
      repositoryId: 'github-repository-id:9001',
      issueNumber: 1901,
      confirmedMainSha: '1'.repeat(40),
      specHash: '2'.repeat(64),
    },
  } as unknown as WorkerDeps;
  const outcome = await runWorkerJob(deps, panelInput());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureStage, 'plan');
  assert.match(outcome.error ?? '', /冻结派工版本/);
});

test('verifyPanelAcceptanceCoverage 要求 A1..An 键集合精确相等且允许跨验收复用 caseId', () => {
  const specHash = specHashOf(PANEL_SPEC_BODY, PANEL_SPEC_PATH, PANEL_REQ_ID);
  const files = { [PANEL_SPEC_PATH]: PANEL_SPEC_BODY };
  const contract = parseE2eContract({
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash,
    caseIds: ['PANEL-CASE-1', 'PANEL-CASE-SHARED', 'PANEL-CASE-EXTRA'],
    acceptanceCases: {
      A1: ['PANEL-CASE-1'],
      A2: ['PANEL-CASE-SHARED'],
    },
  }, 'panel');
  assert.throws(
    () => parseE2eContract({
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash,
      caseIds: ['PANEL-CASE-1', 'PANEL-CASE-SHARED'],
      acceptanceCases: { A1: ['PANEL-CASE-1'], A2: ['PANEL-CASE-SHARED', 'PANEL-CASE-SHARED'] },
    }, 'panel'),
    /重复/,
  );

  const valid = parseE2eContract({
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash,
    caseIds: ['PANEL-CASE-SHARED'],
    acceptanceCases: { A1: ['PANEL-CASE-SHARED'], A2: ['PANEL-CASE-SHARED'] },
  }, 'panel');
  assert.equal(verifyPanelAcceptanceCoverage(valid, files, PANEL_REQ_ID).ok, true);

  const extra = parseE2eContract({
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash,
    caseIds: ['PANEL-CASE-1', 'PANEL-CASE-2', 'PANEL-CASE-EXTRA'],
    acceptanceCases: {
      A1: ['PANEL-CASE-1'],
      A2: ['PANEL-CASE-2'],
      A3: ['PANEL-CASE-EXTRA'],
    },
  }, 'panel');
  const extraResult = verifyPanelAcceptanceCoverage(extra, files, PANEL_REQ_ID);
  assert.equal(extraResult.ok, false);
  assert.match(extraResult.detail, /多余 \[A3\]/);

  const missing = parseE2eContract({
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash,
    caseIds: ['PANEL-CASE-1'],
    acceptanceCases: { A1: ['PANEL-CASE-1'] },
  }, 'panel');
  const missingResult = verifyPanelAcceptanceCoverage(missing, files, PANEL_REQ_ID);
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.detail, /缺失 \[A2\]/);

  const discontinuous = parseE2eContract({
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash,
    caseIds: ['PANEL-CASE-1', 'PANEL-CASE-EXTRA'],
    acceptanceCases: { A1: ['PANEL-CASE-1'], A3: ['PANEL-CASE-EXTRA'] },
  }, 'panel');
  const discontinuousResult = verifyPanelAcceptanceCoverage(discontinuous, files, PANEL_REQ_ID);
  assert.equal(discontinuousResult.ok, false);
  assert.match(discontinuousResult.detail, /缺失 \[A2\].*多余 \[A3\]/);
});

test('buildBrowserGateEnv 将完整门禁身份注入受控子进程环境', () => {
  const env = buildBrowserGateEnv({
    jobTmp: '/job',
    reportDir: '/job/report',
    baseUrl: 'http://127.0.0.1:4321/',
    version: 'release-v1',
    browserCacheDir: '/browsers',
    video: 'retain-on-failure',
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash: 'a'.repeat(64),
    dispatchRevision: 7,
    sourceMainSha: PANEL_SOURCE_SHA,
    candidateTreeSha: PANEL_TREE_SHA,
    jobId: 'job-env',
  });
  assert.equal(env.SPEC_LOOP_E2E_REQ_ID, PANEL_REQ_ID);
  assert.equal(env.SPEC_LOOP_E2E_SPEC_PATH, PANEL_SPEC_PATH);
  assert.equal(env.SPEC_LOOP_E2E_SPEC_HASH, 'a'.repeat(64));
  assert.equal(env.SPEC_LOOP_E2E_DISPATCH_REVISION, '7');
  assert.equal(env.SPEC_LOOP_E2E_SOURCE_MAIN_SHA, PANEL_SOURCE_SHA);
  assert.equal(env.SPEC_LOOP_E2E_CANDIDATE_TREE_SHA, PANEL_TREE_SHA);
  assert.equal(env.SPEC_LOOP_E2E_JOB_ID, 'job-env');
});

test('面板 CLI 严格读取 version.json，并从真实 Git 归档读取精确 pending/panel.md', async () => {
  const root = tempRoot();
  const repoDir = join(root, 'repo');
  const artifactDir = join(root, 'panel-dist');
  const jobRoot = join(root, 'jobs');
  const browserCacheDir = join(root, 'browsers');
  try {
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(jobRoot, { recursive: true });
    mkdirSync(browserCacheDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), '<!doctype html><title>panel</title>', 'utf8');
    git(['init', '--initial-branch=main', '.'], repoDir);
    git(['config', 'user.name', 'Spec Loop Test'], repoDir);
    git(['config', 'user.email', 'spec-loop@example.invalid'], repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# fixture\n', 'utf8');
    git(['add', 'README.md'], repoDir);
    git(['commit', '-m', 'without panel requirement'], repoDir);
    const withoutPanelSha = git(['rev-parse', 'HEAD'], repoDir);
    writeFileSync(
      join(artifactDir, 'version.json'),
      `${JSON.stringify({ version: withoutPanelSha }, null, 2)}\n`,
      'utf8',
    );

    const unbound = await resolveBrowserGateCliPlan('panel', {
      repoDir,
      env: { SPEC_LOOP_OUT_DIR: artifactDir },
      jobTmpRoot: jobRoot,
      browserCacheDir,
      evidenceJobId: 'manual-unbound',
    });
    assert.equal(unbound.version, withoutPanelSha);
    assert.equal(unbound.productBinding, 'unbound-product-smoke');
    assert.deepEqual(unbound.specFiles, {});
    assert.equal(unbound.specHash, undefined);
    assert.equal(unbound.jobId, 'manual-unbound');
    if (unbound.archiveDir) rmSync(unbound.archiveDir, { recursive: true, force: true });

    const unavailableSha = 'f'.repeat(40);
    writeFileSync(
      join(artifactDir, 'version.json'),
      `${JSON.stringify({ version: unavailableSha }, null, 2)}\n`,
      'utf8',
    );
    const unavailable = await resolveBrowserGateCliPlan('panel', {
      repoDir,
      env: { SPEC_LOOP_OUT_DIR: artifactDir },
      jobTmpRoot: jobRoot,
      browserCacheDir,
      evidenceJobId: 'manual-unavailable',
    });
    assert.equal(unavailable.version, unavailableSha);
    assert.equal(unavailable.productBinding, 'unbound-product-smoke');
    assert.deepEqual(unavailable.specFiles, {});
    assert.equal(unavailable.specHash, undefined);

    mkdirSync(join(repoDir, 'docs', 'specs', 'pending'), { recursive: true });
    writeFileSync(join(repoDir, ...PANEL_SPEC_PATH.split('/')), PANEL_SPEC_BODY, 'utf8');
    git(['add', PANEL_SPEC_PATH], repoDir);
    git(['commit', '-m', 'add panel requirement'], repoDir);
    const boundSha = git(['rev-parse', 'HEAD'], repoDir);
    writeFileSync(
      join(artifactDir, 'version.json'),
      `${JSON.stringify({ version: boundSha }, null, 2)}\n`,
      'utf8',
    );
    assert.equal(readPanelArtifactVersion(artifactDir), boundSha);

    const bound = await resolveBrowserGateCliPlan('panel', {
      repoDir,
      env: { SPEC_LOOP_OUT_DIR: artifactDir },
      jobTmpRoot: jobRoot,
      browserCacheDir,
      evidenceJobId: 'manual-bound',
    });
    assert.equal(bound.version, boundSha);
    assert.equal(bound.productBinding, 'bound');
    assert.equal(bound.specFiles[PANEL_SPEC_PATH], PANEL_SPEC_BODY);
    assert.equal(bound.specHash, specHashOf(PANEL_SPEC_BODY, PANEL_SPEC_PATH, PANEL_REQ_ID));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('面板 CLI version.json 缺失、坏 JSON、空版本与符号链接都 fail closed', () => {
  const root = tempRoot();
  const artifactDir = join(root, 'panel-dist');
  try {
    mkdirSync(artifactDir, { recursive: true });
    assert.throws(() => readPanelArtifactVersion(artifactDir), /缺少 version\.json/);
    writeFileSync(join(artifactDir, 'version.json'), '{bad json', 'utf8');
    assert.throws(() => readPanelArtifactVersion(artifactDir), /有效 JSON/);
    writeFileSync(join(artifactDir, 'version.json'), '{"version":""}', 'utf8');
    assert.throws(() => readPanelArtifactVersion(artifactDir), /非空 version/);
    writeFileSync(join(root, 'outside.json'), '{"version":"outside"}', 'utf8');
    rmSync(join(artifactDir, 'version.json'));
    symlinkSync(join(root, 'outside.json'), join(artifactDir, 'version.json'));
    assert.throws(() => readPanelArtifactVersion(artifactDir), /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runBrowserGate 绑定面板强制验收映射并把身份写入证据，未绑定 smoke 仅手动通过', async (t) => {
  if (!(await loopbackListenAvailable())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen，保留真实门禁测试供主验收执行');
    return;
  }
  const root = tempRoot();
  try {
    const repoDir = join(root, 'repo');
    const e2eRoot = join(root, 'e2e');
    const artifactDir = join(root, 'artifact');
    const browserCacheDir = join(root, 'browsers');
    const testRunsRoot = join(root, 'test-runs');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(browserCacheDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), '<main>panel</main>', 'utf8');
    const specHash = specHashOf(PANEL_SPEC_BODY, PANEL_SPEC_PATH, PANEL_REQ_ID);
    const caseIds = ['PANEL-CASE-1', 'PANEL-CASE-2'];
    const boundContract = {
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash,
      caseIds,
      acceptanceCases: { A1: [caseIds[0]], A2: [caseIds[1]] },
    };
    writeE2eFixture(e2eRoot, 'panel', boundContract);
    let runnerEnv: Record<string, string> = {};
    const result = await runBrowserGate({
      repoDir,
      e2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'release-r7',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      dispatchRevision: 7,
      specFiles: { [PANEL_SPEC_PATH]: PANEL_SPEC_BODY },
      jobTmp: join(root, 'job-bound'),
      browserCacheDir,
      logger: SILENT_LOGGER,
      execBin: process.execPath,
      testRunsRoot,
      evidenceStage: 'manual',
      jobId: 'job-bound',
      sourceMainSha: PANEL_SOURCE_SHA,
      candidateTreeSha: PANEL_TREE_SHA,
      requireProductBinding: true,
      runner: async (opts): Promise<BrowserGateRunnerResult> => {
        runnerEnv = opts.env;
        const reportDir = opts.env.SPEC_LOOP_E2E_REPORT_DIR!;
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(join(reportDir, 'results.json'), JSON.stringify(playwrightReport(caseIds, 'panel')), 'utf8');
        return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.productBinding, 'bound');
    assert.equal(runnerEnv.SPEC_LOOP_E2E_REQ_ID, PANEL_REQ_ID);
    assert.equal(runnerEnv.SPEC_LOOP_E2E_SPEC_PATH, PANEL_SPEC_PATH);
    assert.equal(runnerEnv.SPEC_LOOP_E2E_SPEC_HASH, specHash);
    assert.equal(runnerEnv.SPEC_LOOP_E2E_DISPATCH_REVISION, '7');
    assert.equal(runnerEnv.SPEC_LOOP_E2E_SOURCE_MAIN_SHA, PANEL_SOURCE_SHA);
    assert.equal(runnerEnv.SPEC_LOOP_E2E_CANDIDATE_TREE_SHA, PANEL_TREE_SHA);
    assert.equal(runnerEnv.SPEC_LOOP_E2E_JOB_ID, 'job-bound');
    assert.equal(result.testRunRecord?.reqId, PANEL_REQ_ID);
    assert.equal(result.testRunRecord?.specPath, PANEL_SPEC_PATH);
    assert.equal(result.testRunRecord?.specHash, specHash);
    assert.equal(result.testRunRecord?.dispatchRevision, 7);
    assert.equal(result.testRunRecord?.sourceMainSha, PANEL_SOURCE_SHA);
    assert.equal(result.testRunRecord?.candidateTreeSha, PANEL_TREE_SHA);
    const receipt = JSON.parse(readFileSync(result.receiptPath!, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.productBinding, 'bound');
    assert.equal(receipt.specPath, PANEL_SPEC_PATH);
    assert.equal(receipt.dispatchRevision, 7);
    assert.equal(receipt.jobId, 'job-bound');

    const unboundContract = { caseIds };
    writeE2eFixture(e2eRoot, 'panel', unboundContract);
    const unbound = await runBrowserGate({
      repoDir,
      e2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-local',
      project: 'panel',
      specFiles: {},
      jobTmp: join(root, 'job-unbound'),
      browserCacheDir,
      logger: SILENT_LOGGER,
      execBin: process.execPath,
      testRunsRoot,
      evidenceStage: 'manual',
      jobId: 'job-unbound',
      unboundProductSmoke: true,
      runner: async (opts): Promise<BrowserGateRunnerResult> => {
        const reportDir = opts.env.SPEC_LOOP_E2E_REPORT_DIR!;
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(join(reportDir, 'results.json'), JSON.stringify(playwrightReport(caseIds, 'panel')), 'utf8');
        return { code: 0, stdout: 'smoke ok', stderr: '', timedOut: false };
      },
    });
    assert.equal(unbound.ok, true, unbound.detail);
    assert.equal(unbound.productBinding, 'unbound-product-smoke');
    assert.equal(unbound.testRunRecord?.reqId, null);
    assert.equal(unbound.testRunRecord?.specPath, null);
    assert.equal(unbound.testRunRecord?.specHash, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('面板业务门禁缺少 acceptanceCases 时在启动 Playwright 前拒绝', async () => {
  const root = tempRoot();
  try {
    const repoDir = join(root, 'repo');
    const e2eRoot = join(root, 'e2e');
    const artifactDir = join(root, 'artifact');
    const browserCacheDir = join(root, 'browsers');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(browserCacheDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), '<main>panel</main>', 'utf8');
    const specHash = specHashOf(PANEL_SPEC_BODY, PANEL_SPEC_PATH, PANEL_REQ_ID);
    writeE2eFixture(e2eRoot, 'panel', {
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash,
      caseIds: ['PANEL-CASE-1'],
    });
    let runnerCalled = false;
    const result = await runBrowserGate({
      repoDir,
      e2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'release-r7',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specFiles: { [PANEL_SPEC_PATH]: PANEL_SPEC_BODY },
      jobTmp: join(root, 'job'),
      browserCacheDir,
      logger: SILENT_LOGGER,
      execBin: process.execPath,
      evidenceStage: 'manual',
      requireProductBinding: true,
      runner: async () => {
        runnerCalled = true;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /acceptanceCases/);
    assert.equal(runnerCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Worker 面板门禁与 node:test 证据携带完整派工身份', async () => {
  const root = tempRoot();
  try {
    const repoDir = join(root, 'repo');
    const runDir = join(root, 'run');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const specHash = specHashOf(PANEL_SPEC_BODY, PANEL_SPEC_PATH, PANEL_REQ_ID);
    const revision = panelRevision(specHash);
    const input: WorkerInput = {
      jobId: 'job-panel-delivery',
      reqId: PANEL_REQ_ID,
      issueNumber: 1901,
      spec: {
        id: PANEL_REQ_ID,
        title: '面板交付',
        path: PANEL_SPEC_PATH,
        body: PANEL_SPEC_BODY,
        hash: specHash,
      },
      sourceMainSha: PANEL_SOURCE_SHA,
      attempt: 1,
      dispatchRevision: revision,
    };
    let gateOptions: BrowserGateOptions | undefined;
    const git = {
      async createWorktree(_repo: string, workDir: string): Promise<void> {
        mkdirSync(join(workDir, 'panel', 'src'), { recursive: true });
        writeFileSync(join(workDir, 'panel', 'src', 'App.tsx'), 'export const value = 0;\n', 'utf8');
      },
      async add(): Promise<void> {},
      async diffNameOnly(): Promise<string[]> {
        return ['panel/src/App.tsx'];
      },
      async reset(): Promise<void> {},
      async writeTree(): Promise<string> {
        return PANEL_TREE_SHA;
      },
      async archive(_repo: string, _tree: string, target: string): Promise<void> {
        mkdirSync(join(target, 'docs', 'specs', 'pending'), { recursive: true });
        writeFileSync(join(target, ...PANEL_SPEC_PATH.split('/')), PANEL_SPEC_BODY, 'utf8');
        mkdirSync(join(target, 'dist'), { recursive: true });
        writeFileSync(join(target, 'dist', 'index.html'), '<main>panel</main>', 'utf8');
      },
      async commit(): Promise<void> {},
      async revParse(): Promise<string> {
        return PANEL_HEAD_SHA;
      },
      async push(): Promise<void> {},
      async removeWorktree(): Promise<void> {},
    } as unknown as GitClient;
    const github = {
      async createPR(): Promise<number> {
        return 77;
      },
    } as unknown as GithubClient;
    const verification: VerificationResult[] = [{
      name: 'test',
      ok: true,
      code: 0,
      stdout: 'ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1.0\n',
      stderr: '',
    }];
    const outcome = await runWorkerJob({
      repoDir,
      runDir,
      git,
      github,
      logger: SILENT_LOGGER,
      panelBinding: {
        repo: 'sunpcm/spec-loop',
        mainBranch: 'main',
        repositoryId: 'github-repository-id:9001',
        issueNumber: 1901,
        confirmedMainSha: PANEL_SOURCE_SHA,
        specHash,
      },
      runPi: async () => ({
        ok: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: { files: [{ path: 'panel/src/App.tsx', content: 'export const value = 1;\n' }] },
        durationMs: 0,
        timedOut: false,
      }),
      verify: async () => verification,
      checkCurrent: async () => true,
      checkDispatchCurrent: async () => true,
      runBrowserGate: async (opts) => {
        gateOptions = opts;
        return okBrowserGate();
      },
    }, input);
    assert.equal(outcome.status, 'published');
    assert.equal(gateOptions?.jobId, input.jobId);
    assert.equal(gateOptions?.reqId, PANEL_REQ_ID);
    assert.equal(gateOptions?.specPath, PANEL_SPEC_PATH);
    assert.equal(gateOptions?.dispatchRevision, 1);
    assert.equal(gateOptions?.sourceMainSha, PANEL_SOURCE_SHA);
    assert.equal(gateOptions?.candidateTreeSha, PANEL_TREE_SHA);

    const runTypes = readdirSync(join(runDir, 'test-runs'))
      .map((id) => JSON.parse(readFileSync(join(runDir, 'test-runs', id, 'test-run.json'), 'utf8')) as Record<string, unknown>)
      .filter((record) => record.runner === 'node:test');
    assert.equal(runTypes.length, 1);
    assert.equal(runTypes[0]?.specPath, PANEL_SPEC_PATH);
    assert.equal(runTypes[0]?.dispatchRevision, 1);
    assert.equal(runTypes[0]?.sourceMainSha, PANEL_SOURCE_SHA);
    assert.equal(runTypes[0]?.candidateTreeSha, PANEL_TREE_SHA);

    const evidence = JSON.parse(readFileSync(
      join(runDir, 'browser', 'worker', input.jobId, 'browser-gate.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(evidence.specPath, PANEL_SPEC_PATH);
    assert.equal(evidence.dispatchRevision, 1);
    assert.equal(evidence.productBinding, 'bound');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Worker 在读取源码快照时拒绝 panel 符号链接且不调用 Pi', async () => {
  const root = tempRoot();
  try {
    const repoDir = join(root, 'repo');
    const runDir = join(root, 'run');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const specHash = specHashOf(PANEL_SPEC_BODY, PANEL_SPEC_PATH, PANEL_REQ_ID);
    const revision = panelRevision(specHash);
    let piCalls = 0;
    const git = {
      async createWorktree(_repo: string, workDir: string): Promise<void> {
        const realPanel = join(workDir, 'real-panel');
        mkdirSync(join(realPanel, 'src'), { recursive: true });
        writeFileSync(join(realPanel, 'src', 'App.tsx'), 'export const escaped = true;\n', 'utf8');
        symlinkSync(realPanel, join(workDir, 'panel'), 'dir');
      },
    } as unknown as GitClient;
    const outcome = await runWorkerJob({
      repoDir,
      runDir,
      git,
      github: {} as GithubClient,
      logger: SILENT_LOGGER,
      panelBinding: {
        repo: 'sunpcm/spec-loop',
        mainBranch: 'main',
        repositoryId: 'github-repository-id:9001',
        issueNumber: 1901,
        confirmedMainSha: PANEL_SOURCE_SHA,
        specHash,
      },
      runPi: async () => {
        piCalls += 1;
        throw new Error('符号链接不应启动 Pi');
      },
      checkDispatchCurrent: async () => true,
    }, {
      jobId: 'job-panel-symlink',
      reqId: PANEL_REQ_ID,
      issueNumber: 1901,
      spec: {
        id: PANEL_REQ_ID,
        title: '面板交付',
        path: PANEL_SPEC_PATH,
        body: PANEL_SPEC_BODY,
        hash: specHash,
      },
      sourceMainSha: PANEL_SOURCE_SHA,
      attempt: 1,
      dispatchRevision: revision,
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /符号链接源码根/);
    assert.equal(piCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
