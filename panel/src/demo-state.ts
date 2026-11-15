export const DEMO_STEP_SEQUENCE = [
  'draft',
  'doc-pr',
  'doc-confirm',
  'doc-effective',
  'task-sync',
  'worker-first',
  'check-first',
  'check-failed',
  'worker-retry',
  'check-retry',
  'code-pr',
  'code-confirm',
  'build',
  'health',
  'preview',
  'receipt',
  'complete',
] as const;

export type DemoStep = (typeof DEMO_STEP_SEQUENCE)[number];

export type DemoGate = 'document' | 'code' | 'retry';

export interface DemoAttemptRecord {
  number: 1 | 2;
  status: 'running' | 'failed' | 'succeeded';
  failureStage: 'verify' | null;
  startedAt: string;
  updatedAt: string;
}

export interface DemoState {
  step: DemoStep;
  playing: boolean;
  confirmedGates: DemoGate[];
  retryUsed: boolean;
  attempts: DemoAttemptRecord[];
  completedAt: string | null;
}

export type DemoAction =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TICK' }
  | { type: 'NEXT' }
  | { type: 'CONFIRM_DOCUMENT' }
  | { type: 'CONFIRM_CODE' }
  | { type: 'RETRY_CHECK' }
  | { type: 'RESET' }
  | { type: 'REPLAY' };

const DEMO_BASE_TIME = Date.UTC(2026, 10, 15, 9, 0, 0);
const DEMO_STEP_MINUTES = 2;

export function demoTime(step: DemoStep, minuteOffset = 0): string {
  const index = DEMO_STEP_SEQUENCE.indexOf(step);
  return new Date(
    DEMO_BASE_TIME + (Math.max(index, 0) + minuteOffset) * DEMO_STEP_MINUTES * 60_000,
  ).toISOString();
}

export function createInitialDemoState(playing = false): DemoState {
  return {
    step: 'draft',
    playing,
    confirmedGates: [],
    retryUsed: false,
    attempts: [],
    completedAt: null,
  };
}

export function getDemoGate(state: DemoState): DemoGate | null {
  if (state.step === 'doc-confirm') return 'document';
  if (state.step === 'code-confirm') return 'code';
  if (state.step === 'check-failed') return 'retry';
  return null;
}

export function isDemoStepComplete(state: DemoState): boolean {
  return state.step === 'complete';
}

export function isDemoProgressEnabled(state: DemoState): boolean {
  return getDemoGate(state) === null && !isDemoStepComplete(state);
}

export function getDemoStepIndex(state: DemoState): number {
  return DEMO_STEP_SEQUENCE.indexOf(state.step);
}

function nextStep(step: DemoStep): DemoStep | null {
  switch (step) {
    case 'draft':
      return 'doc-pr';
    case 'doc-pr':
      return 'doc-confirm';
    case 'doc-confirm':
      return 'doc-effective';
    case 'doc-effective':
      return 'task-sync';
    case 'task-sync':
      return 'worker-first';
    case 'worker-first':
      return 'check-first';
    case 'check-first':
      return 'check-failed';
    case 'check-failed':
      return 'worker-retry';
    case 'worker-retry':
      return 'check-retry';
    case 'check-retry':
      return 'code-pr';
    case 'code-pr':
      return 'code-confirm';
    case 'code-confirm':
      return 'build';
    case 'build':
      return 'health';
    case 'health':
      return 'preview';
    case 'preview':
      return 'receipt';
    case 'receipt':
      return 'complete';
    case 'complete':
      return null;
  }
}

function attemptsForStep(
  current: DemoAttemptRecord[],
  target: DemoStep,
): DemoAttemptRecord[] {
  const at = demoTime(target);

  if (target === 'worker-first' && current.length === 0) {
    return [
      {
        number: 1,
        status: 'running',
        failureStage: null,
        startedAt: at,
        updatedAt: at,
      },
    ];
  }

  if (target === 'check-failed') {
    return current.map((attempt) =>
      attempt.number === 1
        ? {
            ...attempt,
            status: 'failed',
            failureStage: 'verify',
            updatedAt: at,
          }
        : attempt,
    );
  }

  if (target === 'worker-retry' && current.length === 1) {
    return [
      ...current,
      {
        number: 2,
        status: 'running',
        failureStage: null,
        startedAt: at,
        updatedAt: at,
      },
    ];
  }

  if (target === 'code-pr') {
    return current.map((attempt) =>
      attempt.number === 2
        ? {
            ...attempt,
            status: 'succeeded',
            updatedAt: at,
          }
        : attempt,
    );
  }

  return current;
}

function enterStep(
  state: DemoState,
  target: DemoStep,
  options: {
    continuePlaying: boolean;
    confirmedGate?: DemoGate;
    retryUsed?: boolean;
  },
): DemoState {
  const blocked = getDemoGate({ ...state, step: target }) !== null;
  const completedAt = target === 'complete' ? demoTime(target) : null;

  return {
    ...state,
    step: target,
    playing: options.continuePlaying && !blocked && completedAt === null,
    confirmedGates:
      options.confirmedGate && !state.confirmedGates.includes(options.confirmedGate)
        ? [...state.confirmedGates, options.confirmedGate]
        : state.confirmedGates,
    retryUsed: options.retryUsed ?? state.retryUsed,
    attempts: attemptsForStep(state.attempts, target),
    completedAt,
  };
}

function advance(state: DemoState, continuePlaying: boolean): DemoState {
  if (!isDemoProgressEnabled(state)) {
    return state.playing ? { ...state, playing: false } : state;
  }

  const target = nextStep(state.step);
  if (!target) return { ...state, playing: false };
  return enterStep(state, target, { continuePlaying });
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'PLAY':
      if (!isDemoProgressEnabled(state)) return state;
      return { ...state, playing: true };
    case 'PAUSE':
      return state.playing ? { ...state, playing: false } : state;
    case 'TICK':
      if (!state.playing) return state;
      return advance(state, true);
    case 'NEXT':
      return advance(state, false);
    case 'CONFIRM_DOCUMENT':
      if (state.step !== 'doc-confirm') return state;
      return enterStep(state, 'doc-effective', {
        continuePlaying: true,
        confirmedGate: 'document',
      });
    case 'CONFIRM_CODE':
      if (state.step !== 'code-confirm') return state;
      return enterStep(state, 'build', {
        continuePlaying: true,
        confirmedGate: 'code',
      });
    case 'RETRY_CHECK':
      if (state.step !== 'check-failed' || state.retryUsed) return state;
      return enterStep(state, 'worker-retry', {
        continuePlaying: true,
        retryUsed: true,
      });
    case 'RESET':
      return createInitialDemoState(false);
    case 'REPLAY':
      return createInitialDemoState(true);
  }
}
