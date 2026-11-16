import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createPanelServer, parseByteRange, resolveStaticAsset } from '../orchestrator/panel-server.ts';
import {
  buildPanelView,
  normalizeState,
  parsePanelState,
  safeTitle,
  type PanelMeta,
} from '../orchestrator/panel-view.ts';
import { parsePanelArgs } from '../orchestrator/panel.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { createManualTestRunRecord, createTestEvidenceStore, writeTestRunRecord } from '../orchestrator/test-evidence.ts';

const DOC = '### [REQ-CNT-01] 计数器\n\n实现一个递增计数器。\n';
const NEW_HASH = parseSpecs({ 'docs/specs/counter.md': DOC }).specs[0]!.hash;
const OLD_HASH = 'a'.repeat(64);
const NEW_SHA = '1'.repeat(40);
const OLD_SHA = '2'.repeat(40);
const REQUEST_ID = 'abcdef123456';

function meta(overrides: Partial<PanelMeta> = {}): PanelMeta {
  return {
    observedAt: '2026-11-15T00:00:00.000Z',
    stateUpdatedAt: '2026-11-15T00:00:00.000Z',
    stateKind: 'ok',
    controllerOnline: true,
    ...overrides,
  };
}

function requirement(specHash: string, sourceMainSha: string): Record<string, unknown> {
  return {
    issueNumber: 1,
    specHash,
    specPath: 'docs/specs/counter.md',
    sourceMainSha,
  };
}

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    jobId: 'job-x',
    reqId: 'REQ-CNT-01',
    issueNumber: 1,
    specHash: NEW_HASH,
    sourceMainSha: NEW_SHA,
    attempt: 1,
    status: 'done',
    startedAt: '2026-11-15T00:01:00.000Z',
    updatedAt: '2026-11-15T00:02:00.000Z',
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    messageId: 'om-secret-message-id',
    description: '原始需求描述原文，不应出现在输出',
    targetReqId: 'REQ-CNT-01',
    baseSHA: NEW_SHA,
    branch: `pi/spec-${REQUEST_ID}`,
    stage: 'pr-merged',
    hasValidDoc: true,
    docContent: DOC,
    summary: '计数器更新',
    prNumber: 8,
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:30.000Z',
    ...overrides,
  };
}

function realWorldState(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repo: 'owner/repo',
    cursorMainSha: NEW_SHA,
    requirements: { 'REQ-CNT-01': requirement(NEW_HASH, NEW_SHA) },
    jobs: {
      'job-old-a1': job({ jobId: 'job-old-a1', specHash: OLD_HASH, sourceMainSha: OLD_SHA, attempt: 1, status: 'failed', failureStage: 'plan', prNumber: undefined }),
      'job-old-a2': job({ jobId: 'job-old-a2', specHash: OLD_HASH, sourceMainSha: OLD_SHA, attempt: 2, status: 'done', prNumber: 3 }),
      'job-new-a1': job({ jobId: 'job-new-a1', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'done', prNumber: 8 }),
    },
    deploy: { activeSha: NEW_SHA, releaseDir: '/tmp/releases', deployedPRs: [3, 8], deployFailedPRs: [] },
    specRequests: { [REQUEST_ID]: request() },
    mergeRequests: {},
    opLog: [],
  };
}

function viewOf(raw: Record<string, unknown>) {
  const state = normalizeState(raw);
  assert.ok(state, 'normalizeState 应接受合法状态');
  return buildPanelView(state, meta());
}

test('真实形态：旧 hash 失败→重试成功，新 hash 内容匹配关联，区分当前与历史', () => {
  const view = viewOf(realWorldState());
  assert.equal(view.requests.length, 1);

  assert.equal(view.deliveryGroups.length, 2);
  const bySpecHash = new Map(view.deliveryGroups.map((g) => [g.specHash, g]));

  const newGroup = bySpecHash.get(NEW_HASH.slice(0, 8))!;
  assert.equal(newGroup.linkBasis, 'hash-only');
  assert.equal(newGroup.linkedRequestId, REQUEST_ID);
  assert.equal(newGroup.superseded, false);
  assert.equal(newGroup.attempts.length, 1);
  assert.equal(newGroup.attempts[0]!.attempt, 1);
  assert.equal(newGroup.attempts[0]!.deployStatus, 'deployed');

  const oldGroup = bySpecHash.get(OLD_HASH.slice(0, 8))!;
  assert.equal(oldGroup.linkBasis, 'none');
  assert.equal(oldGroup.linkedRequestId, null);
  assert.equal(oldGroup.superseded, true);
  assert.equal(oldGroup.attempts.length, 2);
  assert.equal(oldGroup.attempts[0]!.status, 'failed');
  assert.equal(oldGroup.attempts[0]!.failureStage, '规划');
  assert.equal(oldGroup.attempts[1]!.status, 'succeeded');
  assert.equal(oldGroup.attempts[1]!.deployStatus, 'deployed');

  const requestItem = view.requests[0]!;
  assert.ok(requestItem.linkedDeliveryIds.includes(newGroup.id));
  assert.equal(requestItem.linkedDeliveryIds.length, 1);
});

