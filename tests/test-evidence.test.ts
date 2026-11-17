import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  artifactKindFromName,
  createManualTestRunRecord,
  createTestEvidenceStore,
  parseTestRunRecord,
  writeTestRunRecord,
  type FixedTestSummary,
  type TestArtifactSummary,
  type TestRunRecord,
} from '../orchestrator/test-evidence.ts';
import { createNodeTestRunRecord, parseNodeTestStdout } from '../orchestrator/test-evidence-node.ts';

function sampleRecord(overrides: Partial<TestRunRecord> = {}): TestRunRecord {
  return {
    id: 'manual-run-1',
    stage: 'manual',
    runner: 'node:test',
    version: 'v1',
    startedAt: '2026-11-16T00:00:00.000Z',
    finishedAt: '2026-11-16T00:00:01.000Z',
    jobId: null,
    reqId: null,
    specHash: null,
    sourceMainSha: null,
    candidateTreeSha: null,
    suiteFingerprint: null,
    ok: true,
    summary: {
      runner: 'node:test',
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0,
      durationMs: 10,
      unknown: false,
    },
    cases: [],
    ...overrides,
  };
}

test('parseNodeTestStdout 解析 Node24 spec footer 并校验计数一致', () => {
  const stdout = [
    '✔ a',
    '✔ b',
    'ℹ tests 2',
    'ℹ pass 2',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 42',
    'error stack after footer should not affect counts',
  ].join('\n');
  const summary = parseNodeTestStdout(stdout);
  assert.equal(summary.runner, 'node:test');
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.durationMs, 42);
  assert.equal(summary.unknown, false);
});

test('parseNodeTestStdout 支持可选 TAP footer', () => {
  const summary = parseNodeTestStdout(
    [
      'TAP version 13',
      'ok 1',
      'ok 2',
      '# tests 2',
      '# pass 2',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
      '# duration_ms 12.5',
    ].join('\n'),
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.durationMs, 12.5);
  assert.equal(summary.unknown, false);
});

