import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  buildBrowserGateEnv,
  buildBrowserGateSandboxSpec,
  buildLoopbackPortRule,
  computeE2eSuiteFingerprint,
  createCandidateStaticServer,
  extractCaseId,
  freezeE2eSuite,
  materializeBrowserEvidence,
  matchCaseIds,
  parseE2eContract,
  resolveSeatbeltPath,
  resolveBrowserCacheDir,
  runBrowserGate,
  summarizePlaywrightReport,
  validateE2eReport,
  verifyCounterContract,
  type BrowserGateRunnerResult,
  type E2eReportSummary,
} from '../orchestrator/browser-gate.ts';
import { buildIsolationPaths, buildSandboxProfile } from '../orchestrator/sandbox.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { createTestEvidenceStore } from '../orchestrator/test-evidence.ts';
import type { Logger } from '../orchestrator/log.ts';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

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

function counterSpec(): { files: Record<string, string>; contract: Record<string, unknown> } {
  const content = '### [REQ-CNT-01] 计数器与自定义步长\n\n#### 功能\n- 初始为 0\n';
  const files = { 'docs/specs/counter.md': content };
  const parsed = parseSpecs(files);
  const spec = parsed.specs[0]!;
  return {
    files,
    contract: {
      reqId: 'REQ-CNT-01',
      specPath: 'docs/specs/counter.md',
      specHash: spec.hash,
      caseIds: ['E2E-CNT-001', 'E2E-CNT-002'],
    },
  };
}

function makeReport(titles: string[], mutate?: (spec: Record<string, unknown>) => void): unknown {
  const specs = titles.map((title) => {
    const spec: Record<string, unknown> = {
      title,
      ok: true,
      tests: [
        {
          expectedStatus: 'passed',
          projectName: 'counter',
          status: 'expected',
          results: [{ status: 'passed', retry: 0, duration: 1 }],
        },
      ],
    };
    mutate?.(spec);
    return spec;
  });
  return {
    errors: [],
    suites: [{ title: 'counter.spec.ts', file: 'counter.spec.ts', specs }],
    stats: { expected: titles.length, unexpected: 0, skipped: 0, flaky: 0 },
  };
}

function setupE2eRoot(dir: string, contract: unknown): void {
  mkdirSync(join(dir, 'node_modules', '@playwright', 'test'), { recursive: true });
  mkdirSync(join(dir, 'tests', 'e2e', 'contracts'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@playwright', 'test', 'cli.js'), '// fake cli\n', 'utf8');
  writeFileSync(join(dir, 'playwright.config.ts'), 'export default {};\n', 'utf8');
  writeFileSync(join(dir, 'tests', 'e2e', 'contracts', 'counter.json'), JSON.stringify(contract), 'utf8');
  writeFileSync(join(dir, 'tests', 'e2e', 'counter.spec.ts'), "test('E2E-CNT-001 x', () => {});\n", 'utf8');
}

test('parseE2eContract 解析 counter 与 panel 契约并拒绝非法输入', () => {
  const { contract } = counterSpec();
  const parsed = parseE2eContract(contract, 'counter');
  assert.deepEqual(parsed.caseIds, ['E2E-CNT-001', 'E2E-CNT-002']);
  assert.equal(parsed.reqId, 'REQ-CNT-01');

  const panel = parseE2eContract({ caseIds: ['PANEL-01', 'PANEL-02'] }, 'panel');
  assert.deepEqual(panel.caseIds, ['PANEL-01', 'PANEL-02']);
  assert.equal(panel.reqId, undefined);

  assert.throws(() => parseE2eContract({ caseIds: [] }, 'counter'), /caseIds/);
  assert.throws(() => parseE2eContract({ reqId: 'X', specPath: 'p', specHash: 'not-sha', caseIds: ['a'] }, 'counter'), /64 位 specHash/);
});

test('parseE2eContract 拒绝非法 caseIds 元素/空值/重复与未知过滤', () => {
  assert.throws(() => parseE2eContract({ caseIds: ['PANEL-001', 'PANEL-001', null] }, 'panel'), /caseIds/);
  assert.throws(() => parseE2eContract({ caseIds: ['A', 'A'] }, 'panel'), /重复/);
  assert.throws(() => parseE2eContract({ caseIds: ['A', ''] }, 'panel'), /非空字符串/);
  assert.throws(() => parseE2eContract({ caseIds: 'not-array' }, 'panel'), /数组/);
  assert.throws(() => parseE2eContract({ cases: [{ id: 'A' }, { id: '' }] }, 'panel'), /空 id/);
  const legacy = parseE2eContract({ cases: [{ id: 'A' }, { id: 'B' }] }, 'panel');
  assert.deepEqual(legacy.caseIds, ['A', 'B']);
});

test('resolveSeatbeltPath 将临时目录别名规范到真实路径', () => {
  const existing = mkdtempSync(join(tmpdir(), 'spec-loop-realpath-'));
  assert.equal(resolveSeatbeltPath(existing), realpathSync(existing));
  const missing = join(existing, 'not-created');
  assert.equal(resolveSeatbeltPath(missing), join(realpathSync(existing), 'not-created'));
});

test('verifyCounterContract 匹配、过期 hash 与 reqId 不匹配', () => {
  const { files, contract } = counterSpec();
  const good = verifyCounterContract(contract as never, files, 'REQ-CNT-01');
  assert.equal(good.ok, true);

  const stale = verifyCounterContract({ ...contract, specHash: 'a'.repeat(64) } as never, files, 'REQ-CNT-01');
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /specHash/);

  const wrongReq = verifyCounterContract(contract as never, files, 'REQ-OTHER-01');
  assert.equal(wrongReq.ok, false);
  assert.match(wrongReq.detail, /不匹配/);
});

test('extractCaseId 提取标题前导 token', () => {
  assert.equal(extractCaseId('E2E-CNT-001 初始计数为 0'), 'E2E-CNT-001');
  assert.equal(extractCaseId('  PANEL-DEMO-01 演示标识'), 'PANEL-DEMO-01');
  assert.equal(extractCaseId('   '), undefined);
});

test('matchCaseIds 校验集合完全一致且无重复/缺漏', () => {
  assert.equal(matchCaseIds(['A', 'B'], ['A', 'B']).ok, true);
  const missing = matchCaseIds(['A', 'B', 'C'], ['A', 'B']);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /缺失/);
  const extra = matchCaseIds(['A'], ['A', 'B']);
  assert.equal(extra.ok, false);
  assert.match(extra.detail, /多余/);
  assert.equal(matchCaseIds(['A'], []).ok, false);
});