test('exact 关联：mergedMainSha 严格等于 sourceMainSha 且 hash 一致', () => {
  const raw = realWorldState();
  raw.requirements = { 'REQ-CNT-01': requirement(NEW_HASH, NEW_SHA) };
  const req = request({ mergedMainSha: NEW_SHA });
  raw.specRequests = { [REQUEST_ID]: req };
  const view = viewOf(raw);
  const newGroup = view.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(newGroup.linkBasis, 'exact');
  assert.equal(newGroup.linkedRequestId, REQUEST_ID);
});

test('F5：mergedMainSha 已记录但与 group SHA 不符时不做 hash 回退混接版本', () => {
  const raw = realWorldState();
  raw.requirements = { 'REQ-CNT-01': requirement(NEW_HASH, NEW_SHA) };
  raw.specRequests = { [REQUEST_ID]: request({ mergedMainSha: OLD_SHA }) };
  const view = viewOf(raw);
  const newGroup = view.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(newGroup.linkBasis, 'none');
  assert.equal(newGroup.linkedRequestId, null);
});

test('歧义：多个 pr-merged 请求产生同一 docHash 时标记 unconfirmed', () => {
  const raw = realWorldState();
  raw.specRequests = {
    [REQUEST_ID]: request(),
    ['fedcba987654']: request({ requestId: 'fedcba987654' }),
  };
  const view = viewOf(raw);
  const newGroup = view.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(newGroup.linkBasis, 'unconfirmed');
  assert.equal(newGroup.linkedRequestId, null);
});

test('合并证据：merge 记录 type/code/head 严格绑定才作证', () => {
  const headSHA = '3'.repeat(40);
  const raw = realWorldState();
  raw.jobs = {
    'job-code': job({ jobId: 'job-code', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'in-review', prNumber: 8, headSHA }),
  };
  raw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  raw.mergeRequests = {
    m1: { requestId: 'm1', repo: 'owner/repo', type: 'code', stage: 'merged', prNumber: 8, headSHA },
  };
  const view = viewOf(raw);
  const group = view.deliveryGroups[0]!;
  assert.equal(group.nodes.find((n) => n.id === 'code-confirm')!.status, 'succeeded');
});

test('合并证据：merge 记录 unknown 不判 waiting 而判 unknown', () => {
  const raw = realWorldState();
  raw.jobs = {
    'job-code': job({ jobId: 'job-code', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'in-review', prNumber: 8, headSHA: '3'.repeat(40) }),
  };
  raw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  raw.mergeRequests = {
    m1: { requestId: 'm1', repo: 'owner/repo', type: 'code', stage: 'unknown', prNumber: 8, headSHA: '3'.repeat(40) },
  };
  const view = viewOf(raw);
  const group = view.deliveryGroups[0]!;
  assert.equal(group.nodes.find((n) => n.id === 'code-confirm')!.status, 'unknown');
});

test('合并证据：job done 但不含 deployedPRs/merge 不能声称合并', () => {
  const raw = realWorldState();
  raw.jobs = {
    'job-done': job({ jobId: 'job-done', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'done', prNumber: 9 }),
  };
  raw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  const view = viewOf(raw);
  const group = view.deliveryGroups[0]!;
  assert.equal(group.nodes.find((n) => n.id === 'code-confirm')!.status, 'pending');
  assert.equal(group.nodes.find((n) => n.id === 'build-deploy')!.status, 'pending');
});