test('parseNodeTestStdout 识别 Node24 suites 元数据且不切分 spec/TAP footer', () => {
  for (const [marker, suites] of [
    ['ℹ', '0'],
    ['#', '0'],
    ['ℹ', '2'],
  ] as const) {
    const summary = parseNodeTestStdout(
      [
        `${marker} tests 4`,
        `${marker} suites ${suites}`,
        `${marker} pass 1`,
        `${marker} fail 1`,
        `${marker} cancelled 0`,
        `${marker} skipped 1`,
        `${marker} todo 1`,
        `${marker} duration_ms 54.632875`,
      ].join('\n'),
    );
    assert.deepEqual(
      [summary.total, summary.passed, summary.failed, summary.skipped, summary.todo, summary.cancelled],
      [4, 1, 1, 1, 1, 0],
    );
    assert.equal(summary.durationMs, 54.632875);
    assert.equal(summary.unknown, false);
  }
  const invalidSuites = parseNodeTestStdout(
    ['ℹ tests 2', 'ℹ suites 1.5', 'ℹ pass 2', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join(
      '\n',
    ),
  );
  assert.equal(invalidSuites.unknown, true);
});

test('parseNodeTestStdout 计数不一致或缺失显示 unknown，不猜绿', () => {
  assert.equal(parseNodeTestStdout('no footer').unknown, true);
  const inconsistent = parseNodeTestStdout(
    ['ℹ tests 3', 'ℹ pass 2', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n'),
  );
  assert.equal(inconsistent.unknown, true);
  assert.equal(inconsistent.skipped, null);
});

test('parseNodeTestStdout 每个 footer 字段缺失时保持 null，不复用其他块或伪补0', () => {
  const complete = {
    tests: '2',
    pass: '2',
    fail: '0',
    cancelled: '0',
    skipped: '0',
    todo: '0',
  };
  for (const field of Object.keys(complete)) {
    const values = { ...complete } as Record<string, string>;
    delete values[field];
    const lines = Object.entries(values).map(([key, value]) => `ℹ ${key} ${value}`);
    const summary = parseNodeTestStdout(['✔ a', '✔ b', ...lines].join('\n'));
    assert.equal(summary.unknown, true, `missing ${field}`);
    assert.equal(
      field === 'tests'
        ? summary.total
        : field === 'pass'
          ? summary.passed
          : field === 'fail'
            ? summary.failed
            : summary[field as 'cancelled' | 'skipped' | 'todo'],
      null,
      `not filled: ${field}`,
    );
  }
});

test('parseNodeTestStdout 拒绝负数、非整数、不安全整数和 ANSI 混合规范计数', () => {
  for (const value of ['-1', '1.5', '9007199254740992']) {
    const summary = parseNodeTestStdout(
      ['ℹ tests 2', 'ℹ pass 2', `ℹ fail ${value}`, 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n'),
    );
    assert.equal(summary.unknown, true, value);
  }
  const clean = parseNodeTestStdout(
    [
      '\u001b[32mℹ tests 2\u001b[0m',
      '\u001b[32mℹ pass 1\u001b[0m',
      'ℹ fail 1',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 8',
    ].join('\n'),
  );
  assert.equal(clean.unknown, false);
  assert.equal(clean.durationMs, 8);
});

test('parseNodeTestStdout 零实际用例、截断块和 formatter 混拼均不算通过', () => {
  const zero = parseNodeTestStdout(
    ['ℹ tests 0', 'ℹ pass 0', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n'),
  );
  assert.equal(zero.unknown, true);
  assert.equal(zero.total, 0);
  const truncations = [
    ['ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n').slice(0, 16),
    [
      '(truncated) ℹ tests 2',
      'ℹ pass 2',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
    ].join('\n'),
  ];
  for (const truncated of truncations) assert.equal(parseNodeTestStdout(truncated).unknown, true);
  const mixed = parseNodeTestStdout(
    ['ℹ tests 2', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n'),
  );
  assert.equal(mixed.unknown, true);

  const completeBlocks = parseNodeTestStdout(
    [
      'ℹ tests 2',
      'ℹ pass 2',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 4',
      'ℹ tests 3',
      'ℹ pass 2',
      'ℹ fail 1',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 7',
      '✖ final failure stack',
    ].join('\n'),
  );
  assert.equal(completeBlocks.unknown, false);
  assert.equal(completeBlocks.failed, 1);
  assert.equal(completeBlocks.total, 3);
  assert.equal(completeBlocks.durationMs, 7);
});

test('parseNodeTestStdout 末尾截断或零值 footer 保持 unknown，不回退到早先成功块', () => {
  const earlier = [
    'ℹ tests 2',
    'ℹ suites 0',
    'ℹ pass 2',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 4',
  ];
  for (const { later, total } of [
    {
      later: [
        'ℹ tests 3',
        'ℹ suites 0',
        'ℹ pass 2',
        'ℹ fail 1',
        'ℹ cancelled 0',
        'ℹ skipped 0',
        'ℹ todo 0',
      ],
      total: 3,
    },
    {
      later: ['ℹ tests 3', 'ℹ suites 0', 'ℹ pass 2', 'ℹ fail 1'],
      total: null,
    },
    {
      later: [
        'ℹ tests 0',
        'ℹ suites 0',
        'ℹ pass 0',
        'ℹ fail 0',
        'ℹ cancelled 0',
        'ℹ skipped 0',
        'ℹ todo 0',
      ],
      total: 0,
    },
  ]) {
    const summary = parseNodeTestStdout([...earlier, ...later].join('\n'));
    assert.equal(summary.unknown, true);
    assert.equal(summary.total, total);
    assert.equal(summary.durationMs, null);
  }
});

test('node:test record 不把 failing tests 统计标题当作失败用例', () => {
  const record = createNodeTestRunRecord({
    stage: 'manual',
    ok: false,
    stdout: [
      '✖ actual failing case',
      '  ✖ failing tests:',
      '  ✖ failing tests:',
      'ℹ tests 2',
      'ℹ suites 0',
      'ℹ pass 1',
      'ℹ fail 1',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
    ].join('\n'),
  });
  assert.deepEqual(record.cases.map((testCase) => testCase.title), ['actual failing case']);
});

test('node:test record 保留可读失败名，显式 null 开始时间保持未知', () => {
  const record = createNodeTestRunRecord({
    id: 'node-failure-run',
    stage: 'manual',
    startedAt: null,
    ok: false,
    stdout: [
      '✖ expected counter ✓ doubled',
      '✖ Bearer super-secret fails',
      '✖ expected counter ✓ doubled',
      'ℹ tests 3',
      'ℹ pass 1',
      'ℹ fail 2',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
    ].join('\n'),
  });
  assert.equal(record.startedAt, null);
  assert.equal(record.cases.length, 2);
  assert.equal(record.cases[0]?.title, 'expected counter ✓ doubled');
  assert.equal(record.cases[0]?.durationMs, null);
  assert.equal(record.cases[1]?.title, 'Bearer [REDACTED] fails');
  assert.equal(createManualTestRunRecord({ stage: 'manual', runner: 'manual' }).startedAt === null, false);
});

test('parseTestRunRecord 拒绝非法 id/sha/类型并脱敏错误', () => {
  assert.equal(parseTestRunRecord(null), null);
  assert.equal(parseTestRunRecord({ id: '../bad', stage: 'worker', runner: 'node:test' }), null);
  assert.equal(parseTestRunRecord({ id: 'x', stage: 'nope', runner: 'node:test' }), null);
  assert.equal(parseTestRunRecord({ id: 'x', stage: 'worker', runner: 'node:test', sourceMainSha: 'bad' }), null);

  const parsed = parseTestRunRecord({
    ...sampleRecord(),
    cases: [{ id: 'A', title: 'x', status: 'failed', error: 'Bearer super-secret', artifacts: [] }],
  });
  assert.ok(parsed);
  assert.equal(parsed.cases[0]?.error, 'Bearer [REDACTED]');
});

test('失败错误文本先剥离 ANSI 再脱敏和截断，不把控制码带到面板', () => {
  const parsed = parseTestRunRecord({
    ...sampleRecord(),
    cases: [
      {
        id: 'A',
        title: '失败',
        status: 'failed',
        error: '\u001b[2mExpected\u001b[39m \u001b[31mBearer secret-token\u001b[39m',
        artifacts: [],
      },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.cases[0]?.error, 'Expected Bearer [REDACTED]');
  assert.doesNotMatch(parsed.cases[0]?.error ?? '', /\u001b|\u009b/);

  const long = parseTestRunRecord({
    ...sampleRecord(),
    cases: [
      {
        id: 'B',
        title: '长失败',
        status: 'failed',
        error: '\u001b[2m' + 'x'.repeat(900) + '\u001b[39m',
        artifacts: [],
      },
    ],
  });
  assert.equal(long?.cases[0]?.error, `${'x'.repeat(800)}…`);
});

test('test evidence store 只读索引受控文件且拒绝路径穿越/symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-'));
  writeTestRunRecord(root, sampleRecord());
  const store = createTestEvidenceStore({ rootDir: root });
  const view = store.listRuns();
  assert.equal(view.schemaVersion, 'test-runs/v1');
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0]!.id, 'manual-run-1');

  writeFileSync(join(root, 'manual-run-1', 'shot-1'), 'png-bytes');
  const manifest = sampleRecord({
    cases: [
      {
        id: 'A',
        title: 'case a',
        status: 'failed',
        durationMs: null,
        error: null,
        artifacts: [{ id: 'shot-1', kind: 'screenshot', name: 'a.png', href: '' }],
      },
    ],
  });
  writeTestRunRecord(root, manifest);

  const found = store.readRunArtifact('manual-run-1', 'shot-1');
  assert.ok(found);
  assert.equal(found.kind, 'screenshot');
  assert.equal(found.size, 9);
  assert.equal(store.readRunArtifact('../manual-run-1', 'shot-1'), null);
  assert.equal(store.readRunArtifact('manual-run-1', '../shot-1'), null);

  const outside = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-outside-'));
  const leak = join(outside, 'leak.png');
  writeFileSync(leak, 'leak');
  symlinkSync(leak, join(root, 'manual-run-1', 'symlink-leak'));
  assert.equal(store.readRunArtifact('manual-run-1', 'symlink-leak'), null);
});

test('artifactKindFromName 只接受已知附件类型', () => {
  assert.equal(artifactKindFromName('x.png'), 'screenshot');
  assert.equal(artifactKindFromName('x.webm'), 'video');
  assert.equal(artifactKindFromName('trace.zip'), 'trace');
  assert.equal(artifactKindFromName('x.json'), 'json');
  assert.equal(artifactKindFromName('x.html'), null);
});

test('artifactKindFor 要求 path 扩展名和 MIME 兼容，拒绝 HTML 伪装', async () => {
  const { artifactKindFor } = await import('../orchestrator/browser-gate.ts');
  assert.equal(artifactKindFor('image/png', '/tmp/a.png'), 'screenshot');
  assert.equal(artifactKindFor('image/png', '/tmp/a'), 'screenshot');
  assert.equal(artifactKindFor('image/png', '/tmp/a.html'), null);
  assert.equal(artifactKindFor('video/webm', '/tmp/a.webm'), 'video');
  assert.equal(artifactKindFor('video/webm', '/tmp/a.zip'), null);
  assert.equal(artifactKindFor('application/zip', '/tmp/a.json'), null);
  assert.equal(artifactKindFor(undefined, '/tmp/a.webm'), 'video');
  assert.equal(artifactKindFor(undefined, '/tmp/a.html'), null);
});

test('parseTestRunRecord 缺摘要保持 null，畸形/负/非整数计数明确 unknown', () => {
  const noSummary = parseTestRunRecord({ ...sampleRecord(), summary: null });
  assert.ok(noSummary);
  assert.equal(noSummary.summary, null);

  const truncated = parseTestRunRecord({
    ...sampleRecord(),
    summary: { runner: 'node:test', total: 3, passed: 2, failed: 0 },
  });
  assert.equal(truncated?.summary && (truncated.summary as FixedTestSummary).unknown, true);

  const negative = parseTestRunRecord({
    ...sampleRecord(),
    summary: {
      runner: 'node:test',
      total: 2,
      passed: -1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0,
    },
  });
  assert.equal(negative?.summary && (negative.summary as FixedTestSummary).unknown, true);

  const nonInteger = parseTestRunRecord({
    ...sampleRecord(),
    summary: {
      runner: 'node:test',
      total: 2,
      passed: 1.5,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0,
    },
  });
  assert.equal(nonInteger?.summary && (nonInteger.summary as FixedTestSummary).unknown, true);

  const inconsistent = parseTestRunRecord({
    ...sampleRecord(),
    summary: {
      runner: 'node:test',
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 0,
      cancelled: 0,
      todo: 0,
    },
  });
  assert.equal(inconsistent?.summary && (inconsistent.summary as FixedTestSummary).unknown, true);

  const declaredUnknown = parseTestRunRecord({
    ...sampleRecord(),
    summary: { ...sampleRecord().summary, unknown: true },
  });
  assert.equal(declaredUnknown?.summary && (declaredUnknown.summary as FixedTestSummary).unknown, true);
  const browserDeclaredUnknown = parseTestRunRecord({
    ...sampleRecord(),
    runner: 'playwright',
    summary: {
      runner: 'playwright',
      specCount: 1,
      targetTestCount: 1,
      resultCount: 1,
      skipped: 0,
      flaky: 0,
      unexpected: 0,
      errorCount: 0,
      failedResultCount: 0,
      retriedCount: 0,
      unknown: true,
    },
  });
  assert.equal(browserDeclaredUnknown?.summary?.unknown, true);
});

test('run-level artifact 列表 href 可下载，manifest 自身 symlink 拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-run-art-'));
  writeTestRunRecord(
    root,
    sampleRecord({ artifacts: [{ id: 'raw-1', kind: 'json', name: 'results.json', href: '' }] }),
  );
  writeFileSync(join(root, 'manual-run-1', 'raw-1'), '{"stats":{}}', 'utf8');

  const store = createTestEvidenceStore({ rootDir: root });
  const view = store.listRuns();
  assert.equal(view.runs[0]?.artifacts?.length, 1);
  assert.equal(view.runs[0]?.artifacts?.[0]?.href, '/api/test-runs/manual-run-1/artifacts/raw-1');

  const artifact = store.readRunArtifact('manual-run-1', 'raw-1');
  assert.ok(artifact);
  assert.equal(artifact.kind, 'json');
  assert.equal(artifact.contentType, 'application/json');
  assert.ok(artifact.size > 0);

  const symlinkRoot = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-manifest-'));
  mkdirSync(join(symlinkRoot, 'manual-run-1'), { recursive: true });
  const outside = join(tmpdir(), 'spec-loop-outside-manifest.json');
  writeFileSync(outside, JSON.stringify(sampleRecord()), 'utf8');
  symlinkSync(outside, join(symlinkRoot, 'manual-run-1', 'test-run.json'));
  const symlinkStore = createTestEvidenceStore({ rootDir: symlinkRoot });
  assert.equal(symlinkStore.listRuns().runs.length, 0);
  assert.equal(symlinkStore.readRunArtifact('manual-run-1', 'raw-1'), null);
});