test('summarizePlaywrightReport 从 spec.title 提取用例并统计 status/retry/expectedStatus', () => {
  const report = makeReport(['E2E-CNT-001 a', 'E2E-CNT-002 b']);
  const summary = summarizePlaywrightReport(report, 'counter');
  assert.equal(summary.specCount, 2);
  assert.equal(summary.targetTestCount, 2);
  assert.equal(summary.resultCount, 2);
  assert.deepEqual(summary.caseIds, ['E2E-CNT-001', 'E2E-CNT-002']);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.flaky, 0);
  assert.equal(summary.unexpected, 0);
  assert.equal(summary.failedResultCount, 0);
  assert.equal(summary.retriedCount, 0);
  assert.equal(summary.unexpectedExpectedStatusCount, 0);
  assert.equal(summary.wrongTestCount, 0);
  assert.equal(summary.wrongResultCount, 0);

  const bad = makeReport(['E2E-CNT-001 a'], (spec) => {
    const test = (spec.tests as Record<string, unknown>[])[0]!;
    test.status = 'unexpected';
    test.expectedStatus = 'failed';
    test.results = [{ status: 'failed', retry: 1 }];
  });
  const badSummary = summarizePlaywrightReport(bad, 'counter');
  assert.equal(badSummary.unexpected, 1);
  assert.equal(badSummary.failedResultCount, 1);
  assert.equal(badSummary.retriedCount, 1);
  assert.equal(badSummary.unexpectedExpectedStatusCount, 1);
});