test('部署与回执区分：回执待补与部署失败', () => {
  const receiptRaw = realWorldState();
  receiptRaw.jobs = {
    'job-receipt': job({ jobId: 'job-receipt', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'done', prNumber: 8, resumeAction: 'sync-deploy-receipt' }),
  };
  const receiptView = viewOf(receiptRaw);
  const receiptGroup = receiptView.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(receiptGroup.attempts[0]!.deployStatus, 'receipt-pending');
  assert.equal(receiptGroup.nodes.find((n) => n.id === 'health-receipt')!.status, 'waiting');

  const failRaw = realWorldState();
  failRaw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [8] };
  const failView = viewOf(failRaw);
  const failGroup = failView.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(failGroup.nodes.find((n) => n.id === 'build-deploy')!.status, 'failed');
  assert.equal(failGroup.nodes.find((n) => n.id === 'health-receipt')!.status, 'pending');
});

test('未知 failureStage 不能把编码验证标 succeeded', () => {
  const raw = realWorldState();
  raw.jobs = {
    'job-unknown': job({ jobId: 'job-unknown', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'failed', failureStage: 'mystery' }),
  };
  const view = viewOf(raw);
  const group = view.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(group.nodes.find((n) => n.id === 'code-verify')!.status, 'unknown');
});

test('空/离线：null 状态返回完整空视图', () => {
  const view = buildPanelView(null, meta({ stateKind: 'missing', controllerOnline: false }));
  assert.equal(view.schemaVersion, 'panel/v1');
  assert.equal(view.stateKind, 'missing');
  assert.equal(view.controllerOnline, false);
  assert.equal(view.requests.length, 0);
  assert.equal(view.deliveryGroups.length, 0);
  assert.equal(view.nodes.length, 8);
});

test('parsePanelState：坏 JSON / 不支持 schema', () => {
  assert.equal(parsePanelState('{bad').kind, 'invalid');
  assert.equal(parsePanelState('null').kind, 'invalid');
  assert.equal(parsePanelState('[]').kind, 'invalid');
  assert.equal(parsePanelState('{"schemaVersion":2}').kind, 'unsupported');
  assert.equal(parsePanelState('{"schemaVersion":1}').kind, 'invalid');
});

test('normalizeState：非法嵌套容器/元素整体 invalid，不静默过滤', () => {
  const base = {
    schemaVersion: 1,
    repo: 'owner/repo',
    requirements: {},
    jobs: {},
    specRequests: {},
    mergeRequests: {},
    deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
  };
  assert.equal(normalizeState({ ...base, requirements: null }), null);
  assert.equal(normalizeState({ ...base, jobs: [] }), null);
  assert.equal(normalizeState({ ...base, jobs: { bad: null } }), null);
  assert.equal(normalizeState({ ...base, specRequests: { x: 'not-an-object' } }), null);
  assert.equal(normalizeState({ ...base, mergeRequests: null }), null);
  assert.equal(normalizeState({ ...base, deploy: null }), null);

  const parsed = parsePanelState(JSON.stringify({ ...base, deploy: null }));
  assert.equal(parsed.kind, 'invalid');
  assert.equal(parsed.state, null);
});

test('脱敏：summary 去秘密，输出不含 description/docContent/confirmationCode/messageId', () => {
  const raw = realWorldState();
  const req = request({ summary: '密钥 sk-abcdefghijklmnop1234567890 更新' });
  raw.specRequests = { [REQUEST_ID]: req };
  raw.mergeRequests = { m1: { requestId: 'm1', repo: 'owner/repo', type: 'code', stage: 'confirmable', prNumber: 8, confirmationCode: 'deadbeef' } };
  const view = viewOf(raw);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('sk-abcdefghijklmnop'));
  assert.ok(!json.includes('原始需求描述原文'));
  assert.ok(!json.includes('om-secret-message-id'));
  assert.ok(!json.includes('deadbeef'));
  assert.ok(!json.includes(DOC));
  assert.ok(json.includes('[REDACTED]'));
});

test('safeTitle：有界并清除控制字符', () => {
  assert.equal(safeTitle(null), null);
  assert.equal(safeTitle('a\nb\tc'), 'a b c');
  const long = safeTitle('x'.repeat(500));
  assert.ok(long);
  assert.ok(long.length <= 201);
});

test('request 状态：pr-closed 为 stale，failed 保持 failed', () => {
  const closed = realWorldState();
  closed.specRequests = { [REQUEST_ID]: request({ stage: 'pr-closed' }) };
  assert.equal(viewOf(closed).requests[0]!.status, 'stale');

  const failed = realWorldState();
  failed.specRequests = { [REQUEST_ID]: request({ stage: 'failed' }) };
  assert.equal(viewOf(failed).requests[0]!.status, 'failed');
});

