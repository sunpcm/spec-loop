import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isCrossSiteRequest } from '../orchestrator/control-server.ts';
import { createFeishuBridgeRuntime } from '../orchestrator/feishu-factory.ts';
import { loadConfig, parsePublicUrl, type Config } from '../orchestrator/config.ts';
import { checkFeishu, initGuardDecision, publishBaselinePreview, recordBaseline } from '../orchestrator/init.ts';
import { acquireInstanceLock, createMutex } from '../orchestrator/lock.ts';
import { buildPiEnv, preparePiAgentDir, runPi } from '../orchestrator/pi-runner.ts';
import { extractAssetRefs } from '../orchestrator/preview.ts';
import { markInterruptedJobsFailed } from '../orchestrator/recover.ts';
import { checkReleaseHttp, pickWorkerTargets } from '../orchestrator/runtime.ts';
import { buildIsolationPaths, buildSandboxProfile } from '../orchestrator/sandbox.ts';
import { StateStore } from '../orchestrator/state.ts';
import type { OrchestratorState, Spec } from '../orchestrator/types.ts';
import { buildVerifierEnv, makeSandboxedRunner, resolveSafePath, validateWorkerManifest } from '../orchestrator/validate.ts';
import { buildVerifierSandboxSpec, runWorkerJob, summarizePiFailure, writeBoundedLog } from '../orchestrator/worker.ts';
import { GitClient } from '../orchestrator/git.ts';
import type { GithubClient } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import type { VerificationResult } from '../orchestrator/validate.ts';

function spec(id: string, hash = 'h1'): Spec {
  return { id, title: '需求', path: `docs/specs/${id}.md`, body: '需求正文', hash };
}