test('validateE2eReport 拒绝零用例/skip/flaky/unexpected/重试/非 passed expectedStatus', () => {
  const base: E2eReportSummary = {
    specCount: 1,
    targetTestCount: 1,
    resultCount: 1,
    skipped: 0,
    flaky: 0,
    unexpected: 0,
    errorCount: 0,
    caseIds: ['A'],
    failedResultCount: 0,
    retriedCount: 0,
    unexpectedExpectedStatusCount: 0,
    wrongTestCount: 0,
    wrongResultCount: 0,
  };
  assert.equal(validateE2eReport(base, ['A']).ok, true);
  assert.match(validateE2eReport({ ...base, specCount: 0 }, ['A']).detail, /0 个用例/);
  assert.match(validateE2eReport({ ...base, skipped: 1 }, ['A']).detail, /skipped/);
  assert.match(validateE2eReport({ ...base, flaky: 1 }, ['A']).detail, /flaky/);
  assert.match(validateE2eReport({ ...base, unexpected: 1 }, ['A']).detail, /unexpected/);
  assert.match(validateE2eReport({ ...base, retriedCount: 1 }, ['A']).detail, /retry/);
  assert.match(validateE2eReport({ ...base, unexpectedExpectedStatusCount: 1 }, ['A']).detail, /expectedStatus/);
  assert.match(validateE2eReport({ ...base, failedResultCount: 1 }, ['A']).detail, /非 passed/);
  assert.match(validateE2eReport({ ...base, wrongTestCount: 1 }, ['A']).detail, /test 数不为 1/);
  assert.match(validateE2eReport({ ...base, wrongResultCount: 1 }, ['A']).detail, /result 数不为 1/);
  assert.match(validateE2eReport({ ...base, targetTestCount: 2 }, ['A']).detail, /数量不一致/);
});

test('summarize/validate 拒绝零执行与空 results 的反例', () => {
  const noTest = summarizePlaywrightReport(
    { errors: [], suites: [{ specs: [{ title: 'E2E-CNT-001 exists', tests: [] }] }] },
    'counter',
  );
  assert.equal(noTest.wrongTestCount, 1);
  assert.equal(validateE2eReport(noTest, ['E2E-CNT-001']).ok, false);

  const noResult = summarizePlaywrightReport(
    {
      errors: [],
      suites: [
        {
          specs: [
            {
              title: 'E2E-CNT-001 exists',
              tests: [{ projectName: 'counter', status: 'expected', expectedStatus: 'passed', results: [] }],
            },
          ],
        },
      ],
    },
    'counter',
  );
  assert.equal(noResult.wrongResultCount, 1);
  assert.equal(validateE2eReport(noResult, ['E2E-CNT-001']).ok, false);
});

test('summarizePlaywrightReport 拒绝类型非法的 errors/执行结构，不把未知当空错误', () => {
  const passedWithStringErrors = makeReport(['E2E-CNT-001 a']);
  (passedWithStringErrors as Record<string, unknown>).errors = 'failed elsewhere';
  assert.throws(() => summarizePlaywrightReport(passedWithStringErrors, 'counter'), /errors 必须是数组/);

  assert.throws(() =>
    summarizePlaywrightReport(
      {
        errors: [],
        suites: [{ specs: [{ title: 'E2E-CNT-001 a', tests: 'bad' }] }],
      },
      'counter',
    ),
  /缺少 tests 数组/);

  assert.throws(() =>
    summarizePlaywrightReport(
      {
        errors: [],
        suites: [{ specs: [{ title: 'E2E-CNT-001 a', tests: [{ projectName: 'counter', expectedStatus: 'passed', status: 'expected', results: 'bad' }] }] }],
      },
      'counter',
    ),
  /缺少 results 数组/);
});

test('matchCaseIds 拒绝重复 caseId 而非 Set 去重', () => {
  assert.equal(matchCaseIds(['A', 'B'], ['A', 'A']).ok, false);
  assert.match(matchCaseIds(['A', 'B'], ['A', 'A']).detail, /重复/);
  assert.equal(matchCaseIds(['A', 'A'], ['A']).ok, false);
  assert.match(matchCaseIds(['A', 'A'], ['A']).detail, /重复/);
});