test('manifest id 与 runDir 不一致时拒绝列出与下载', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-mismatch-'));
  const record = sampleRecord({ id: 'manual-run-A' });
  mkdirSync(join(root, 'manual-run-B'), { recursive: true });
  writeFileSync(join(root, 'manual-run-B', 'test-run.json'), JSON.stringify(record), 'utf8');
  writeFileSync(join(root, 'manual-run-B', 'raw-1'), 'x', 'utf8');

  const store = createTestEvidenceStore({ rootDir: root });
  assert.equal(store.listRuns().runs.length, 0);
  assert.equal(store.readRunArtifact('manual-run-B', 'raw-1'), null);
});

test('collectRunDir 受 maxRuns/maxEntries/maxDepth 限制，不无界遍历', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-bound-'));
  writeTestRunRecord(root, sampleRecord({ id: 'manual-run-1' }));
  writeTestRunRecord(root, sampleRecord({ id: 'manual-run-2' }));
  writeTestRunRecord(root, sampleRecord({ id: 'manual-run-3' }));

  const store = createTestEvidenceStore({ rootDir: root, maxRuns: 2, maxEntries: 3, maxDepth: 2 });
  const view = store.listRuns();
  assert.ok(view.runs.length <= 2);

  const deepRoot = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-deep-'));
  let deep = deepRoot;
  for (let index = 0; index < 8; index += 1) deep = join(deep, `d${index}`);
  mkdirSync(deep, { recursive: true });
  writeTestRunRecord(deep, sampleRecord({ id: 'manual-run-deep' }));
  const shallow = createTestEvidenceStore({ rootDir: deepRoot, maxDepth: 2 });
  assert.equal(shallow.listRuns().runs.length, 0);
});