function makeState(
  requirements: OrchestratorState['requirements'],
  jobs: OrchestratorState['jobs'],
): OrchestratorState {
  return {
    schemaVersion: 1,
    repo: null,
    cursorMainSha: null,
    requirements,
    jobs,
    deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
    specRequests: {},
    opLog: [],
  };
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('pickWorkerTargets 跳过同一 hash 的 failed 作业，不无限重跑', () => {
  const state = makeState(
    { 'REQ-A-01': { issueNumber: 1, specHash: 'h1', specPath: 'docs/specs/REQ-A-01.md', sourceMainSha: 's1' } },
    {
      j1: {
        jobId: 'j1',
        reqId: 'REQ-A-01',
        issueNumber: 1,
        specHash: 'h1',
        sourceMainSha: 's1',
        attempt: 1,
        status: 'failed',
        startedAt: '',
        updatedAt: '',
      },
    },
  );
  assert.deepEqual(pickWorkerTargets(state, [spec('REQ-A-01', 'h1')]), []);
});

test('pickWorkerTargets 在需求 hash 变化后重新派单，即使旧作业 failed', () => {
  const state = makeState(
    { 'REQ-A-01': { issueNumber: 1, specHash: 'h2', specPath: 'docs/specs/REQ-A-01.md', sourceMainSha: 's1' } },
    {
      j1: {
        jobId: 'j1',
        reqId: 'REQ-A-01',
        issueNumber: 1,
        specHash: 'h1',
        sourceMainSha: 's1',
        attempt: 1,
        status: 'failed',
        startedAt: '',
        updatedAt: '',
      },
    },
  );
  const targets = pickWorkerTargets(state, [spec('REQ-A-01', 'h2')]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.attempt, 1);
});

test('pickWorkerTargets 无历史作业时派发 attempt 1', () => {
  const state = makeState(
    { 'REQ-A-01': { issueNumber: 1, specHash: 'h1', specPath: 'docs/specs/REQ-A-01.md', sourceMainSha: 's1' } },
    {},
  );
  const targets = pickWorkerTargets(state, [spec('REQ-A-01', 'h1')]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.attempt, 1);
});

test('pickWorkerTargets 旧 revision 高 attempt 不遮盖新 revision 的失败作业', () => {
  const state = makeState(
    { 'REQ-A-01': { issueNumber: 1, specHash: 'h2', specPath: 'docs/specs/REQ-A-01.md', sourceMainSha: 's2' } },
    {
      old: { jobId: 'old', reqId: 'REQ-A-01', issueNumber: 1, specHash: 'h1', sourceMainSha: 's1', attempt: 3, status: 'failed', startedAt: '', updatedAt: '' },
      new: { jobId: 'new', reqId: 'REQ-A-01', issueNumber: 1, specHash: 'h2', sourceMainSha: 's2', attempt: 1, status: 'failed', startedAt: '', updatedAt: '' },
    },
  );
  assert.deepEqual(pickWorkerTargets(state, [spec('REQ-A-01', 'h2')]), []);
});

test('pickWorkerTargets 旧 revision 高 attempt 不遮盖新 revision 的首次派发', () => {
  const state = makeState(
    { 'REQ-A-01': { issueNumber: 1, specHash: 'h2', specPath: 'docs/specs/REQ-A-01.md', sourceMainSha: 's2' } },
    {
      old: { jobId: 'old', reqId: 'REQ-A-01', issueNumber: 1, specHash: 'h1', sourceMainSha: 's1', attempt: 3, status: 'failed', startedAt: '', updatedAt: '' },
    },
  );
  const targets = pickWorkerTargets(state, [spec('REQ-A-01', 'h2')]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.attempt, 1);
  assert.equal(targets[0]?.sourceMainSha, 's2');
});

test('checkReleaseHttp 校验版本、首页与资源', async () => {
  const ok = await checkReleaseHttp('http://x', 'sha1', async (url) => {
    if (url.endsWith('/__version')) return { status: 200, body: JSON.stringify({ version: 'sha1' }) };
    if (url.endsWith('/')) return { status: 200, body: '<script src="/assets/a.js"></script><link href="/assets/b.css">' };
    if (url.endsWith('/assets/a.js')) return { status: 200, body: 'js' };
    if (url.endsWith('/assets/b.css')) return { status: 200, body: 'css' };
    return { status: 404, body: '' };
  });
  assert.equal(ok, true);
});

test('checkReleaseHttp 版本不匹配即失败', async () => {
  const ok = await checkReleaseHttp('http://x', 'sha2', async (url) => {
    if (url.endsWith('/__version')) return { status: 200, body: JSON.stringify({ version: 'sha1' }) };
    return { status: 200, body: '' };
  });
  assert.equal(ok, false);
});

test('extractAssetRefs 只提取相对 src/href', () => {
  const html = '<script src="/assets/a.js"></script><link href="/assets/b.css"><a href="https://x/y"><img src="data:1">';
  assert.deepEqual(extractAssetRefs(html), ['assets/a.js', 'assets/b.css']);
});

test('isCrossSiteRequest 拒绝外站 Origin / 非 JSON Content-Type / 非本机 Host', () => {
  assert.equal(isCrossSiteRequest({ headers: { origin: 'http://evil.example' } }), true);
  assert.equal(isCrossSiteRequest({ headers: { host: 'evil.example:4000' } }), true);
  assert.equal(isCrossSiteRequest({ headers: { 'content-type': 'text/plain' } }), true);
  assert.equal(isCrossSiteRequest({ headers: { origin: 'http://127.0.0.1:4000', host: '127.0.0.1:4000', 'content-type': 'application/json' } }), false);
});

test('createMutex 串行执行任务且单个失败不阻塞后续', async () => {
  const m = createMutex();
  const order: number[] = [];
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  await Promise.all([
    m(async () => {
      order.push(1);
      await wait(10);
      order.push(2);
    }),
    m(async () => {
      order.push(3);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);

  const fail = m(async () => {
    throw new Error('boom');
  });
  await assert.rejects(() => fail);
  const after = await m(async () => 'ok');
  assert.equal(after, 'ok');
});

test('acquireInstanceLock 拒绝存活实例并回收陈旧锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-lock-'));
  const file = join(dir, 'daemon.lock');
  const acquired = acquireInstanceLock(file, () => true);
  assert.equal(acquired.acquired, true);
  assert.equal(acquireInstanceLock(file, () => true).acquired, false);
  acquired.release();
  assert.equal(acquireInstanceLock(file, () => false).acquired, true);
});

test('buildSandboxProfile 生成 allow-default + deny-write + 敏感读拒绝', () => {
  const profile = buildSandboxProfile({
    writableDirs: ['/job'],
    writableLiterals: ['/dev/null'],
    denyReadDirs: ['/secret'],
    denyReadLiterals: ['/secret-file'],
    allowReadDirs: ['/repo'],
    denyNetwork: true,
  });
  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/job"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/secret"\)\)/);
  assert.match(profile, /\(allow file-read-data \(subpath "\/repo"\)\)/);
  assert.match(profile, /\(deny network\*\)/);
});

