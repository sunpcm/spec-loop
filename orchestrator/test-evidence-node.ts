import { redact } from './log.ts';
import { createManualTestRunRecord, type FixedTestSummary, type TestCaseSummary } from './test-evidence.ts';

interface NodeTestCounts {
  tests: number | null;
  pass: number | null;
  fail: number | null;
  skipped: number | null;
  cancelled: number | null;
  todo: number | null;
  durationMs: number | null;
  unknown: boolean;
}

type CountKey = 'tests' | 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo';

const COUNT_KEYS: readonly CountKey[] = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const FOOTER_LINE_RE =
  /^\s*(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(.+?)\s*$/i;
const FAILURE_LINE_RE = /^\s*(?:✖|not ok\b)(.*)$/i;
const SUCCESS_LINE_RE = /^\s*(?:✔|ok\b)(.*)$/i;
const FAILURE_SUMMARY_HEADING_RE = /^failing tests:\s*$/i;
const MAX_FAILURE_CASES = 100;

function stripAnsi(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseNonNegativeSafeNumber(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseNonNegativeSafeInteger(value: string): number | null {
  const parsed = parseNonNegativeSafeNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function emptyCounts(): NodeTestCounts {
  return {
    tests: null,
    pass: null,
    fail: null,
    cancelled: null,
    skipped: null,
    todo: null,
    durationMs: null,
    unknown: true,
  };
}

function completeCounts(values: Partial<Record<CountKey, string>>): NodeTestCounts | null {
  if (!COUNT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(values, key))) return null;
  const counts: NodeTestCounts = {
    tests: null,
    pass: null,
    fail: null,
    cancelled: null,
    skipped: null,
    todo: null,
    durationMs: null,
    unknown: true,
  };
  for (const key of COUNT_KEYS) {
    const value = parseNonNegativeSafeInteger(values[key] ?? '');
    if (value === null) return null;
    counts[key] = value;
  }
  const derived =
    counts.pass! + counts.fail! + counts.cancelled! + counts.skipped! + counts.todo!;
  if (derived !== counts.tests) return null;
  counts.unknown = false;
  return counts;
}

function readCounts(stdout: string): NodeTestCounts {
  const lines = stdout.split(/\r?\n/).map(stripAnsi);
  const blocks: NodeTestCounts[] = [];
  let values: Partial<Record<CountKey, string>> = {};
  let durations: string[] = [];
  let suites: string | null = null;
  let formatter: string | null = null;
  let lastFooterAt = -10;
  const finish = (): void => {
    if (Object.keys(values).length === 0 && durations.length === 0 && suites === null) return;
    const complete = completeCounts(values);
    if (complete) {
      if (durations.length === 1) complete.durationMs = parseNonNegativeSafeNumber(durations[0]!);
      if (suites !== null && parseNonNegativeSafeInteger(suites) === null) complete.unknown = true;
      if (durations.length !== 1 || complete.durationMs === null || complete.durationMs === 0) {
        complete.unknown = true;
      }
      blocks.push(complete);
    } else {
      blocks.push(emptyCounts());
    }
    values = {};
    durations = [];
    suites = null;
    formatter = null;
    lastFooterAt = -10;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const footer = FOOTER_LINE_RE.exec(lines[index]!);
    if (!footer) continue;
    const key = footer[1]!.toLowerCase();
    const lineFormatter = lines[index]!.includes('ℹ') ? 'spec' : 'tap';
    if (
      index !== lastFooterAt + 1 ||
      (formatter !== null && formatter !== lineFormatter) ||
      ((key !== 'duration_ms' && Object.prototype.hasOwnProperty.call(values, key)) ||
        (key === 'suites' && suites !== null))
    ) {
      finish();
    }
    const currentKey = footer[1]!.toLowerCase();
    formatter = lineFormatter;
    if (currentKey === 'suites') suites = footer[2]!;
    else if (currentKey === 'duration_ms') durations.push(footer[2]!);
    else values[currentKey as CountKey] = footer[2]!;
    lastFooterAt = index;
  }
  finish();

  for (const block of blocks) {
    if (!block.unknown && block.tests === 0) block.unknown = true;
  }
  return blocks.at(-1) ?? emptyCounts();
}

export function parseNodeTestStdout(stdout: string): FixedTestSummary {
  const counts = readCounts(stdout);
  return {
    runner: 'node:test',
    total: counts.tests,
    passed: counts.pass,
    failed: counts.fail,
    skipped: counts.skipped,
    cancelled: counts.cancelled,
    todo: counts.todo,
    durationMs: counts.durationMs,
    unknown: counts.unknown,
  };
}

function failureCases(stdout: string): TestCaseSummary[] {
  const cases: TestCaseSummary[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const clean = stripAnsi(line);
    if (SUCCESS_LINE_RE.test(clean)) continue;
    const match = FAILURE_LINE_RE.exec(clean);
    if (!match) continue;
    const title = match[1]!.trim();
    if (FAILURE_SUMMARY_HEADING_RE.test(title)) continue;
    const name = redact(title).slice(0, 300);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cases.push({
      id: `node-failure-${cases.length + 1}`,
      title: name,
      status: 'failed',
      durationMs: null,
      error: null,
      artifacts: [],
    });
    if (cases.length >= MAX_FAILURE_CASES) break;
  }
  return cases;
}

export function createNodeTestRunRecord(input: {
  id?: string;
  stage: 'worker' | 'build' | 'manual';
  version?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  jobId?: string | null;
  reqId?: string | null;
  specHash?: string | null;
  sourceMainSha?: string | null;
  candidateTreeSha?: string | null;
  suiteFingerprint?: string | null;
  ok: boolean;
  stdout: string;
  cases?: TestCaseSummary[];
}): ReturnType<typeof createManualTestRunRecord> {
  return createManualTestRunRecord({
    id: input.id,
    stage: input.stage,
    runner: 'node:test',
    version: input.version ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    jobId: input.jobId ?? null,
    reqId: input.reqId ?? null,
    specHash: input.specHash ?? null,
    sourceMainSha: input.sourceMainSha ?? null,
    candidateTreeSha: input.candidateTreeSha ?? null,
    suiteFingerprint: input.suiteFingerprint ?? null,
    ok: input.ok,
    summary: parseNodeTestStdout(input.stdout),
    cases: input.cases ?? failureCases(input.stdout),
  });
}
