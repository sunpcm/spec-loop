export type CounterInputErrorCode =
  | "EMPTY_STEP"
  | "INVALID_STEP"
  | "OUT_OF_RANGE";

export class CounterInputError extends Error {
  readonly code: CounterInputErrorCode;

  constructor(message: string, code: CounterInputErrorCode) {
    super(message);
    this.name = "CounterInputError";
    this.code = code;
  }
}

const integerPattern = /^[+-]?\d+$/;

export function parseStep(raw: string): number {
  const normalized = raw.trim();

  if (normalized.length === 0) {
    throw new CounterInputError("step is empty", "EMPTY_STEP");
  }

  if (!integerPattern.test(normalized)) {
    throw new CounterInputError("step must be an integer", "INVALID_STEP");
  }

  const step = Number(normalized);

  if (!Number.isSafeInteger(step)) {
    throw new CounterInputError(
      "step is outside the safe integer range",
      "OUT_OF_RANGE",
    );
  }

  return step;
}

export function increment(current: number, raw: string): number {
  if (!Number.isSafeInteger(current)) {
    throw new CounterInputError(
      "current counter value must be a safe integer",
      "OUT_OF_RANGE",
    );
  }

  const next = current + parseStep(raw);

  if (!Number.isSafeInteger(next)) {
    throw new CounterInputError(
      "result is outside the safe integer range",
      "OUT_OF_RANGE",
    );
  }

  return next;
}