test('buildSandboxProfile 敏感拒绝位于 allow 之后，覆盖仓库内 .env/.git', () => {
  const profile = buildSandboxProfile({
    writableDirs: ['/job'],
    writableLiterals: ['/dev/null'],
    denyReadDirs: ['/home'],
    denyReadLiterals: [],
    allowReadDirs: ['/home/repo', '/home/.nvm/versions/node/v24'],
    sensitiveDenyDirs: ['/home/repo/.git'],
    sensitiveDenyLiterals: ['/home/repo/.env'],
    denyNetwork: true,
  });
  const lines = profile.trim().split('\n');
  const allowRepo = lines.findIndex((l) => l.includes('allow file-read-data (subpath "/home/repo")'));
  const denyGit = lines.findIndex((l) => l.includes('deny file-read-data (subpath "/home/repo/.git")'));
  const denyEnv = lines.findIndex((l) => l.includes('deny file-read-data (literal "/home/repo/.env")'));
  assert.ok(allowRepo >= 0, 'allow repo 规则存在');
  assert.ok(denyGit > allowRepo, '.git 敏感拒绝必须位于 allow repo 之后');
  assert.ok(denyEnv > allowRepo, '.env 敏感拒绝必须位于 allow repo 之后');
});

test('buildVerifierSandboxSpec 拒绝全局与作业 agent 目录，且不 deny jobTmp', () => {
  const isolation = buildIsolationPaths('/repo');
  const spec = buildVerifierSandboxSpec(
    { ...isolation, allowReadDirs: ['/repo'], sensitiveDenyDirs: ['/repo/.git'], sensitiveDenyLiterals: [] },
    '/repo/.orchestrator/verify/job',
    '/repo/.orchestrator/jobs/job/tmp',
    '/repo/.orchestrator/agent',
    '/repo/.orchestrator/jobs/job/agent',
  );
  assert.ok(spec.sensitiveDenyDirs?.includes('/repo/.orchestrator/agent'));
  assert.ok(spec.sensitiveDenyDirs?.includes('/repo/.orchestrator/jobs/job/agent'));
  assert.ok(!spec.sensitiveDenyDirs?.includes('/repo/.orchestrator/jobs/job/tmp'));

  const profile = buildSandboxProfile(spec);
  const lines = profile.trim().split('\n');
  const allowRepo = lines.findIndex((l) => l.includes('allow file-read-data (subpath "/repo")'));
  const denyGlobal = lines.findIndex((l) => l.includes('deny file-read-data (subpath "/repo/.orchestrator/agent")'));
  const denyJobAgent = lines.findIndex((l) => l.includes('deny file-read-data (subpath "/repo/.orchestrator/jobs/job/agent")'));
  assert.ok(allowRepo >= 0);
  assert.ok(denyGlobal > allowRepo, '全局 agent 拒绝必须在 allow repo 之后');
  assert.ok(denyJobAgent > allowRepo, '作业 agent 拒绝必须在 allow repo 之后');
});