test('exact 关联：pr-merged 但缺 doc/hash 不能 exact，应 unconfirmed', () => {
  const raw = realWorldState();
  raw.requirements = { 'REQ-CNT-01': requirement(NEW_HASH, NEW_SHA) };
  raw.specRequests = { [REQUEST_ID]: request({ mergedMainSha: NEW_SHA, docContent: undefined }) };
  const view = viewOf(raw);
  const newGroup = view.deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  assert.equal(newGroup.linkBasis, 'unconfirmed');
  assert.equal(newGroup.linkedRequestId, null);
});

test('matchedRequirement：hash 与 sourceSha 需同时匹配', () => {
  const raw = realWorldState();
  raw.jobs = {};
  raw.requirements = { 'REQ-CNT-01': requirement(OLD_HASH, NEW_SHA) };
  raw.specRequests = { [REQUEST_ID]: request({ mergedMainSha: NEW_SHA }) };
  assert.equal(
    viewOf(raw).requests[0]!.nodes.find((n) => n.id === 'sync-task')!.status,
    'running',
  );

  raw.requirements = { 'REQ-CNT-01': requirement(NEW_HASH, NEW_SHA) };
  assert.equal(
    viewOf(raw).requests[0]!.nodes.find((n) => n.id === 'sync-task')!.status,
    'succeeded',
  );
});

test('merge repo 校验：repo 不匹配时 merge 作证被丢弃', () => {
  const headSHA = '3'.repeat(40);
  const raw = realWorldState();
  raw.jobs = {
    'job-code': job({ jobId: 'job-code', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'in-review', prNumber: 8, headSHA }),
  };
  raw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  raw.mergeRequests = {
    m1: { requestId: 'm1', repo: 'other/repo', type: 'code', stage: 'merged', prNumber: 8, headSHA },
  };
  const view = viewOf(raw);
  const group = view.deliveryGroups[0]!;
  assert.equal(group.nodes.find((n) => n.id === 'code-confirm')!.status, 'waiting');
});

test('deploy 证据优先于旧 unknown merge 记录', () => {
  const raw = realWorldState();
  raw.jobs = {
    'job-code': job({ jobId: 'job-code', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'in-review', prNumber: 8, headSHA: '3'.repeat(40) }),
  };
  raw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [8], deployFailedPRs: [] };
  raw.mergeRequests = {
    m1: { requestId: 'm1', repo: 'owner/repo', type: 'code', stage: 'unknown', prNumber: 8, headSHA: '3'.repeat(40) },
  };
  const view = viewOf(raw);
  const group = view.deliveryGroups[0]!;
  assert.equal(group.nodes.find((n) => n.id === 'code-confirm')!.status, 'succeeded');
});

test('code-confirm 节点 detail 与状态一致，不出现“已成功但未确认”', () => {
  const succeededGroup = viewOf(realWorldState()).deliveryGroups.find((g) => g.specHash === NEW_HASH.slice(0, 8))!;
  const succeededNode = succeededGroup.nodes.find((n) => n.id === 'code-confirm')!;
  assert.equal(succeededNode.status, 'succeeded');
  assert.equal(succeededNode.detail, '已合并');

  const waitingRaw = realWorldState();
  waitingRaw.jobs = {
    'job-review': job({ jobId: 'job-review', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'in-review', prNumber: 8, headSHA: '3'.repeat(40) }),
  };
  waitingRaw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  const waitingNode = viewOf(waitingRaw).deliveryGroups[0]!.nodes.find((n) => n.id === 'code-confirm')!;
  assert.equal(waitingNode.status, 'waiting');
  assert.match(waitingNode.detail, /等待人工确认/);

  const unknownRaw = realWorldState();
  unknownRaw.jobs = {
    'job-unknown': job({ jobId: 'job-unknown', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'in-review', prNumber: 8, headSHA: '3'.repeat(40) }),
  };
  unknownRaw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  unknownRaw.mergeRequests = {
    m1: { requestId: 'm1', repo: 'owner/repo', type: 'code', stage: 'unknown', prNumber: 8, headSHA: '3'.repeat(40) },
  };
  const unknownNode = viewOf(unknownRaw).deliveryGroups[0]!.nodes.find((n) => n.id === 'code-confirm')!;
  assert.equal(unknownNode.status, 'unknown');
  assert.equal(unknownNode.detail, '结果未知');

  const pendingRaw = realWorldState();
  pendingRaw.jobs = {
    'job-done': job({ jobId: 'job-done', specHash: NEW_HASH, sourceMainSha: NEW_SHA, attempt: 1, status: 'done', prNumber: 9 }),
  };
  pendingRaw.deploy = { activeSha: null, releaseDir: null, deployedPRs: [], deployFailedPRs: [] };
  const pendingNode = viewOf(pendingRaw).deliveryGroups[0]!.nodes.find((n) => n.id === 'code-confirm')!;
  assert.equal(pendingNode.status, 'pending');
  assert.equal(pendingNode.detail, '尚未执行');
});