test('最近记录先按时间选择，再应用展示上限，不因目录顺序丢掉最新 run', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-recent-'));
  writeTestRunRecord(
    root,
    sampleRecord({ id: 'a-old', stage: 'worker', startedAt: '2026-11-16T00:00:00.000Z' }),
  );
  writeTestRunRecord(
    root,
    sampleRecord({ id: 'b-middle', stage: 'build', startedAt: '2026-11-16T01:00:00.000Z' }),
  );
  writeTestRunRecord(
    root,
    sampleRecord({ id: 'z-new', stage: 'browser', startedAt: '2026-11-16T02:00:00.000Z' }),
  );
  writeTestRunRecord(
    root,
    sampleRecord({ id: 'c-dateless', stage: 'manual', startedAt: null, finishedAt: null }),
  );
  const view = createTestEvidenceStore({ rootDir: root, maxRuns: 2, maxEntries: 20 }).listRuns();
  assert.deepEqual(view.runs.map((run) => run.id), ['z-new', 'b-middle']);
});

test('readRunArtifact 拒绝超过 maxArtifactBytes 的附件', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-size-'));
  writeTestRunRecord(
    root,
    sampleRecord({
      cases: [
        {
          id: 'A',
          title: 'a',
          status: 'passed',
          durationMs: null,
          error: null,
          artifacts: [{ id: 'big-1', kind: 'json', name: 'big.json', href: '' }],
        },
      ],
    }),
  );
  writeFileSync(join(root, 'manual-run-1', 'big-1'), '12345', 'utf8');
  const store = createTestEvidenceStore({ rootDir: root, maxArtifactBytes: 4 });
  assert.equal(store.readRunArtifact('manual-run-1', 'big-1'), null);
});