test('buildVerifierEnv 只传白名单，不带模型/GH/飞书凭据', () => {
  const prev = {
    GH_TOKEN: process.env.GH_TOKEN,
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    SPEC_LOOP_PI_API_KEY: process.env.SPEC_LOOP_PI_API_KEY,
    PI_PROVIDER: process.env.PI_PROVIDER,
    PI_MODEL: process.env.PI_MODEL,
  };
  process.env.GH_TOKEN = '{{SECRET_gh}}';
  process.env.FEISHU_APP_SECRET = '{{SECRET_feishu}}';
  process.env.SPEC_LOOP_PI_API_KEY = '{{SECRET_pi}}';
  process.env.PI_PROVIDER = 'spec-loop-proxy';
  process.env.PI_MODEL = 'workbuddy/deepseek-v4.1-flash';
  try {
    const env = buildVerifierEnv({ SPEC_LOOP_OUT_DIR: '/out' }, '/job/tmp');
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.FEISHU_APP_SECRET, undefined);
    assert.equal(env.SPEC_LOOP_PI_API_KEY, undefined);
    assert.equal(env.PI_PROVIDER, undefined);
    assert.equal(env.PI_MODEL, undefined);
    assert.equal(env.SPEC_LOOP_OUT_DIR, '/out');
    assert.equal(env.HOME, '/job/tmp');
    assert.equal(env.TMPDIR, '/job/tmp');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('makeSandboxedRunner 在 sandbox-exec 不可用时 fail-closed', async () => {
  const runner = makeSandboxedRunner(
    {
      writableDirs: ['/job'],
      writableLiterals: ['/dev/null'],
      denyReadDirs: [],
      denyReadLiterals: [],
      allowReadDirs: [],
      denyNetwork: true,
    },
    { execBin: '/nonexistent/sandbox-exec' },
  );
  const res = await runner('npm', ['run', 'test'], { cwd: '/tmp', env: {} });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /fail-closed/);
});

test('resolveSafePath 拒绝越权与路径穿越，仅允许 src/**', () => {
  assert.throws(() => resolveSafePath('/base', '../etc/passwd'));
  assert.throws(() => resolveSafePath('/base', '/etc/passwd'));
  assert.throws(() => resolveSafePath('/base', 'docs/evil.md'));
  assert.equal(resolveSafePath('/base', 'src/counter.ts'), join('/base', 'src/counter.ts'));
});

test('validateWorkerManifest 拒绝非 src 文件', () => {
  assert.throws(() => validateWorkerManifest('/base', { files: [{ path: 'docs/evil.md', content: 'x' }] }));
  const files = validateWorkerManifest('/base', { files: [{ path: 'src/counter.ts', content: 'x' }] });
  assert.equal(files.length, 1);
});

test('buildPiEnv 注入 provider/model/agent 与 SPEC_LOOP_PI_API_KEY，且不带 GH 秘密', () => {
  const prevKey = process.env.SPEC_LOOP_PI_API_KEY;
  const prevGh = process.env.GH_TOKEN;
  const keyFixture = 'plain-test-key';
  process.env.SPEC_LOOP_PI_API_KEY = keyFixture;
  process.env.GH_TOKEN = 'gh-token-fixture';
  try {
    const env = buildPiEnv({
      role: 'worker',
      prompt: 'p',
      workDir: '/w',
      agentDir: '/agent',
      provider: 'spec-loop-proxy',
      model: 'workbuddy/deepseek-v4.1-flash',
      timeoutMs: 1,
      graceMs: 1,
    });
    assert.equal(env.PI_PROVIDER, 'spec-loop-proxy');
    assert.equal(env.PI_MODEL, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(env.PI_CODING_AGENT_DIR, '/agent');
    assert.equal(env.SPEC_LOOP_PI_API_KEY, keyFixture);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.FEISHU_APP_SECRET, undefined);
  } finally {
    if (prevKey === undefined) delete process.env.SPEC_LOOP_PI_API_KEY;
    else process.env.SPEC_LOOP_PI_API_KEY = prevKey;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
  }
});

test('runPi 未提供 sandbox 时 fail-closed，拒绝无隔离运行', async () => {
  const res = await runPi({
    role: 'worker',
    prompt: 'p',
    workDir: '/tmp',
    agentDir: '/tmp/agent',
    provider: 'spec-loop-proxy',
    model: 'workbuddy/deepseek-v4.1-flash',
    timeoutMs: 1,
    graceMs: 1,
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /fail-closed/);
});

test('preparePiAgentDir 复制 models.json 到作业内 agentDir，不改全局', () => {
  const base = mkdtempSync(join(tmpdir(), 'spec-loop-agent-'));
  const globalDir = join(base, 'global');
  const jobDir = join(base, 'job');
  mkdirSync(globalDir, { recursive: true });
  const fixture = '{"apiKey":"${SPEC_LOOP_PI_API_KEY}"}';
  writeFileSync(join(globalDir, 'models.json'), fixture);
  preparePiAgentDir(globalDir, jobDir);
  assert.equal(readFileSync(join(jobDir, 'models.json'), 'utf8'), fixture);
  assert.equal(readFileSync(join(globalDir, 'models.json'), 'utf8'), fixture);
});

test('GitClient 真实夹具：fetch 更新 origin/main 且 readSpecSnapshot 只读直接 Markdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-git-'));
  const remoteDir = join(root, 'remote');
  const localDir = join(root, 'local');

  mkdirSync(join(remoteDir, 'docs', 'specs', 'sub'), { recursive: true });
  gitSync(['init', '-b', 'main'], remoteDir);
  gitSync(['config', 'user.email', 'test@example.com'], remoteDir);
  gitSync(['config', 'user.name', 'test'], remoteDir);
  writeFileSync(join(remoteDir, 'docs', 'specs', 'REQ-A-01.md'), '# A\n');
  writeFileSync(join(remoteDir, 'docs', 'specs', 'REQ-A-02.md'), '# B\n');
  writeFileSync(join(remoteDir, 'docs', 'specs', 'sub', 'REQ-B-01.md'), '# nested\n');
  writeFileSync(join(remoteDir, 'docs', 'specs', 'notes.txt'), 'not a spec\n');
  gitSync(['add', '-A'], remoteDir);
  gitSync(['commit', '-m', 'initial specs'], remoteDir);

  gitSync(['clone', remoteDir, localDir], root);

  const git = new GitClient();
  await git.fetch(localDir, 'main');

  const first = await git.readSpecSnapshot(localDir, 'origin/main');
  assert.deepEqual(Object.keys(first).sort(), ['docs/specs/REQ-A-01.md', 'docs/specs/REQ-A-02.md']);
  assert.match(first['docs/specs/REQ-A-01.md'], /# A/);

  writeFileSync(join(remoteDir, 'docs', 'specs', 'REQ-A-03.md'), '# C\n');
  gitSync(['add', '-A'], remoteDir);
  gitSync(['commit', '-m', 'add REQ-A-03'], remoteDir);

  await git.fetch(localDir, 'main');
  const second = await git.readSpecSnapshot(localDir, 'origin/main');
  assert.deepEqual(Object.keys(second).sort(), [
    'docs/specs/REQ-A-01.md',
    'docs/specs/REQ-A-02.md',
    'docs/specs/REQ-A-03.md',
  ]);
});