test('parsePanelArgs：--port 等于 --control-port 且开启探测时拒绝，--no-control 允许', () => {
  assert.throws(() => parsePanelArgs(['--port', '4000', '--control-port', '4000']), /相同|不同端口|no-control/);
  assert.doesNotThrow(() => parsePanelArgs(['--port', '4000', '--control-port', '4000', '--no-control']));
  assert.doesNotThrow(() => parsePanelArgs(['--port', '4001', '--control-port', '4000']));
});

test('resolveStaticAsset：白名单仅 index.html 与 assets/*.(js|css)', () => {
  assert.deepEqual(resolveStaticAsset('/'), { file: 'index.html', type: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveStaticAsset('/index.html'), { file: 'index.html', type: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveStaticAsset('/assets/index-abc123.js'), {
    file: join('assets', 'index-abc123.js'),
    type: 'text/javascript; charset=utf-8',
  });
  assert.deepEqual(resolveStaticAsset('/assets/style-456.css'), {
    file: join('assets', 'style-456.css'),
    type: 'text/css; charset=utf-8',
  });
  assert.equal(resolveStaticAsset('/panel.js'), null);
  assert.equal(resolveStaticAsset('/secret.txt'), null);
  assert.equal(resolveStaticAsset('/assets/../secret'), null);
  assert.equal(resolveStaticAsset('/assets/../index.html'), null);
  assert.equal(resolveStaticAsset('/assets/foo.exe'), null);
  assert.equal(resolveStaticAsset('/assets/'), null);
  assert.equal(resolveStaticAsset('/constructor'), null);
  assert.equal(resolveStaticAsset('/assets/%2e%2e/secret'), null);
});

test('parseByteRange 合法范围/后缀/越界裁剪/非法/多段返回对应结果', () => {
  assert.deepEqual(parseByteRange(undefined, 10), { kind: 'none' });
  assert.deepEqual(parseByteRange('bytes=0-1', 10), { kind: 'range', start: 0, end: 1 });
  assert.deepEqual(parseByteRange('bytes=0-0', 10), { kind: 'range', start: 0, end: 0 });
  assert.deepEqual(parseByteRange('bytes=-2', 10), { kind: 'range', start: 8, end: 9 });
  assert.deepEqual(parseByteRange('bytes=5-', 10), { kind: 'range', start: 5, end: 9 });
  assert.deepEqual(parseByteRange('bytes=5-999', 10), { kind: 'range', start: 5, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-999', 10), { kind: 'range', start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=10-', 10), { kind: 'invalid' });
  assert.deepEqual(parseByteRange('bytes=5-4', 10), { kind: 'invalid' });
  assert.deepEqual(parseByteRange('bytes=0-1,3-4', 10), { kind: 'invalid' });
  assert.deepEqual(parseByteRange('bytes=', 10), { kind: 'invalid' });
  assert.deepEqual(parseByteRange('bytes=-0', 10), { kind: 'invalid' });
  assert.deepEqual(parseByteRange('items=0-1', 10), { kind: 'invalid' });
  assert.deepEqual(parseByteRange('bytes=0-1', 0), { kind: 'invalid' });
});

async function localListenAllowed(): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  } finally {
    if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function httpRequest(opts: {
  port: number;
  method?: string;
  path: string;
  host?: string;
  origin?: string;
  range?: string;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolveRequest, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          ...(opts.host ? { Host: opts.host } : {}),
          ...(opts.origin !== undefined ? { Origin: opts.origin } : {}),
          ...(opts.range ? { Range: opts.range } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('面板 HTTP：GET/白名单/拒绝POST/Host/Origin/资产/符号链接/CSP（SPEC_LOOP_VERIFY 门控）', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实 HTTP 面板测试仅在 SPEC_LOOP_VERIFY=1 主验收执行');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实 HTTP 测试但不降级为 mock');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-panel-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf8');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1);', 'utf8');
  writeFileSync(join(dir, 'assets', 'index-abc123.css'), 'body{}', 'utf8');
  symlinkSync('/etc/hosts', join(dir, 'assets', 'leak.js'));

  const server = createPanelServer({
    readView: async () => buildPanelView(null, meta({ stateKind: 'missing', controllerOnline: false })),
    assetsDir: dir,
  });
  const port = await new Promise<number>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveListen(typeof address === 'object' && address ? address.port : 0);
    });
  });

  try {
    const get = await httpRequest({ port, path: '/api/panel' });
    assert.equal(get.status, 200);
    assert.equal(JSON.parse(get.body).schemaVersion, 'panel/v1');

    const index = await httpRequest({ port, path: '/' });
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-security-policy'] ?? ''), /style-src 'self' 'unsafe-inline'/);
    assert.match(String(index.headers['content-security-policy'] ?? ''), /script-src 'self'/);

    assert.equal((await httpRequest({ port, path: '/index.html' })).status, 200);
    assert.equal((await httpRequest({ port, path: '/assets/index-abc123.js' })).status, 200);
    assert.equal((await httpRequest({ port, path: '/assets/index-abc123.css' })).status, 200);
    assert.equal((await httpRequest({ port, path: '/assets/leak.js' })).status, 404);
    assert.equal((await httpRequest({ port, path: '/panel.css' })).status, 404);
    assert.equal((await httpRequest({ port, path: '/secret.txt' })).status, 404);
    assert.equal((await httpRequest({ port, path: '/assets/../secret.txt' })).status, 404);

    assert.equal((await httpRequest({ port, path: '/api/panel', method: 'POST' })).status, 405);
    assert.equal((await httpRequest({ port, path: '/api/panel', host: 'evil.example' })).status, 403);
    assert.equal((await httpRequest({ port, path: '/api/panel', origin: 'null' })).status, 403);
    assert.equal((await httpRequest({ port, path: '/api/panel', origin: 'http://127.0.0.1:9999' })).status, 403);
    assert.equal((await httpRequest({ port, path: '/api/panel', origin: `http://localhost:${port}` })).status, 403);
    assert.equal((await httpRequest({ port, path: '/api/panel', origin: `http://127.0.0.1:${port}` })).status, 200);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test('面板 HTTP Range：合法 206 / 非法 416 / HEAD 无 body（SPEC_LOOP_VERIFY 门控）', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实 HTTP Range 测试仅在 SPEC_LOOP_VERIFY=1 主验收执行');
    return;
  }
  if (!(await localListenAllowed())) {
    t.skip('当前沙箱禁止 127.0.0.1 listen（EPERM），保留真实 HTTP 测试但不降级为 mock');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-panel-range-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf8');

  const root = mkdtempSync(join(tmpdir(), 'spec-loop-evidence-range-'));
  const record = createManualTestRunRecord({
    id: 'manual-run-1',
    stage: 'manual',
    runner: 'playwright',
    ok: true,
    cases: [
      {
        id: 'A',
        title: 'a',
        status: 'passed',
        durationMs: null,
        error: null,
        artifacts: [{ id: 'vid-1', kind: 'video', name: 'clip.webm', href: '' }],
      },
    ],
  });
  writeTestRunRecord(root, record);
  writeFileSync(join(root, 'manual-run-1', 'vid-1'), '0123456789', 'utf8');
  const store = createTestEvidenceStore({ rootDir: root });

  const server = createPanelServer({
    readView: async () => buildPanelView(null, meta({ stateKind: 'missing', controllerOnline: false })),
    assetsDir: dir,
    testEvidence: store,
  });
  const port = await new Promise<number>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveListen(typeof address === 'object' && address ? address.port : 0);
    });
  });

  const artifactPath = '/api/test-runs/manual-run-1/artifacts/vid-1';
  try {
    const full = await httpRequest({ port, path: artifactPath });
    assert.equal(full.status, 200);
    assert.equal(full.body, '0123456789');
    assert.equal(full.headers['accept-ranges'], 'bytes');

    const range = await httpRequest({ port, path: artifactPath, range: 'bytes=0-1' });
    assert.equal(range.status, 206);
    assert.equal(range.body, '01');
    assert.equal(range.headers['content-range'], 'bytes 0-1/10');
    assert.equal(range.headers['content-length'], '2');

    const suffix = await httpRequest({ port, path: artifactPath, range: 'bytes=-2' });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.body, '89');
    assert.equal(suffix.headers['content-range'], 'bytes 8-9/10');

    const invalid = await httpRequest({ port, path: artifactPath, range: 'bytes=10-' });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], 'bytes */10');
    assert.equal(invalid.body, '');

    const head = await httpRequest({ port, path: artifactPath, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], '10');
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
