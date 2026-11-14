import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type CounterModule = typeof import("../src/counter");

const { CounterInputError, increment, parseStep } = (await import(
  new URL("../src/counter.ts", import.meta.url).href
)) as CounterModule;

const sourceFiles = {
  main: readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
};

test("parseStep accepts signed integer steps and trims surrounding space", () => {
  assert.equal(parseStep("1"), 1);
  assert.equal(parseStep(" +2 "), 2);
  assert.equal(parseStep("-3"), -3);
  assert.equal(parseStep("0"), 0);
});

test("parseStep rejects an empty step with explicitly detectable error", () => {
  for (const raw of ["", " ", "\t\n"]) {
    assert.throws(
      () => parseStep(raw),
      (error: unknown) =>
        error instanceof CounterInputError &&
        error.name === "CounterInputError" &&
        error.code === "EMPTY_STEP" &&
        error.message === "step is empty",
    );
  }
});

test("parseStep rejects non-integer and out-of-range values", () => {
  for (const raw of ["1.5", "1e3", "two", "0x10", "+"]) {
    assert.throws(
      () => parseStep(raw),
      (error: unknown) =>
        error instanceof CounterInputError && error.code === "INVALID_STEP",
    );
  }

  assert.throws(
    () => parseStep("9007199254740992"),
    (error: unknown) =>
      error instanceof CounterInputError && error.code === "OUT_OF_RANGE",
  );
});

test("increment starts from zero and applies a valid step", () => {
  assert.equal(increment(0, "1"), 1);
  assert.equal(increment(2, "3"), 5);
  assert.equal(increment(5, "-2"), 3);
});

test("increment leaves counting safe and rejects unsafe results", () => {
  assert.throws(
    () => increment(Number.MAX_SAFE_INTEGER, "1"),
    (error: unknown) =>
      error instanceof CounterInputError && error.code === "OUT_OF_RANGE",
  );

  assert.throws(
    () => increment(1.5, "1"),
    (error: unknown) =>
      error instanceof CounterInputError && error.code === "OUT_OF_RANGE",
  );
});

test("main entry retains the requirement and trusted version system contract", () => {
  assert.match(sourceFiles.main, /REQ-CNT-01/);
  assert.match(sourceFiles.main, /__APP_VERSION__/);
});