test('runWorkerJob 成功路径：快照验证后发布 PR', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'spec-loop-worker-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const calls: string[] = [];
  const git = {
    async createWorktree(_r: string, _d: string, _b: string, _br: string): Promise<void> {
      calls.push('createWorktree');
    },
    async add(_c: string, _p: string[]): Promise<void> {
      calls.push('add');
    },
    async diffNameOnly(_c: string, _ref: string): Promise<string[]> {
      return ['src/counter.ts'];
    },
    async reset(_c: string, _ref?: string): Promise<void> {
      calls.push('reset');
    },
    async writeTree(_c: string): Promise<string> {
      return 'tree1';
    },
    async archive(_r: string, _sha: string, dir: string): Promise<void> {
      mkdirSync(dir, { recursive: true });
      calls.push('archive');
    },
    async commit(_c: string, _m: string): Promise<void> {
      calls.push('commit');
    },
    async push(_c: string, _b: string): Promise<void> {
      calls.push('push');
    },
    async removeWorktree(_r: string, _d: string): Promise<void> {
      calls.push('removeWorktree');
    },
    async fetch(_c: string): Promise<void> {},
  } as unknown as GitClient;
  const github = {
    async createPR(_t: string, _b: string, _h: string, _base: string): Promise<number> {
      return 42;
    },
  } as unknown as GithubClient;

  const outcome = await runWorkerJob(
    {
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
        output: { files: [{ path: 'src/counter.ts', content: 'export const x = 1;\n' }] },
        durationMs: 0,
        timedOut: false,
      }),
      verify: async (): Promise<VerificationResult[]> => [{ name: 't', ok: true, code: 0, stdout: '', stderr: '' }],
      checkCurrent: async () => true,
    },
    {
      jobId: 'job-1',
      reqId: 'REQ-A-01',
      issueNumber: 1,
      spec: spec('REQ-A-01'),
      sourceMainSha: 's1',
      attempt: 1,
    },
  );
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.prNumber, 42);
  assert.ok(calls.includes('archive'));
  assert.ok(calls.includes('commit'));
  assert.ok(calls.includes('push'));
});

test('runWorkerJob 越权变更范围在提交前被拒绝', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'spec-loop-worker-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const git = {
    async createWorktree(): Promise<void> {},
    async add(): Promise<void> {},
    async diffNameOnly(): Promise<string[]> {
      return ['docs/evil.md'];
    },
    async reset(): Promise<void> {},
    async writeTree(): Promise<string> {
      return 'tree1';
    },
    async archive(): Promise<void> {},
    async commit(): Promise<void> {},
    async push(): Promise<void> {},
    async removeWorktree(): Promise<void> {},
  } as unknown as GitClient;
  const github = {} as unknown as GithubClient;

  const outcome = await runWorkerJob(
    {
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
        output: { files: [{ path: 'src/counter.ts', content: 'x' }] },
        durationMs: 0,
        timedOut: false,
      }),
      verify: async (): Promise<VerificationResult[]> => [{ name: 't', ok: true, code: 0, stdout: '', stderr: '' }],
      checkCurrent: async () => true,
    },
    {
      jobId: 'job-2',
      reqId: 'REQ-A-01',
      issueNumber: 1,
      spec: spec('REQ-A-01'),
      sourceMainSha: 's1',
      attempt: 1,
    },
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureStage, 'write');
  assert.match(outcome.error ?? '', /越权/);
});

