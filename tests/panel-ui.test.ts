import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEMO_MAIN_NODE_IDS,
  DEMO_STORY,
  buildDemoEvidence,
  buildDemoScene,
  getDemoArtifactLabels,
  type DemoEvidence,
} from '../panel/src/demo.ts';
import {
  createInitialDemoState,
  demoReducer,
  type DemoAction,
  type DemoState,
  type DemoStep,
} from '../panel/src/demo-state.ts';
import { buildRealFlowDefinition } from '../panel/src/flow-model.ts';
import type { PanelNode } from '../panel/src/types.ts';

function advanceTo(target: DemoStep): DemoState {
  let state = createInitialDemoState();
  state = demoReducer(state, { type: 'PLAY' });

  for (let guard = 0; guard < 40; guard += 1) {
    if (state.step === target) return state;
    let action: DemoAction;
    if (state.step === 'doc-confirm') action = { type: 'CONFIRM_DOCUMENT' };
    else if (state.step === 'check-failed') action = { type: 'RETRY_CHECK' };
    else if (state.step === 'code-confirm') action = { type: 'CONFIRM_CODE' };
    else action = { type: 'TICK' };
    state = demoReducer(state, action);
  }

  assert.fail(`demo did not reach ${target}`);
}

function evidenceValue(evidence: DemoEvidence | null, label: string): string | undefined {
  return evidence?.rows.find((row) => row.label === label)?.value;
}

test('single demo story keeps one request and one linked delivery without history rows', () => {
  const state = advanceTo('task-sync');
  const scene = buildDemoScene(state);
  const labels = getDemoArtifactLabels(state);

  assert.match(DEMO_STORY.summary, /新增翻倍按钮/);
  assert.match(DEMO_STORY.summary, /保留原有步长、增加、减少与重置行为/);
  assert.equal(scene.view.requests.length, 1);
  assert.equal(scene.view.deliveryGroups.length, 1);
  assert.match(scene.view.requests[0]?.summary ?? '', /计数器增加翻倍功能/);
  assert.equal(scene.view.requests[0]?.requestId, DEMO_STORY.requestId);
  assert.equal(scene.view.deliveryGroups[0]?.id, DEMO_STORY.deliveryId);
  assert.equal(scene.view.requests[0]?.superseded, false);
  assert.equal(scene.view.deliveryGroups[0]?.superseded, false);
  assert.equal(labels.documentPr, DEMO_STORY.documentPrLabel);
  assert.equal(labels.task, DEMO_STORY.issueLabel);
  assert.equal(labels.codePr, null);
});

test('flow definition includes the full main path, actual retry loop, and dormant branches', () => {
  const scene = buildDemoScene(createInitialDemoState());
  const nodeIds = new Set(scene.flow.nodes.map((node) => node.id));

  assert.equal(scene.flow.sequenceTotal, 14);
  assert.equal(scene.flow.nodes.length, 18);
  assert.ok(DEMO_MAIN_NODE_IDS.every((id) => nodeIds.has(id)));
  assert.ok(nodeIds.has('check-retry'));
  assert.ok(nodeIds.has('terminal-branches'));
  assert.ok(nodeIds.has('build-retry'));
  assert.ok(nodeIds.has('receipt-retry'));

  const failureEdge = scene.flow.edges.find(
    (edge) => edge.source === 'fixed-check' && edge.target === 'check-retry',
  );
  const retryEdge = scene.flow.edges.find(
    (edge) => edge.source === 'check-retry' && edge.target === 'worker',
  );
  const checkPassEdge = scene.flow.edges.find(
    (edge) => edge.source === 'fixed-check' && edge.target === 'code-pr',
  );
  const versionExpiredEdge = scene.flow.edges.find(
    (edge) => edge.source === 'docs-effective' && edge.target === 'terminal-branches',
  );
  const buildRetryEdge = scene.flow.edges.find(
    (edge) => edge.source === 'candidate-build' && edge.target === 'build-retry',
  );
  const resumeBuildEdge = scene.flow.edges.find(
    (edge) => edge.source === 'build-retry' && edge.target === 'candidate-build',
  );
  const receiptRetryEdge = scene.flow.edges.find(
    (edge) => edge.source === 'deploy-receipt' && edge.target === 'receipt-retry',
  );
  const resumeReceiptEdge = scene.flow.edges.find(
    (edge) => edge.source === 'receipt-retry' && edge.target === 'deploy-receipt',
  );
  assert.equal(failureEdge?.label, '验证失败');
  assert.deepEqual(failureEdge?.route?.waypoints, [
    { x: 349, y: 246 },
    { x: 469, y: 246 },
    { x: 469, y: 506 },
    { x: 609, y: 506 },
  ]);
  assert.equal(retryEdge?.label, '显式重试');
  assert.equal(retryEdge?.sourceHandle, 'source-left');
  assert.equal(retryEdge?.targetHandle, 'target-left');
  assert.equal(checkPassEdge?.label, '检查通过');
  assert.deepEqual(versionExpiredEdge?.route?.waypoints, [
    { x: 979, y: 48 },
    { x: 979, y: 378 },
    { x: 89, y: 378 },
  ]);
  assert.notDeepEqual(buildRetryEdge?.route?.waypoints, resumeBuildEdge?.route?.waypoints);
  assert.notDeepEqual(receiptRetryEdge?.route?.waypoints, resumeReceiptEdge?.route?.waypoints);
  const labelPositions = scene.flow.edges
    .map((edge) => edge.route?.labelPosition)
    .filter((position) => position !== undefined)
    .map((position) => `${position.x},${position.y}`);
  assert.equal(new Set(labelPositions).size, labelPositions.length);

  const dormantNodes = scene.flow.nodes.filter((node) => node.dormant);
  assert.deepEqual(
    dormantNodes.map((node) => node.id).sort(),
    ['build-retry', 'receipt-retry', 'terminal-branches'],
  );
  assert.ok(scene.flow.nodes.every((node) => node.width > 0 && node.height > 0));
});

