import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_FLOW, DEMO_SCENARIOS, buildDemoView } from '../panel/src/demo.ts';

test('each demo scenario renders the complete eight-stage flow', () => {
  for (const scenario of DEMO_SCENARIOS) {
    for (let frameIndex = 0; frameIndex < scenario.frames.length; frameIndex += 1) {
      const view = buildDemoView(scenario.key, frameIndex);
      assert.equal(view.schemaVersion, 'panel/v1');
      assert.equal(view.stateKind, 'ok');
      assert.equal(view.repo, 'demo/spec-loop');
      assert.deepEqual(
        view.nodes.map((node) => node.id),
        DEMO_FLOW.map((node) => node.id),
      );
      assert.equal(view.nodes.filter((node) => node.current).length, 1);
      assert.equal(view.requests[0]?.nodes.length, 8);
      assert.equal(view.deliveryGroups[0]?.nodes.length, 8);
      assert.match(view.requests[0]?.summary ?? '', /演示/);
    }
  }
});

test('failure stops later stages and preserves dependency language', () => {
  const scenario = DEMO_SCENARIOS.find((item) => item.key === 'failed');
  assert.ok(scenario);
  const view = buildDemoView('failed', scenario.frames.length - 1);
  assert.equal(view.nodes[4]?.status, 'failed');
  assert.equal(view.nodes[4]?.current, true);
  for (const node of view.nodes.slice(5)) {
    assert.equal(node.status, 'pending');
    assert.match(node.detail, /依赖前序步骤/);
  }
});

test('default demo states use running for execution and waiting for human confirmation', () => {
  const running = DEMO_SCENARIOS.find((item) => item.key === 'running');
  const waiting = DEMO_SCENARIOS.find((item) => item.key === 'waiting');
  assert.ok(running);
  assert.ok(waiting);

  const runningView = buildDemoView('running', running.frames.length - 1);
  assert.equal(runningView.nodes[4]?.status, 'running');
  assert.equal(runningView.nodes[4]?.current, true);

  const waitingView = buildDemoView('waiting', waiting.frames.length - 1);
  assert.equal(waitingView.nodes[5]?.status, 'waiting');
  assert.equal(waitingView.nodes[5]?.current, true);
});

test('retry keeps the failed attempt while marking the retry as latest', () => {
  const scenario = DEMO_SCENARIOS.find((item) => item.key === 'retry-success');
  assert.ok(scenario);
  const view = buildDemoView('retry-success', scenario.frames.length - 1);
  const attempts = view.deliveryGroups[0]?.attempts ?? [];
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.attempt, 1);
  assert.equal(attempts[0]?.status, 'failed');
  assert.equal(attempts[0]?.isLatest, false);
  assert.equal(attempts[1]?.attempt, 2);
  assert.equal(attempts[1]?.isLatest, true);
  assert.equal(attempts[1]?.status, 'waiting');
});

test('deployed demo separates deployment success from receipt evidence', () => {
  const scenario = DEMO_SCENARIOS.find((item) => item.key === 'deployed');
  assert.ok(scenario);
  const pendingReceipt = buildDemoView('deployed', scenario.frames.length - 2);
  assert.equal(pendingReceipt.deliveryGroups[0]?.attempts[0]?.deployStatus, 'receipt-pending');

  const deployed = buildDemoView('deployed', scenario.frames.length - 1);
  assert.equal(deployed.deliveryGroups[0]?.attempts[0]?.deployStatus, 'deployed');
  assert.deepEqual(deployed.deploy.deployedPRs, [128]);
  assert.ok(deployed.nodes.every((node) => node.status === 'succeeded'));
});