test('buildBrowserGateEnv 白名单环境且不带凭据/代理，注入 E2E 接口变量', () => {
  const prev = {
    GH_TOKEN: process.env.GH_TOKEN,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    PI_MODEL: process.env.PI_MODEL,
  };
  process.env.GH_TOKEN = '{{SECRET_gh}}';
  process.env.HTTPS_PROXY = 'http://proxy:8080';
  process.env.PI_MODEL = 'workbuddy/deepseek-v4.1-flash';
  try {
    const env = buildBrowserGateEnv({
      jobTmp: '/job',
      reportDir: '/job/report',
      baseUrl: 'http://127.0.0.1:4321/',
      version: 'abc123',
      browserCacheDir: '/browsers',
      video: 'retain-on-failure',
    });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.PI_MODEL, undefined);
    assert.equal(env.SPEC_LOOP_E2E_BASE_URL, 'http://127.0.0.1:4321/');
    assert.equal(env.SPEC_LOOP_E2E_VERSION, 'abc123');
    assert.equal(env.SPEC_LOOP_E2E_REPORT_DIR, '/job/report');
    assert.equal(env.SPEC_LOOP_E2E_VIDEO, 'retain-on-failure');
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/browsers');
    assert.equal(env.HOME, '/job/home');
    assert.equal(env.TMPDIR, '/job/tmp');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('buildBrowserGateEnv 注入 SPEC_LOOP_E2E_VIDEO 且父进程非法值不能污染', () => {
  const prev = process.env.SPEC_LOOP_E2E_VIDEO;
  process.env.SPEC_LOOP_E2E_VIDEO = 'bogus-from-parent';
  try {
    const on = buildBrowserGateEnv({
      jobTmp: '/job',
      reportDir: '/job/report',
      baseUrl: 'http://127.0.0.1:4321/',
      version: 'abc123',
      browserCacheDir: '/browsers',
      video: 'on',
    });
    assert.equal(on.SPEC_LOOP_E2E_VIDEO, 'on');

    const failure = buildBrowserGateEnv({
      jobTmp: '/job',
      reportDir: '/job/report',
      baseUrl: 'http://127.0.0.1:4321/',
      version: 'abc123',
      browserCacheDir: '/browsers',
      video: 'retain-on-failure',
    });
    assert.equal(failure.SPEC_LOOP_E2E_VIDEO, 'retain-on-failure');
  } finally {
    if (prev === undefined) delete process.env.SPEC_LOOP_E2E_VIDEO;
    else process.env.SPEC_LOOP_E2E_VIDEO = prev;
  }
});

test('materializeBrowserEvidence 复制真实附件并生成不透明 ID，拒绝越界与 symlink 逃逸', () => {
  const reportDir = mkdtempSync(join(tmpdir(), 'spec-loop-report-'));
  const managed = mkdtempSync(join(tmpdir(), 'spec-loop-managed-'));
  writeFileSync(join(reportDir, 'video.webm'), 'webm-bytes', 'utf8');
  writeFileSync(join(reportDir, 'shot.png'), 'png-bytes', 'utf8');
  writeFileSync(join(reportDir, 'trace.zip'), 'zip-bytes', 'utf8');
  writeFileSync(join(reportDir, 'results.json'), '{"stats":{}}', 'utf8');

  const outside = join(reportDir, '..', 'outside.webm');
  writeFileSync(outside, 'outside-bytes', 'utf8');
  symlinkSync(outside, join(reportDir, 'leak.webm'));

  const raw = {
    suites: [
      {
        title: 'counter.spec.ts',
        file: 'counter.spec.ts',
        specs: [
          {
            title: 'E2E-CNT-001 a',
            ok: true,
            tests: [
              {
                expectedStatus: 'passed',
                projectName: 'counter',
                status: 'expected',
                results: [
                  {
                    status: 'passed',
                    retry: 0,
                    duration: 1,
                    attachments: [
                      { name: 'video', contentType: 'video/webm', path: join(reportDir, 'video.webm') },
                      { name: 'screenshot', contentType: 'image/png', path: join(reportDir, 'shot.png') },
                      { name: 'trace', contentType: 'application/zip', path: join(reportDir, 'trace.zip') },
                      { name: 'leak', contentType: 'video/webm', path: join(reportDir, 'leak.webm') },
                      { name: 'outside', contentType: 'video/webm', path: outside },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = materializeBrowserEvidence({
    raw,
    project: 'counter',
    reportPath: join(reportDir, 'results.json'),
    reportDir,
    managedRunDir: managed,
  });

  assert.equal(result.cases.length, 1);
  const caseArtifacts = result.cases[0]!.artifacts;
  assert.equal(caseArtifacts.length, 3);
  assert.deepEqual(caseArtifacts.map((artifact) => artifact.kind).sort(), ['screenshot', 'trace', 'video']);
  for (const artifact of caseArtifacts) {
    assert.match(artifact.id, /^artifact-/);
    assert.ok(existsSync(join(managed, artifact.id)));
  }

  // 越界与 symlink 源未复制；受管目录仅含 3 个 case 附件 + 1 个原始 results.json。
  assert.equal(readdirSync(managed).length, 4);
  assert.equal(result.runArtifacts.length, 1);
  assert.equal(result.runArtifacts[0]!.kind, 'json');
  assert.equal(result.runArtifacts[0]!.name, 'results.json');
  assert.ok(existsSync(join(managed, result.runArtifacts[0]!.id)));
});

test('buildBrowserGateSandboxSpec 放行浏览器缓存且网络只允许本机固定端口', () => {
  const browserDir = mkdtempSync(join(tmpdir(), 'spec-loop-browsers-'));
  const isolation = buildIsolationPaths(mkdtempSync(join(tmpdir(), 'spec-loop-repo-')));
  const suiteDir = mkdtempSync(join(tmpdir(), 'spec-loop-suite-'));
  const trustedNodeModules = mkdtempSync(join(tmpdir(), 'spec-loop-node-modules-'));
  const spec = buildBrowserGateSandboxSpec({
    isolation,
    jobTmp: '/job',
    browserCacheDir: browserDir,
    port: 4321,
    globalAgentDir: '',
    agentDir: '',
    suiteDir,
    trustedNodeModules,
  });
  assert.ok(spec.allowReadDirs.includes(browserDir));
  assert.ok(spec.allowReadDirs.includes(suiteDir));
  assert.ok(spec.allowReadDirs.includes(trustedNodeModules));
  assert.equal(spec.denyNetwork, true);
  assert.deepEqual(spec.allowNetworkRules, ['(allow network-outbound (remote tcp4 "localhost:4321"))']);
  // suiteDir 只读：只有 runDir（jobTmp）可写，副本目录不得出现 file-write* 放行。
  assert.deepEqual(spec.writableDirs, ['/job']);
  assert.ok(!spec.writableDirs.includes(suiteDir));

  const profile = buildSandboxProfile(spec);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(allow network-outbound \(remote tcp4 "localhost:4321"\)\)/);
  assert.match(profile, new RegExp(`allow file-read-data \\(subpath "${browserDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`));
  assert.match(profile, new RegExp(`allow file-read-data \\(subpath "${suiteDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`));
  assert.match(profile, new RegExp(`allow file-read-data \\(subpath "${trustedNodeModules.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`));
  assert.ok(!new RegExp(`allow file-write\\* \\(subpath "${suiteDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`).test(profile));
});

test('buildLoopbackPortRule 与 resolveBrowserCacheDir 默认值', () => {
  assert.equal(buildLoopbackPortRule(1234), '(allow network-outbound (remote tcp4 "localhost:1234"))');
  const explicit = resolveBrowserCacheDir({ PLAYWRIGHT_BROWSERS_PATH: '/x' });
  assert.equal(explicit, '/x');
});

test('computeE2eSuiteFingerprint 对文件内容稳定且顺序无关', () => {
  const a = computeE2eSuiteFingerprint({ 'b.ts': '1', 'a.ts': '2' });
  const b = computeE2eSuiteFingerprint({ 'a.ts': '2', 'b.ts': '1' });
  assert.equal(a, b);
  assert.notEqual(a, computeE2eSuiteFingerprint({ 'a.ts': '2', 'b.ts': '3' }));
});

test('createCandidateStaticServer 只服务候选产物并拒绝 symlink 逃逸', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实 HTTP 集成仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试网络');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实 HTTP 测试但不降级为 mock');
    return;
  }
  // 门禁静态服务始终绑定 127.0.0.1 临时端口；本测试与主验收一致要求可本机 listen。
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-artifact-'));
  writeFileSync(join(dir, 'index.html'), '<script src="/assets/app.js"></script>', 'utf8');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'ok', 'utf8');
  const outside = join(dir, '..', 'outside.txt');
  writeFileSync(outside, 'secret', 'utf8');
  symlinkSync(outside, join(dir, 'assets', 'leak.txt'));

  const server = createCandidateStaticServer({ artifactDir: dir, mountPath: '/releases/abc/' });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  const status = async (path: string): Promise<number> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
    await res.arrayBuffer();
    return res.status;
  };
  try {
    assert.equal(await status('/releases/abc/'), 200);
    assert.equal(await status('/releases/abc/assets/app.js'), 200);
    assert.equal(await status('/releases/other/index.html'), 404);
    assert.equal(await status('/'), 404);
    assert.equal(await status('/releases/abc/assets/leak.txt'), 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('runBrowserGate 成功路径：契约匹配且报告校验通过', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实浏览器门禁集成仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试 listen');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实门禁测试但不降级为 mock');
    return;
  }

  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const e2eRoot = mkdtempSync(join(tmpdir(), 'spec-loop-e2e-'));
  const browserCache = mkdtempSync(join(tmpdir(), 'spec-loop-browsers-'));
  const artifactDir = mkdtempSync(join(tmpdir(), 'spec-loop-dist-'));
  writeFileSync(join(artifactDir, 'index.html'), '<main>ok</main>', 'utf8');
  const { files, contract } = counterSpec();
  mkdirSync(join(repoDir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(repoDir, 'docs', 'specs', 'counter.md'), files['docs/specs/counter.md']!, 'utf8');
  setupE2eRoot(e2eRoot, contract);

  let runnerEnv: Record<string, string> = {};
  const result = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    reqId: 'REQ-CNT-01',
    specFiles: files,
    jobTmp: join(repoDir, '.orchestrator', 'browser', 'job'),
    browserCacheDir: browserCache,
    logger: silentLogger,
    execBin: process.execPath,
    runner: async (opts): Promise<BrowserGateRunnerResult> => {
      runnerEnv = opts.env;
      const reportDir = opts.env.SPEC_LOOP_E2E_REPORT_DIR;
      mkdirSync(reportDir!, { recursive: true });
      writeFileSync(join(reportDir!, 'results.json'), JSON.stringify(makeReport(['E2E-CNT-001 a', 'E2E-CNT-002 b'])), 'utf8');
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.summary?.specCount, 2);
  assert.deepEqual(result.executedCaseIds, ['E2E-CNT-001', 'E2E-CNT-002']);
  assert.ok(result.suiteFingerprint);
  assert.ok(result.receiptPath);
  assert.ok(existsSync(result.receiptPath!));
  const receipt = JSON.parse(readFileSync(result.receiptPath!, 'utf8')) as Record<string, unknown>;
  assert.equal(receipt.kind, 'browser-gate-receipt');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.project, 'counter');
  assert.equal(receipt.displayVersion, 'abc');
  assert.equal(runnerEnv.SPEC_LOOP_E2E_VERSION, 'abc');
  assert.match(runnerEnv.SPEC_LOOP_E2E_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(runnerEnv.GH_TOKEN, undefined);
});

test('runBrowserGate 冻结副本与源套件修改隔离，且同 job 不读旧响应或删除历史 attempt', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实浏览器门禁集成仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试 listen');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实门禁测试但不降级为 mock');
    return;
  }

  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const e2eRoot = mkdtempSync(join(tmpdir(), 'spec-loop-e2e-'));
  const artifactDir = mkdtempSync(join(tmpdir(), 'spec-loop-dist-'));
  const browserCacheDir = mkdtempSync(join(tmpdir(), 'spec-loop-browsers-'));
  const jobTmp = join(mkdtempSync(join(tmpdir(), 'spec-loop-job-')), 'browser');
  writeFileSync(join(artifactDir, 'index.html'), '<main>ok</main>', 'utf8');
  const { files, contract } = counterSpec();
  mkdirSync(join(repoDir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(repoDir, 'docs', 'specs', 'counter.md'), files['docs/specs/counter.md']!, 'utf8');
  setupE2eRoot(e2eRoot, contract);
  const sourceSuitePath = join(e2eRoot, 'tests', 'e2e', 'counter.spec.ts');
  const runnerOptions: import('../orchestrator/browser-gate.ts').BrowserGateRunnerOptions[] = [];
  let runCount = 0;
  const result = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    reqId: 'REQ-CNT-01',
    specFiles: files,
    jobTmp,
    browserCacheDir,
    logger: silentLogger,
    execBin: process.execPath,
    runner: async (opts): Promise<BrowserGateRunnerResult> => {
      runnerOptions.push(opts);
      runCount += 1;
      assert.equal(readFileSync(join(opts.cwd, 'tests', 'e2e', 'counter.spec.ts'), 'utf8'), "test('E2E-CNT-001 x', () => {});\n");
      assert.equal(opts.cliArgs[5], join(opts.cwd, 'playwright.config.ts'));
      assert.equal(opts.spec.writableDirs.length, 1);
      const normalizedCwd = realpathSync(resolve(opts.cwd));
      for (const writableDir of opts.spec.writableDirs) {
        const normalizedWritable = realpathSync(resolve(writableDir));
        const rel = relative(normalizedWritable, normalizedCwd);
        assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
      }
      writeFileSync(sourceSuitePath, "test('E2E-CNT-001 changed', () => {});\n", 'utf8');
      assert.equal(readFileSync(join(opts.cwd, 'tests', 'e2e', 'counter.spec.ts'), 'utf8'), "test('E2E-CNT-001 x', () => {});\n");
      const reportDir = opts.env.SPEC_LOOP_E2E_REPORT_DIR;
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'results.json'), JSON.stringify(makeReport(['E2E-CNT-001 a', 'E2E-CNT-002 b'])), 'utf8');
      return { code: 0, stdout: 'first attempt', stderr: '', timedOut: false };
    },
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(runCount, 1);
  const first = runnerOptions[0]!;
  const suiteFile = readFileSync(join(first.cwd, 'tests', 'e2e', 'counter.spec.ts'), 'utf8');
  assert.match(suiteFile, /E2E-CNT-001 x/);
  assert.equal(computeE2eSuiteFingerprint(Object.fromEntries(
    ['playwright.config.ts', 'tests/e2e/counter.spec.ts', 'tests/e2e/contracts/counter.json'].map((path) => [
      path,
      readFileSync(join(first.cwd, path), 'utf8'),
    ]),
  )), result.suiteFingerprint);
  assert.ok(existsSync(result.reportPath));
  assert.ok(existsSync(result.receiptPath!));
  const firstRunRoot = dirname(first.cwd).slice(0, dirname(first.cwd).lastIndexOf(`${sep}suite-`));
  const firstReport = result.reportPath;
  let secondRunRoot = '';

  const second = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    reqId: 'REQ-CNT-01',
    specFiles: files,
    jobTmp,
    browserCacheDir,
    logger: silentLogger,
    execBin: process.execPath,
    runner: async (opts): Promise<BrowserGateRunnerResult> => {
      secondRunRoot = dirname(opts.cwd);
      return { code: 0, stdout: 'no report', stderr: '', timedOut: false };
    },
  });
  assert.equal(second.ok, false);
  assert.match(second.detail, /缺少 Playwright JSON 报告/);
  assert.notEqual(secondRunRoot, firstRunRoot, `${secondRunRoot} === ${firstRunRoot}`);
  assert.ok(!existsSync(second.reportPath));
  assert.equal(readFileSync(firstReport, 'utf8'), JSON.stringify(makeReport(['E2E-CNT-001 a', 'E2E-CNT-002 b'])));
  assert.ok(existsSync(result.receiptPath!));
});

test('runBrowserGate 缺浏览器缓存或缺报告/契约过期 fail-closed', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const e2eRoot = mkdtempSync(join(tmpdir(), 'spec-loop-e2e-'));
  const artifactDir = mkdtempSync(join(tmpdir(), 'spec-loop-dist-'));
  writeFileSync(join(artifactDir, 'index.html'), '<main>ok</main>', 'utf8');
  const { files, contract } = counterSpec();
  mkdirSync(join(repoDir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(repoDir, 'docs', 'specs', 'counter.md'), files['docs/specs/counter.md']!, 'utf8');
  setupE2eRoot(e2eRoot, contract);

  const missingBrowser = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    specFiles: files,
    jobTmp: join(repoDir, '.orchestrator', 'browser', 'job'),
    browserCacheDir: join(repoDir, 'does-not-exist-browsers'),
    logger: silentLogger,
    execBin: process.execPath,
  });
  assert.equal(missingBrowser.ok, false);
  assert.match(missingBrowser.detail, /浏览器缓存目录缺失/);

  const staleContract = { ...contract, specHash: 'b'.repeat(64) };
  setupE2eRoot(e2eRoot, staleContract);
  const stale = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    specFiles: files,
    jobTmp: join(repoDir, '.orchestrator', 'browser', 'job2'),
    browserCacheDir: mkdtempSync(join(tmpdir(), 'spec-loop-browsers-')),
    logger: silentLogger,
    execBin: process.execPath,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /验收基线待独立维护/);
});