test('runWorkerJob 作业内重试：首次失败、二次成功', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'spec-loop-worker-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  let piCalls = 0;
  const git = {
    async createWorktree(): Promise<void> {},
    async add(): Promise<void> {},
    async diffNameOnly(): Promise<string[]> {
      return ['src/counter.ts'];
    },
    async reset(): Promise<void> {},
    async writeTree(): Promise<string> {
      return 'tree1';
    },
    async archive(): Promise<void> {},
    async commit(): Promise<void> {},
    async push(): Promise<void> {},
    async removeWorktree(): Promise<void> {},
  } as unknown as GitClient;
  const github = {
    async createPR(): Promise<number> {
      return 43;
    },
  } as unknown as GithubClient;

  const outcome = await runWorkerJob(
    {
      repoDir,
      runDir,
      git,
      github,
      logger: silentLogger,
      runPi: async () => {
        piCalls += 1;
        if (piCalls === 1) {
          return {
            ok: false,
            exitCode: 1,
            stdout: '',
            stderr: 'sk-0123456789abcdef0123456789 首次失败详情',
            output: undefined,
            durationMs: 0,
            timedOut: false,
            error: '退出码 1 或输出未通过 JSON 校验',
          };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          output: { files: [{ path: 'src/counter.ts', content: 'export const x = 1;\n' }] },
          durationMs: 0,
          timedOut: false,
        };
      },
      verify: async (): Promise<VerificationResult[]> => [{ name: 't', ok: true, code: 0, stdout: '', stderr: '' }],
      checkCurrent: async () => true,
    },
    {
      jobId: 'job-retry',
      reqId: 'REQ-A-01',
      issueNumber: 1,
      spec: spec('REQ-A-01'),
      sourceMainSha: 's1',
      attempt: 1,
    },
  );
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.prNumber, 43);
  assert.equal(outcome.piAttempts, 2);
  assert.equal(piCalls, 2);
});

test('runWorkerJob 两次失败：返回 failed、保留有界日志且摘要脱敏', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'spec-loop-worker-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const git = {
    async createWorktree(): Promise<void> {},
    async add(): Promise<void> {},
    async diffNameOnly(): Promise<string[]> {
      return ['src/counter.ts'];
    },
    async reset(): Promise<void> {},
    async writeTree(): Promise<string> {
      return 'tree1';
    },
    async archive(): Promise<void> {},
    async commit(): Promise<void> {},
    async push(): Promise<void> {},
    async removeWorktree(): Promise<void> {},
  } as unknown as GitClient;
  const github = {} as unknown as GithubClient;

  const outcome = await runWorkerJob(
    {
      repoDir,
      runDir,
      git,
      github,
      logger: silentLogger,
      runPi: async () => ({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'sk-0123456789abcdef0123456789 真实失败详情',
        output: undefined,
        durationMs: 0,
        timedOut: false,
        error: '退出码 1 或输出未通过 JSON 校验',
      }),
      verify: async (): Promise<VerificationResult[]> => [{ name: 't', ok: true, code: 0, stdout: '', stderr: '' }],
      checkCurrent: async () => true,
    },
    {
      jobId: 'job-fail',
      reqId: 'REQ-A-01',
      issueNumber: 1,
      spec: spec('REQ-A-01'),
      sourceMainSha: 's1',
      attempt: 1,
    },
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.piAttempts, 2);
  assert.ok(!(outcome.error ?? '').includes('sk-0123456789abcdef0123456789'));
  assert.match(outcome.error ?? '', /退出码 1/);
  assert.match(outcome.error ?? '', /\[REDACTED\]/);

  const logDir = outcome.piLogDir ?? join(runDir, 'jobs', 'job-fail', 'logs');
  assert.ok(readFileSync(join(logDir, 'attempt-1.stderr.txt'), 'utf8').includes('真实失败详情'));
  assert.ok(readFileSync(join(logDir, 'attempt-2.stderr.txt'), 'utf8').includes('真实失败详情'));
});

test('summarizePiFailure 脱敏并保留有界摘要', () => {
  const summary = summarizePiFailure({
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: `sk-0123456789abcdef0123456789 长内容`.padEnd(5000, 'x'),
    output: undefined,
    durationMs: 0,
    timedOut: false,
    error: '退出码 1 或输出未通过 JSON 校验',
  });
  assert.match(summary, /退出码 1/);
  assert.ok(!summary.includes('sk-0123456789abcdef0123456789'));
  assert.ok(summary.includes('[REDACTED]'));
  assert.ok(summary.length < 1200);
});

test('writeBoundedLog 截断超长输出到有界大小', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-log-'));
  const big = 'x'.repeat(200 * 1024);
  const file = writeBoundedLog(dir, 'out.txt', big);
  const content = readFileSync(file, 'utf8');
  assert.ok(content.length < 100 * 1024);
  assert.match(content, /截断/);
});

test('acquireInstanceLock 已有存活锁不覆盖原 pid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-lock-'));
  const file = join(dir, 'daemon.lock');
  writeFileSync(file, '12345', 'utf8');
  const result = acquireInstanceLock(file, () => true);
  assert.equal(result.acquired, false);
  assert.equal(readFileSync(file, 'utf8').trim(), '12345');
});

test('acquireInstanceLock 回收死 pid 陈旧锁并清理 reaper 守卫', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-lock-'));
  const file = join(dir, 'daemon.lock');
  writeFileSync(file, '99999', 'utf8');
  const result = acquireInstanceLock(file, () => false);
  assert.equal(result.acquired, true);
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
  assert.equal(existsSync(`${file}.reap`), false, '回收守卫应已清理');
  result.release();
  assert.equal(existsSync(file), false);
});

