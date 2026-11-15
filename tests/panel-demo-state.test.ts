import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInitialDemoState,
  demoReducer,
  getDemoGate,
  isDemoStepComplete,
  type DemoAction,
  type DemoState,
  type DemoStep,
} from '../panel/src/demo-state.ts';

function run(actions: DemoAction[]): DemoState {
  return actions.reduce(demoReducer, createInitialDemoState());
}

function tickTo(target: DemoStep): DemoState {
  let state = demoReducer(createInitialDemoState(), { type: 'PLAY' });
  for (let guard = 0; guard < 40; guard += 1) {
    if (state.step === target) return state;
    const gate = getDemoGate(state);
    const action: DemoAction =
      gate === 'document'
        ? { type: 'CONFIRM_DOCUMENT' }
        : gate === 'code'
          ? { type: 'CONFIRM_CODE' }
          : gate === 'retry'
            ? { type: 'RETRY_CHECK' }
            : { type: 'TICK' };
    state = demoReducer(state, action);
  }
  assert.fail(`demo did not reach ${target}`);
}

test('demo starts at a paused document draft and document confirmation blocks every normal advance', () => {
  let state = createInitialDemoState();
  assert.equal(state.step, 'draft');
  assert.equal(state.playing, false);
  assert.equal(state.attempts.length, 0);

  state = demoReducer(state, { type: 'PLAY' });
  state = demoReducer(state, { type: 'TICK' });
  assert.equal(state.step, 'doc-pr');
  state = demoReducer(state, { type: 'TICK' });

  assert.equal(state.step, 'doc-confirm');
  assert.equal(getDemoGate(state), 'document');
  assert.equal(state.playing, false);

  const blockedSnapshot = structuredClone(state);
  for (const action of [
    { type: 'PLAY' },
    { type: 'NEXT' },
    { type: 'TICK' },
    { type: 'CONFIRM_CODE' },
  ] satisfies DemoAction[]) {
    assert.deepEqual(demoReducer(state, action), blockedSnapshot);
  }

  state = demoReducer(state, { type: 'CONFIRM_DOCUMENT' });
  assert.equal(state.step, 'doc-effective');
  assert.equal(state.playing, true);
  assert.deepEqual(state.confirmedGates, ['document']);

  assert.deepEqual(demoReducer(state, { type: 'CONFIRM_DOCUMENT' }), state);
});

test('fixed-check failure requires one explicit retry and preserves the failed attempt', () => {
  let state = tickTo('check-failed');
  assert.equal(getDemoGate(state), 'retry');
  assert.equal(state.playing, false);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0]?.status, 'failed');

  const blockedSnapshot = structuredClone(state);
  for (const action of [
    { type: 'PLAY' },
    { type: 'NEXT' },
    { type: 'TICK' },
    { type: 'CONFIRM_DOCUMENT' },
    { type: 'CONFIRM_CODE' },
  ] satisfies DemoAction[]) {
    assert.deepEqual(demoReducer(state, action), blockedSnapshot);
  }

  state = demoReducer(state, { type: 'RETRY_CHECK' });
  assert.equal(state.step, 'worker-retry');
  assert.equal(state.playing, true);
  assert.equal(state.retryUsed, true);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0]?.status, 'failed');
  assert.equal(state.attempts[1]?.status, 'running');

  assert.deepEqual(demoReducer(state, { type: 'RETRY_CHECK' }), state);
});

test('code confirmation is bound to its own gate and resumes before candidate build', () => {
  let state = tickTo('code-confirm');
  assert.equal(getDemoGate(state), 'code');
  assert.equal(state.playing, false);

  const blockedSnapshot = structuredClone(state);
  for (const action of [
    { type: 'PLAY' },
    { type: 'NEXT' },
    { type: 'TICK' },
    { type: 'CONFIRM_DOCUMENT' },
  ] satisfies DemoAction[]) {
    assert.deepEqual(demoReducer(state, action), blockedSnapshot);
  }

  state = demoReducer(state, { type: 'CONFIRM_CODE' });
  assert.equal(state.step, 'build');
  assert.equal(state.playing, true);
  assert.deepEqual(state.confirmedGates, ['document', 'code']);
  assert.deepEqual(demoReducer(state, { type: 'CONFIRM_CODE' }), state);
});

test('full story reaches completion only after both confirmations and the explicit retry', () => {
  let state = demoReducer(createInitialDemoState(), { type: 'PLAY' });

  for (let guard = 0; guard < 50 && !isDemoStepComplete(state); guard += 1) {
    const gate = getDemoGate(state);
    state = demoReducer(
      state,
      gate === 'document'
        ? { type: 'CONFIRM_DOCUMENT' }
        : gate === 'code'
          ? { type: 'CONFIRM_CODE' }
          : gate === 'retry'
            ? { type: 'RETRY_CHECK' }
            : { type: 'TICK' },
    );
  }

  assert.equal(state.step, 'complete');
  assert.equal(state.playing, false);
  assert.ok(state.completedAt);
  assert.deepEqual(state.confirmedGates, ['document', 'code']);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0]?.status, 'failed');
  assert.equal(state.attempts[1]?.status, 'succeeded');

  const completedSnapshot = structuredClone(state);
  for (const action of [
    { type: 'PLAY' },
    { type: 'NEXT' },
    { type: 'TICK' },
  ] satisfies DemoAction[]) {
    assert.deepEqual(demoReducer(state, action), completedSnapshot);
  }
});

test('reset and replay discard confirmations, attempts, and completion evidence', () => {
  let advanced = tickTo('receipt');
  const reset = demoReducer(advanced, { type: 'RESET' });
  assert.deepEqual(reset, createInitialDemoState(false));

  advanced = tickTo('complete');
  const replay = demoReducer(advanced, { type: 'REPLAY' });
  assert.deepEqual(replay, createInitialDemoState(true));
  assert.equal(replay.attempts.length, 0);
  assert.deepEqual(replay.confirmedGates, []);
  assert.equal(replay.completedAt, null);
});

test('single-step advancement never bypasses document, retry, or code gates', () => {
  let state = run([{ type: 'NEXT' }, { type: 'NEXT' }]);
  assert.equal(state.step, 'doc-confirm');
  assert.equal(demoReducer(state, { type: 'NEXT' }), state);

  state = demoReducer(state, { type: 'CONFIRM_DOCUMENT' });
  while (state.step !== 'check-failed') state = demoReducer(state, { type: 'NEXT' });
  assert.equal(state.playing, false);
  assert.equal(demoReducer(state, { type: 'NEXT' }), state);

  state = demoReducer(state, { type: 'RETRY_CHECK' });
  while (state.step !== 'code-confirm') state = demoReducer(state, { type: 'NEXT' });
  assert.equal(state.playing, false);
  assert.equal(demoReducer(state, { type: 'NEXT' }), state);
});