test('artifacts appear only after their gating evidence', () => {
  const initial = buildDemoScene(createInitialDemoState());
  assert.equal(initial.view.requests[0]?.mergedMainSha, null);
  assert.equal(initial.view.deliveryGroups.length, 0);
  assert.equal(
    initial.flow.nodes.find((node) => node.id === 'code-pr')?.status,
    'pending',
  );
  const draftEvidence = buildDemoEvidence(createInitialDemoState(), 'docs-draft');
  assert.ok(draftEvidence?.rows.some((row) => row.value === '原步长、增加、减少与重置'));

  const failedState = advanceTo('check-failed');
  const failed = buildDemoScene(failedState);
  assert.equal(failed.view.deliveryGroups[0]?.attempts[0]?.status, 'failed');
  const failedCodePr = buildDemoEvidence(failedState, 'code-pr');
  assert.ok(failedCodePr?.rows.some((row) => row.label === '代码 PR' && row.value === '未记录'));

  const retryStarted = buildDemoEvidence(advanceTo('worker-retry'), 'fixed-check');
  assert.equal(evidenceValue(retryStarted, '检查 2'), '未执行');
  assert.match(retryStarted?.summary ?? '', /Worker 正在编码/);
  const secondCheckRunning = buildDemoEvidence(advanceTo('check-retry'), 'fixed-check');
  assert.equal(evidenceValue(secondCheckRunning, '检查 2'), '进行中');
  const secondCheckPassed = buildDemoEvidence(advanceTo('code-pr'), 'fixed-check');
  assert.equal(evidenceValue(secondCheckPassed, '检查 2'), '通过');

  const codeConfirmState = advanceTo('code-confirm');
  const codeConfirm = buildDemoScene(codeConfirmState);
  assert.equal(
    codeConfirm.flow.nodes.find((node) => node.id === 'candidate-build')?.status,
    'pending',
  );

  const healthState = advanceTo('health');
  const health = buildDemoScene(healthState);
  assert.equal(health.view.deploy.activeSha, failed.view.deploy.activeSha);
  const completedBuild = buildDemoEvidence(healthState, 'candidate-build');
  assert.equal(evidenceValue(completedBuild, '构建状态'), '成功');
  const runningHealth = buildDemoEvidence(healthState, 'candidate-health');
  assert.equal(evidenceValue(runningHealth, '健康检查'), '进行中');

  const codeMergedState = advanceTo('build');
  const codeMerged = buildDemoScene(codeMergedState);
  assert.equal(
    codeMerged.view.requests[0]?.mergedMainSha,
    codeMerged.view.deliveryGroups[0]?.sourceMainSha,
  );
  assert.notEqual(codeMerged.view.cursorMainSha, codeMerged.view.requests[0]?.mergedMainSha);
  const runningBuild = buildDemoEvidence(codeMergedState, 'candidate-build');
  assert.equal(evidenceValue(runningBuild, '构建状态'), '进行中');

  const previewState = advanceTo('preview');
  const preview = buildDemoScene(previewState);
  assert.notEqual(preview.view.deploy.activeSha, health.view.deploy.activeSha);
  assert.equal(preview.view.cursorMainSha, preview.view.deploy.activeSha);
  assert.equal(
    preview.view.deliveryGroups[0]?.attempts.at(-1)?.deployStatus,
    'receipt-pending',
  );
  const passedHealth = buildDemoEvidence(previewState, 'candidate-health');
  assert.equal(evidenceValue(passedHealth, '健康检查'), '通过');
});

test('completed story preserves the failed attempt and final deployment evidence', () => {
  const state = advanceTo('complete');
  const scene = buildDemoScene(state);
  const attempts = scene.view.deliveryGroups[0]?.attempts ?? [];

  assert.equal(state.completedAt !== null, true);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.status, 'failed');
  assert.equal(attempts[0]?.isLatest, false);
  assert.equal(attempts[1]?.status, 'succeeded');
  assert.equal(attempts[1]?.deployStatus, 'deployed');
  assert.ok(scene.nodes.filter((node) => node.current).every((node) => node.id === 'complete'));

  const receiptEvidence = buildDemoEvidence(state, 'deploy-receipt');
  assert.ok(receiptEvidence?.rows.some((row) => row.value === 'DEMO-RECEIPT-001'));
});

test('real flow mapping supports variable node counts and the eight-stage DTO', () => {
  const nodes: PanelNode[] = Array.from({ length: 11 }, (_, index) => ({
    id: `stage-${index + 1}`,
    label: `阶段 ${index + 1}`,
    status: index === 0 ? 'running' : 'pending',
    current: index === 0,
    detail: '状态证据',
  }));
  const definition = buildRealFlowDefinition(nodes);

  assert.equal(definition.nodes.length, 11);
  assert.equal(definition.edges.length, 10);
  assert.equal(definition.sequenceTotal, 11);
  assert.ok(definition.nodes.every((node) => node.width === 220 && node.height === 128));
});

test('old scenario selector and fixed eight-node slicing are absent from frontend sources', async () => {
  const appSource = await readFile(new URL('../panel/src/App.tsx', import.meta.url), 'utf8');
  const flowSource = await readFile(new URL('../panel/src/flow.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(appSource, /DEMO_SCENARIOS|演示场景|getDemoScenario/);
  assert.doesNotMatch(flowSource, /slice\(0,\s*8\)|NODE_POSITIONS/);
  assert.match(flowSource, /function routePath/);
  assert.match(flowSource, /edgeTypes=\{EDGE_TYPES\}/);
});