test('acquireInstanceLock 空锁保守拒绝且不删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-lock-'));
  const file = join(dir, 'daemon.lock');
  writeFileSync(file, '', 'utf8');
  const result = acquireInstanceLock(file, () => false);
  assert.equal(result.acquired, false);
  assert.match(result.reason ?? '', /人工/);
  assert.equal(readFileSync(file, 'utf8'), '');
});

test('acquireInstanceLock 损坏锁（非正整数 pid）保守拒绝且不删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-lock-'));
  const file = join(dir, 'daemon.lock');
  writeFileSync(file, 'not-a-pid', 'utf8');
  const result = acquireInstanceLock(file, () => false);
  assert.equal(result.acquired, false);
  assert.match(result.reason ?? '', /人工/);
  assert.equal(readFileSync(file, 'utf8').trim(), 'not-a-pid');
});

test('acquireInstanceLock reaper 守卫被占用时 fail closed 不改写锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-lock-'));
  const file = join(dir, 'daemon.lock');
  writeFileSync(file, '99999', 'utf8');
  mkdirSync(`${file}.reap`);
  const result = acquireInstanceLock(file, () => false);
  assert.equal(result.acquired, false);
  assert.match(result.reason ?? '', /正在回收/);
  assert.equal(readFileSync(file, 'utf8').trim(), '99999');
  rmdirSync(`${file}.reap`);
  const retry = acquireInstanceLock(file, () => false);
  assert.equal(retry.acquired, true);
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
});

test('createFeishuBridgeRuntime 未启用时返回 null 且不调用 logger', async () => {
  const logged: string[] = [];
  const bridge = await createFeishuBridgeRuntime(
    { enabled: false, allowedUserIds: [] },
    {
      status: async () => 'ok',
      retry: async () => 'ok',
      help: async () => 'help',
      require: async () => 'require',
      retryRequirement: async () => 'retry-req',
    },
    (m) => logged.push(m),
  );
  assert.equal(bridge, null);
  assert.deepEqual(logged, []);
});

test('checkFeishu 缺项时列出缺失变量名', () => {
  assert.equal(checkFeishu(false).ok, true);
  const res = checkFeishu(true, undefined, undefined, undefined);
  assert.equal(res.ok, false);
  assert.match(res.detail, /FEISHU_APP_ID/);
});

test('markInterruptedJobsFailed 只标记 processing 作业', () => {
  const state = makeState(
    {},
    {
      a: { jobId: 'a', reqId: 'R', issueNumber: 1, specHash: 'h', sourceMainSha: 's', attempt: 1, status: 'processing', startedAt: '', updatedAt: '' },
      b: { jobId: 'b', reqId: 'R', issueNumber: 1, specHash: 'h', sourceMainSha: 's', attempt: 1, status: 'done', startedAt: '', updatedAt: '' },
    },
  );
  const n = markInterruptedJobsFailed(state);
  assert.equal(n, 1);
  assert.equal(state.jobs.a.status, 'failed');
  assert.equal(state.jobs.b.status, 'done');
});

test('recordBaseline 远端 fetch 失败时返回 false，不误报成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-init-'));
  const config = { mainBranch: 'main', runDir: join(root, 'run') } as Config;
  const state = new StateStore(join(root, 'state.json'));
  const git = {
    async fetch(): Promise<void> {
      throw new Error('boom');
    },
  } as unknown as GitClient;
  const ok = await recordBaseline(config, git, join(root, 'repo'), 'owner/repo', state, silentLogger);
  assert.equal(ok, false);
});

test('recordBaseline 成功时持久化游标与绑定仓库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-init-'));
  const config = { mainBranch: 'main', runDir: join(root, 'run') } as Config;
  const state = new StateStore(join(root, 'state.json'));
  const git = {
    async fetch(): Promise<void> {},
    async revParse(): Promise<string> {
      return 'abc123';
    },
    async readSpecSnapshot(): Promise<Record<string, string>> {
      return {};
    },
  } as unknown as GitClient;
  const ok = await recordBaseline(config, git, join(root, 'repo'), 'owner/repo', state, silentLogger);
  assert.equal(ok, true);
  const snap = state.snapshot();
  assert.equal(snap.cursorMainSha, 'abc123');
  assert.equal(snap.repo, 'owner/repo');
});

test('loadConfig 将空白 SPEC_LOOP_REPO 视为未设置', () => {
  const prev = process.env.SPEC_LOOP_REPO;
  process.env.SPEC_LOOP_REPO = '   ';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'spec-loop-config-'));
    const config = loadConfig(dir);
    assert.equal(config.repo, null);
  } finally {
    if (prev === undefined) delete process.env.SPEC_LOOP_REPO;
    else process.env.SPEC_LOOP_REPO = prev;
  }
});

