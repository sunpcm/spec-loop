export type CounterInputErrorCode =
  | 'EMPTY_STEP'
  | 'INVALID_STEP'
  | 'OUT_OF_RANGE';

export class CounterInputError extends Error {
  readonly code: CounterInputErrorCode;

  constructor(message: string, code: CounterInputErrorCode) {
    super(message);
    this.name = 'CounterInputError';
    this.code = code;
  }
}

const integerPattern = /^[+-]?[0-9]+$/;

export function parseStep(raw: string): number {
  const normalized = raw.trim();

  if (normalized.length === 0) {
    throw new CounterInputError('step is empty', 'EMPTY_STEP');
  }

  if (!integerPattern.test(normalized)) {
    throw new CounterInputError('step must be an integer', 'INVALID_STEP');
  }

  const step = Number(normalized);

  if (!Number.isSafeInteger(step)) {
    throw new CounterInputError(
      'step is outside the safe integer range',
      'OUT_OF_RANGE',
    );
  }

  return step;
}

function assertCurrentValue(current: number): void {
  if (!Number.isSafeInteger(current)) {
    throw new CounterInputError(
      'current counter value must be a safe integer',
      'OUT_OF_RANGE',
    );
  }
}

function assertResult(next: number): void {
  if (!Number.isSafeInteger(next)) {
    throw new CounterInputError(
      'result is outside the safe integer range',
      'OUT_OF_RANGE',
    );
  }
}

export function increment(current: number, raw: string): number {
  assertCurrentValue(current);

  const next = current + parseStep(raw);
  assertResult(next);
  return next;
}

export function decrement(current: number, raw: string): number {
  assertCurrentValue(current);

  const next = current - parseStep(raw);
  assertResult(next);
  return next;
}

export function doubleValue(current: number): number {
  assertCurrentValue(current);

  const next = current * 2;
  assertResult(next);
  return next;
}