test('runBrowserGate 非零退出时返回报告/日志定位与有界尾部', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实浏览器门禁集成仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试 listen');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实门禁测试但不降级为 mock');
    return;
  }
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const e2eRoot = mkdtempSync(join(tmpdir(), 'spec-loop-e2e-'));
  const artifactDir = mkdtempSync(join(tmpdir(), 'spec-loop-dist-'));
  writeFileSync(join(artifactDir, 'index.html'), '<main>ok</main>', 'utf8');
  const { files, contract } = counterSpec();
  mkdirSync(join(repoDir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(repoDir, 'docs', 'specs', 'counter.md'), files['docs/specs/counter.md']!, 'utf8');
  setupE2eRoot(e2eRoot, contract);

  const result = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    specFiles: files,
    jobTmp: join(repoDir, '.orchestrator', 'browser', 'job-fail'),
    browserCacheDir: mkdtempSync(join(tmpdir(), 'spec-loop-browsers-')),
    logger: silentLogger,
    execBin: process.execPath,
    runner: async () => ({
      code: 1,
      stdout: 'stdout evidence',
      stderr: 'stderr evidence',
      timedOut: false,
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /退出码 1/);
  assert.match(result.detail, new RegExp(result.reportDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.detail, new RegExp(result.stdoutLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.detail, new RegExp(result.stderrLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.detail, /stderr evidence/);
  assert.ok(existsSync(result.stdoutLogPath));
  assert.ok(existsSync(result.stderrLogPath));
  assert.ok(existsSync(result.receiptPath!));
});

test('runBrowserGate 将附件与 jobId 写入 test-runs 受管记录，href 与文件一致', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实浏览器门禁集成仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试 listen');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实门禁测试但不降级为 mock');
    return;
  }

  const repoDir = mkdtempSync(join(tmpdir(), 'spec-loop-repo-'));
  const e2eRoot = mkdtempSync(join(tmpdir(), 'spec-loop-e2e-'));
  const browserCache = mkdtempSync(join(tmpdir(), 'spec-loop-browsers-'));
  const artifactDir = mkdtempSync(join(tmpdir(), 'spec-loop-dist-'));
  const testRunsRoot = mkdtempSync(join(tmpdir(), 'spec-loop-test-runs-'));
  writeFileSync(join(artifactDir, 'index.html'), '<main>ok</main>', 'utf8');
  const { files, contract } = counterSpec();
  mkdirSync(join(repoDir, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(repoDir, 'docs', 'specs', 'counter.md'), files['docs/specs/counter.md']!, 'utf8');
  setupE2eRoot(e2eRoot, contract);

  let videoPath = '';
  const result = await runBrowserGate({
    repoDir,
    e2eRoot,
    artifactDir,
    mountPath: '/',
    version: 'abc',
    project: 'counter',
    reqId: 'REQ-CNT-01',
    specFiles: files,
    jobTmp: join(repoDir, '.orchestrator', 'browser', 'job-evidence'),
    browserCacheDir: browserCache,
    logger: silentLogger,
    execBin: process.execPath,
    testRunsRoot,
    evidenceStage: 'worker',
    jobId: 'job-123',
    sourceMainSha: '1'.repeat(40),
    candidateTreeSha: '2'.repeat(40),
    video: 'on',
    runner: async (opts) => {
      const reportDir = opts.env.SPEC_LOOP_E2E_REPORT_DIR!;
      mkdirSync(reportDir, { recursive: true });
      videoPath = join(reportDir, 'video.webm');
      writeFileSync(videoPath, 'webm-bytes', 'utf8');
      const report = makeReport(['E2E-CNT-001 a', 'E2E-CNT-002 b'], (spec) => {
        const testRecord = (spec.tests as unknown[])[0] as Record<string, unknown>;
        const resultRecord = (testRecord.results as unknown[])[0] as Record<string, unknown>;
        resultRecord.attachments = [{ name: 'video', contentType: 'video/webm', path: videoPath }];
      });
      writeFileSync(join(reportDir, 'results.json'), JSON.stringify(report), 'utf8');
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  });

  assert.equal(result.ok, true, result.detail);
  assert.ok(result.testRunRecord);
  const record = result.testRunRecord;
  assert.equal(record.jobId, 'job-123');
  assert.equal(record.sourceMainSha, '1'.repeat(40));
  assert.equal(record.candidateTreeSha, '2'.repeat(40));
  assert.equal(record.stage, 'worker');

  const managedDir = join(testRunsRoot, record.id);
  assert.ok(existsSync(managedDir));
  const caseArtifacts = record.cases.flatMap((item) => item.artifacts);
  assert.ok(caseArtifacts.length >= 1);
  for (const artifact of caseArtifacts) {
    assert.match(artifact.id, /^artifact-/);
    assert.ok(existsSync(join(managedDir, artifact.id)));
  }
  assert.ok(record.artifacts && record.artifacts.length >= 1);
  assert.equal(record.artifacts[0]!.kind, 'json');
  assert.ok(existsSync(join(managedDir, record.artifacts[0]!.id)));

  const store = createTestEvidenceStore({ rootDir: testRunsRoot });
  const view = store.listRuns();
  assert.ok(view.runs.some((run) => run.id === record.id));
  assert.ok(store.readRunArtifact(record.id, record.artifacts[0]!.id));
});