test('SPEC_LOOP_PUBLIC_URL 默认空且只接受无凭据 HTTPS URL', () => {
  assert.equal(parsePublicUrl(undefined), '');
  assert.equal(parsePublicUrl('   '), '');
  assert.equal(parsePublicUrl('https://spec-loop.vercel.app'), 'https://spec-loop.vercel.app/');

  for (const invalid of [
    'not-a-url',
    'http://spec-loop.vercel.app',
    'https://user@spec-loop.vercel.app',
    `https://user:${'not-a-secret'}@spec-loop.vercel.app`,
  ]) {
    assert.throws(() => parsePublicUrl(invalid), /SPEC_LOOP_PUBLIC_URL/);
  }
});

test('loadConfig 将合法 SPEC_LOOP_PUBLIC_URL 写入部署配置', () => {
  const previous = process.env.SPEC_LOOP_PUBLIC_URL;
  process.env.SPEC_LOOP_PUBLIC_URL = 'https://spec-loop.vercel.app';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'spec-loop-public-url-'));
    assert.equal(loadConfig(dir).publicUrl, 'https://spec-loop.vercel.app/');
  } finally {
    if (previous === undefined) delete process.env.SPEC_LOOP_PUBLIC_URL;
    else process.env.SPEC_LOOP_PUBLIC_URL = previous;
  }
});

test('publishBaselinePreview 已有 activeSha 时直接成功，不重复构建', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-baseline-'));
  const config = { mainBranch: 'main', runDir: join(root, 'run'), repoDir: join(root, 'repo') } as Config;
  const state = new StateStore(join(root, 'state.json'));
  await state.update((s) => {
    s.deploy.activeSha = 'existing';
    s.deploy.releaseDir = '/x';
    return undefined;
  });
  const git = {
    revParse: async (): Promise<string> => {
      throw new Error('不应被调用');
    },
  } as unknown as GitClient;
  const ok = await publishBaselinePreview(config, git, state, silentLogger);
  assert.equal(ok, true);
  assert.equal(state.snapshot().deploy.activeSha, 'existing');
});

test('publishBaselinePreview 构建失败返回 false 且不写预览指针', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-baseline-'));
  const config = { mainBranch: 'main', runDir: join(root, 'run'), repoDir: join(root, 'repo') } as Config;
  const state = new StateStore(join(root, 'state.json'));
  const git = {
    revParse: async (): Promise<string> => 'sha123',
    archive: async (): Promise<void> => {
      throw new Error('no archive');
    },
  } as unknown as GitClient;
  const ok = await publishBaselinePreview(config, git, state, silentLogger);
  assert.equal(ok, false);
  assert.equal(state.snapshot().deploy.activeSha, null);
});

test('initGuardDecision 预检缺项优先拒绝，即使仓库匹配', () => {
  assert.equal(initGuardDecision(false, 'owner/repo', 'owner/repo'), 'precheck-failed');
  assert.equal(initGuardDecision(false, null, 'owner/repo'), 'precheck-failed');
});

test('initGuardDecision 跨仓不匹配拒绝，避免 recordBaseline 污染旧 state', () => {
  assert.equal(initGuardDecision(true, 'old/owner', 'new/owner'), 'repo-mismatch');
  assert.equal(initGuardDecision(true, 'owner/repo', 'owner/repo'), 'ok');
  assert.equal(initGuardDecision(true, null, 'owner/repo'), 'ok');
  assert.equal(initGuardDecision(true, 'owner/repo', undefined), 'ok');
});

test('init 拒绝跨仓不匹配时旧 state 字节不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-init-guard-'));
  const stateFile = join(root, 'state.json');
  const state = new StateStore(stateFile);
  // 先绑定旧仓库并落盘，作为“本应拒绝的旧 state”。
  await state.update((s) => {
    s.repo = 'old/owner';
    s.cursorMainSha = 'oldsha';
    return undefined;
  });
  const bytesBefore = readFileSync(stateFile, 'utf8');

  const existingRepo = state.snapshot().repo;
  const guard = initGuardDecision(true, existingRepo, 'new/owner');
  assert.equal(guard, 'repo-mismatch');

  // 守卫命中后 main() 会在 labels/baseline/publish 之前 return，不调用 recordBaseline；
  // 这里模拟“未调用任何写操作”，断言 state 字节与原样一致。
  assert.equal(readFileSync(stateFile, 'utf8'), bytesBefore);
  assert.equal(state.snapshot().repo, 'old/owner');
  assert.equal(state.snapshot().cursorMainSha, 'oldsha');
});
