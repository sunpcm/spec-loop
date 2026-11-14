import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { resolveAppVersion, resolveAssetBase } from "../vite.config.ts";

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

test("version and asset base select the expected Vercel and local values", () => {
  assert.equal(
    resolveAppVersion({
      SPEC_LOOP_VERSION: "local-sha",
      VERCEL_GIT_COMMIT_SHA: "vercel-sha",
    }),
    "local-sha",
  );
  assert.equal(resolveAppVersion({ VERCEL_GIT_COMMIT_SHA: "vercel-sha" }), "vercel-sha");
  assert.equal(resolveAppVersion({}), "dev");
  assert.equal(resolveAssetBase({ VERCEL: "1", SPEC_LOOP_ASSET_BASE: "/releases/old/" }), "/");
  assert.equal(resolveAssetBase({ SPEC_LOOP_ASSET_BASE: "/releases/local/" }), "/releases/local/");
});

test("Vite build emits a static version manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "spec-loop-vite-version-"));
  const output = join(root, "dist");
  const previous = {
    SPEC_LOOP_OUT_DIR: process.env.SPEC_LOOP_OUT_DIR,
    SPEC_LOOP_VERSION: process.env.SPEC_LOOP_VERSION,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    SPEC_LOOP_ASSET_BASE: process.env.SPEC_LOOP_ASSET_BASE,
    VERCEL: process.env.VERCEL,
  };
  process.env.SPEC_LOOP_OUT_DIR = output;
  process.env.SPEC_LOOP_VERSION = "artifact-version";
  process.env.VERCEL_GIT_COMMIT_SHA = "ignored-vercel-sha";
  process.env.SPEC_LOOP_ASSET_BASE = "/releases/ignored/";
  delete process.env.VERCEL;
  try {
    await build({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      configLoader: "native",
      logLevel: "silent",
    });
    assert.deepEqual(JSON.parse(readFileSync(join(output, "version.json"), "utf8")), {
      version: "artifact-version",
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
