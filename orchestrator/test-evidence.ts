import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import { redact } from './log.ts';

export const TEST_RUNS_SCHEMA_VERSION = 'test-runs/v1' as const;

export type TestRunStatus = 'passed' | 'failed' | 'unknown';
export type TestEvidenceStage = 'worker' | 'build' | 'manual' | 'browser';
export type TestRunnerName = 'node:test' | 'playwright' | 'manual' | 'unknown';
export type TestArtifactKind = 'screenshot' | 'video' | 'trace' | 'json';

export interface FixedTestSummary {
  runner: 'node:test';
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  cancelled: number | null;
  todo: number | null;
  durationMs: number | null;
  unknown: boolean;
}

export interface BrowserTestSummary {
  runner: 'playwright';
  specCount: number | null;
  targetTestCount: number | null;
  resultCount: number | null;
  skipped: number | null;
  flaky: number | null;
  unexpected: number | null;
  errorCount: number | null;
  failedResultCount: number | null;
  retriedCount: number | null;
  unknown: boolean;
}

export type TestRunSummaryDetail = FixedTestSummary | BrowserTestSummary | null;

export interface TestArtifactSummary {
  id: string;
  kind: TestArtifactKind;
  name: string;
  href: string;
}

export interface TestCaseSummary {
  id: string;
  title: string;
  status: TestRunStatus;
  durationMs: number | null;
  error: string | null;
  artifacts: TestArtifactSummary[];
}

export interface TestRunSummary {
  id: string;
  stage: TestEvidenceStage;
  runner: TestRunnerName;
  version: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  jobId: string | null;
  reqId: string | null;
  specHash: string | null;
  /**
   * 冻结规格的仓库相对路径。与 dispatchRevision 一起用于区分相同 specHash/来源
   * SHA 的不同版本；旧记录或手工记录缺失时为 null。
   */
  specPath?: string | null;
  /** 本记录对应的已发布派工版本号；缺失时不能按哈希反推 rN。 */
  dispatchRevision?: number | null;
  sourceMainSha: string | null;
  candidateTreeSha: string | null;
  suiteFingerprint: string | null;
  ok: boolean | null;
  summary: TestRunSummaryDetail;
  cases: TestCaseSummary[];
  /** 运行级附件（如原始 Playwright JSON 报告），与用例附件分离。 */
  artifacts?: TestArtifactSummary[];
}

export interface TestRunsResponse {
  schemaVersion: typeof TEST_RUNS_SCHEMA_VERSION;
  runs: TestRunSummary[];
}

export interface TestRunArtifactMeta {
  id: string;
  kind: TestArtifactKind;
  name: string;
}

export interface TestRunRecord extends Omit<TestRunSummary, 'cases'> {
  cases: TestCaseSummary[];
}

export interface TestEvidenceStoreOptions {
  rootDir: string;
  maxRuns?: number;
  maxIndexBytes?: number;
  maxDepth?: number;
  maxEntries?: number;
  maxArtifactBytes?: number;
}

export const DEFAULT_TEST_EVIDENCE_LIMITS = {
  maxRuns: 100,
  maxIndexBytes: 512 * 1024,
  maxDepth: 8,
  maxEntries: 2000,
  maxArtifactBytes: 512 * 1024 * 1024,
} as const;

const MAX_CASES_PER_RUN = 1000;
const MAX_ARTIFACTS_PER_LIST = 256;

export interface TestEvidenceStore {
  rootDir: string;
  listRuns: () => TestRunsResponse;
  readRunArtifact: (runId: string, artifactId: string) => TestEvidenceArtifact | null;
}

export interface TestEvidenceArtifact {
  runId: string;
  artifactId: string;
  name: string;
  kind: TestArtifactKind;
  contentType: string;
  size: number;
  path: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,127}$/i;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TEST_RUN_SPEC_PATH_RE = /^docs\/specs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const KIND_BY_EXT: Record<string, TestArtifactKind | undefined> = {
  '.png': 'screenshot',
  '.webm': 'video',
  '.zip': 'trace',
  '.json': 'json',
};
const CONTENT_TYPES: Record<TestArtifactKind, string> = {
  screenshot: 'image/png',
  video: 'video/webm',
  trace: 'application/zip',
  json: 'application/json',
};

function normalizeRunId(value: string): string | null {
  if (!ID_RE.test(value)) return null;
  const normalized = normalize(value);
  if (normalized !== value) return null;
  if (normalized === '.' || normalized === '..' || normalized.includes(sep)) return null;
  return normalized;
}

function normalizeArtifactId(value: string): string | null {
  if (!ID_RE.test(value)) return null;
  const normalized = normalize(value);
  if (normalized !== value) return null;
  if (normalized === '.' || normalized === '..' || normalized.includes(sep)) return null;
  return normalized;
}

function redactText(value: string): string {
  const plain = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, '');
  const redacted = redact(plain);
  return redacted.length > 800 ? `${redacted.slice(0, 800)}…` : redacted;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function isTestRunSpecPath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && TEST_RUN_SPEC_PATH_RE.test(value)
    && !value.split('/').includes('..')
  );
}

export function isTestRunDispatchRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stageOf(value: unknown): TestEvidenceStage | null {
  return value === 'worker' || value === 'build' || value === 'manual' || value === 'browser' ? value : null;
}

function runnerOf(value: unknown): TestRunnerName | null {
  return value === 'node:test' || value === 'playwright' || value === 'manual' || value === 'unknown'
    ? value
    : null;
}

function statusOf(value: unknown): TestRunStatus | null {
  return value === 'passed' || value === 'failed' || value === 'unknown' ? value : null;
}

function kindOf(value: unknown): TestArtifactKind | null {
  return value === 'screenshot' || value === 'video' || value === 'trace' || value === 'json'
    ? value
    : null;
}

function parseArtifact(record: Record<string, unknown>, fallbackId: string): TestArtifactSummary | null {
  const id = typeof record.id === 'string' && normalizeArtifactId(record.id) ? record.id : fallbackId;
  const kind = kindOf(record.kind);
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 200) : 'artifact';
  if (!kind) return null;
  return {
    id,
    kind,
    name,
    href: `/api/test-runs/<run-id>/artifacts/${encodeURIComponent(id)}`,
  };
}

function parseArtifactList(value: unknown, fallbackPrefix: string): TestArtifactSummary[] {
  if (!Array.isArray(value)) return [];
  const artifacts: TestArtifactSummary[] = [];
  for (let index = 0; index < value.length && artifacts.length < MAX_ARTIFACTS_PER_LIST; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const parsed = parseArtifact(item as Record<string, unknown>, `${fallbackPrefix}-artifact-${index + 1}`);
    if (parsed) artifacts.push(parsed);
  }
  return artifacts;
}

function parseCase(record: Record<string, unknown>): TestCaseSummary | null {
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim().slice(0, 160) : '';
  if (!id) return null;
  const artifacts = parseArtifactList(record.artifacts, id);
  return {
    id,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim().slice(0, 300) : id,
    status: statusOf(record.status) ?? 'unknown',
    durationMs: nullableNumber(record.durationMs),
    error: typeof record.error === 'string' && record.error.trim() ? redactText(record.error) : null,
    artifacts,
  };
}

function parseFixedSummary(raw: unknown): FixedTestSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = raw as Record<string, unknown>;
  const total = safeCount(summary.total);
  const passed = safeCount(summary.passed);
  const failed = safeCount(summary.failed);
  const skipped = safeCount(summary.skipped);
  const cancelled = safeCount(summary.cancelled);
  const todo = safeCount(summary.todo);
  const complete =
    total !== null &&
    passed !== null &&
    failed !== null &&
    skipped !== null &&
    cancelled !== null &&
    todo !== null &&
    passed + failed + skipped + cancelled + todo === total;
  return {
    runner: 'node:test',
    total,
    passed,
    failed,
    skipped,
    cancelled,
    todo,
    durationMs: nullableNumber(summary.durationMs),
    unknown: !complete || summary.unknown === true,
  };
}

function parseBrowserSummary(raw: unknown): BrowserTestSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = raw as Record<string, unknown>;
  const specCount = safeCount(summary.specCount);
  const targetTestCount = safeCount(summary.targetTestCount);
  const resultCount = safeCount(summary.resultCount);
  const skipped = safeCount(summary.skipped);
  const flaky = safeCount(summary.flaky);
  const unexpected = safeCount(summary.unexpected);
  const errorCount = safeCount(summary.errorCount);
  const failedResultCount = safeCount(summary.failedResultCount);
  const retriedCount = safeCount(summary.retriedCount);
  const complete =
    specCount !== null &&
    targetTestCount !== null &&
    resultCount !== null &&
    skipped !== null &&
    flaky !== null &&
    unexpected !== null &&
    errorCount !== null &&
    failedResultCount !== null &&
    retriedCount !== null;
  return {
    runner: 'playwright',
    specCount,
    targetTestCount,
    resultCount,
    skipped,
    flaky,
    unexpected,
    errorCount,
    failedResultCount,
    retriedCount,
    unknown: !complete || summary.unknown === true,
  };
}

function parseSummary(record: Record<string, unknown>, runner: TestRunnerName): TestRunSummaryDetail {
  const raw = record.summary;
  if (runner === 'node:test') return parseFixedSummary(raw);
  if (runner === 'playwright') return parseBrowserSummary(raw);
  return null;
}

export function parseTestRunRecord(raw: unknown): TestRunRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeRunId(typeof record.id === 'string' ? record.id : '');
  const stage = stageOf(record.stage);
  const runner = runnerOf(record.runner);
  if (!id || !stage || !runner) return null;

  const rawCases = Array.isArray(record.cases) ? record.cases : [];
  const cases: TestCaseSummary[] = [];
  for (let index = 0; index < rawCases.length && cases.length < MAX_CASES_PER_RUN; index += 1) {
    const item = rawCases[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const parsed = parseCase(item as Record<string, unknown>);
    if (parsed) cases.push(parsed);
  }

  const specHash = nullableString(record.specHash);
  const sourceMainSha = nullableString(record.sourceMainSha);
  const candidateTreeSha = nullableString(record.candidateTreeSha);
  const suiteFingerprint = nullableString(record.suiteFingerprint);
  const specPath = record.specPath === undefined || record.specPath === null
    ? null
    : record.specPath;
  const dispatchRevision = record.dispatchRevision === undefined || record.dispatchRevision === null
    ? null
    : record.dispatchRevision;

  if (specHash && !SHA256_RE.test(specHash)) return null;
  if (sourceMainSha && !SHA_RE.test(sourceMainSha)) return null;
  if (candidateTreeSha && !SHA_RE.test(candidateTreeSha)) return null;
  if (suiteFingerprint && !SHA256_RE.test(suiteFingerprint)) return null;
  if (specPath !== null && !isTestRunSpecPath(specPath)) return null;
  if (dispatchRevision !== null && !isTestRunDispatchRevision(dispatchRevision)) return null;

  return {
    id,
    stage,
    runner,
    version: nullableString(record.version),
    startedAt: nullableString(record.startedAt),
    finishedAt: nullableString(record.finishedAt),
    jobId: nullableString(record.jobId),
    reqId: nullableString(record.reqId),
    specHash,
    specPath,
    dispatchRevision,
    sourceMainSha,
    candidateTreeSha,
    suiteFingerprint,
    ok: nullableBoolean(record.ok),
    summary: parseSummary(record, runner),
    cases,
    artifacts: parseArtifactList(record.artifacts, id),
  };
}

function readJsonAt(path: string, maxBytes: number): unknown {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > maxBytes) throw new Error('记录过大');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function safePathExistsWithin(root: string, child: string): boolean {
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(join(root, child));
  return candidateReal === rootReal || candidateReal.startsWith(`${rootReal}${sep}`);
}

interface ScanBudget {
  entries: number;
  runs: number;
}

function collectRunDir(
  dir: string,
  depth: number,
  budget: ScanBudget,
  maxEntries: number,
  out: string[],
): void {
  if (depth < 0 || budget.entries >= maxEntries) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.entries >= maxEntries) break;
    budget.entries += 1;
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name === 'test-run.json') {
      out.push(join(dir, entry.name));
      budget.runs += 1;
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      collectRunDir(join(dir, entry.name), depth - 1, budget, maxEntries, out);
    }
  }
}

export function createTestEvidenceStore(opts: TestEvidenceStoreOptions): TestEvidenceStore {
  const rootDir = resolveSeatbeltLike(opts.rootDir);
  const maxRuns = opts.maxRuns ?? DEFAULT_TEST_EVIDENCE_LIMITS.maxRuns;
  const maxIndexBytes = opts.maxIndexBytes ?? DEFAULT_TEST_EVIDENCE_LIMITS.maxIndexBytes;
  const maxDepth = opts.maxDepth ?? DEFAULT_TEST_EVIDENCE_LIMITS.maxDepth;
  const maxEntries = opts.maxEntries ?? DEFAULT_TEST_EVIDENCE_LIMITS.maxEntries;
  const maxArtifactBytes = opts.maxArtifactBytes ?? DEFAULT_TEST_EVIDENCE_LIMITS.maxArtifactBytes;
  mkdirSync(rootDir, { recursive: true });

  const listRuns = (): TestRunsResponse => {
    const candidates: string[] = [];
    if (existsSync(rootDir)) {
      collectRunDir(rootDir, maxDepth, { entries: 0, runs: 0 }, maxEntries, candidates);
    }

    const runs: TestRunRecord[] = [];
    for (const path of candidates) {
      let raw: unknown;
      try {
        raw = readJsonAt(path, maxIndexBytes);
      } catch {
        continue;
      }
      const parsed = parseTestRunRecord(raw);
      if (parsed && parsed.id === basename(dirname(path))) runs.push(parsed);
    }
    runs.sort((a, b) => {
      const left = Date.parse(a.startedAt ?? a.finishedAt ?? '') || 0;
      const right = Date.parse(b.startedAt ?? b.finishedAt ?? '') || 0;
      return right - left || a.id.localeCompare(b.id);
    });

    return {
      schemaVersion: TEST_RUNS_SCHEMA_VERSION,
      runs: runs.slice(0, maxRuns).map((run) => {
        const hrefOf = (artifactId: string): string =>
          `/api/test-runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifactId)}`;
        return {
          ...run,
          artifacts: (run.artifacts ?? []).map((artifact) => ({ ...artifact, href: hrefOf(artifact.id) })),
          cases: run.cases.map((item) => ({
            ...item,
            artifacts: item.artifacts.map((artifact) => ({ ...artifact, href: hrefOf(artifact.id) })),
          })),
        };
      }),
    };
  };

  const manifestArtifacts = (parsed: TestRunRecord): TestArtifactSummary[] => {
    const caseArtifacts = parsed.cases.flatMap((item) => item.artifacts);
    return [...(parsed.artifacts ?? []), ...caseArtifacts];
  };

  const readRunArtifact = (runId: string, artifactId: string): TestEvidenceArtifact | null => {
    const safeRunId = normalizeRunId(runId);
    const safeArtifactId = normalizeArtifactId(artifactId);
    if (!safeRunId || !safeArtifactId) return null;

    const runDir = join(rootDir, safeRunId);
    if (!existsSync(runDir)) return null;
    try {
      if (!safePathExistsWithin(rootDir, safeRunId)) return null;
    } catch {
      return null;
    }

    const manifestPath = join(runDir, 'test-run.json');
    try {
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    let manifest: unknown;
    try {
      manifest = readJsonAt(manifestPath, maxIndexBytes);
    } catch {
      return null;
    }
    const parsed = parseTestRunRecord(manifest);
    if (!parsed) return null;
    if (parsed.id !== safeRunId) return null;
    const match = manifestArtifacts(parsed).find((artifact) => artifact.id === safeArtifactId);
    if (!match) return null;

    const artifactPath = join(runDir, match.id);
    try {
      if (!safePathExistsWithin(runDir, match.id)) return null;
      const stat = lstatSync(artifactPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      if (stat.size > maxArtifactBytes) return null;
      return {
        runId: safeRunId,
        artifactId: safeArtifactId,
        name: match.name,
        kind: match.kind,
        contentType: CONTENT_TYPES[match.kind],
        size: stat.size,
        path: artifactPath,
      };
    } catch {
      return null;
    }
  };

  return { rootDir, listRuns, readRunArtifact };
}

function resolveSeatbeltLike(path: string): string {
  return normalize(path);
}

export function newOpaqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

export function createManualTestRunRecord(input: {
  id?: string;
  stage: TestEvidenceStage;
  runner: TestRunnerName;
  version?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  jobId?: string | null;
  reqId?: string | null;
  specHash?: string | null;
  specPath?: string | null;
  dispatchRevision?: number | null;
  sourceMainSha?: string | null;
  candidateTreeSha?: string | null;
  suiteFingerprint?: string | null;
  ok?: boolean | null;
  summary?: TestRunSummaryDetail;
  cases?: TestCaseSummary[];
  artifacts?: TestArtifactSummary[];
}): TestRunRecord {
  const now = new Date().toISOString();
  return {
    id: input.id ?? newOpaqueId('manual'),
    stage: input.stage,
    runner: input.runner,
    version: input.version ?? null,
    startedAt: input.startedAt === undefined ? now : input.startedAt,
    finishedAt: input.finishedAt === undefined ? now : input.finishedAt,
    jobId: input.jobId ?? null,
    reqId: input.reqId ?? null,
    specHash: input.specHash ?? null,
    specPath: input.specPath ?? null,
    dispatchRevision: input.dispatchRevision ?? null,
    sourceMainSha: input.sourceMainSha ?? null,
    candidateTreeSha: input.candidateTreeSha ?? null,
    suiteFingerprint: input.suiteFingerprint ?? null,
    ok: input.ok ?? null,
    summary: input.summary ?? null,
    cases: input.cases ?? [],
    artifacts: input.artifacts ?? [],
  };
}

export function writeTestRunRecord(rootDir: string, record: TestRunRecord): string {
  const runDir = join(rootDir, record.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'test-run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return runDir;
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function artifactKindFromName(name: string): TestArtifactKind | null {
  return KIND_BY_EXT[extname(name).toLowerCase()] ?? null;
}

export function artifactHref(runId: string, artifactId: string): string {
  return `/api/test-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function testEvidenceArtifactPath(rootDir: string, runId: string, artifactId: string): string | null {
  const safeRunId = normalizeRunId(runId);
  const safeArtifactId = normalizeArtifactId(artifactId);
  if (!safeRunId || !safeArtifactId) return null;
  const path = join(rootDir, safeRunId, safeArtifactId);
  return path;
}

export function normalizeRelativeArtifactPath(path: string): string | null {
  const normalized = normalize(path);
  if (normalized !== path || normalized === '.' || normalized === '..' || normalized.includes(sep)) return null;
  return normalized;
}

export function stageDisplayName(stage: TestEvidenceStage): string {
  if (stage === 'worker') return 'Worker 验证';
  if (stage === 'build') return '构建验证';
  if (stage === 'manual') return '手动记录';
  return '浏览器验收';
}

export function runnerDisplayName(runner: TestRunnerName): string {
  if (runner === 'node:test') return 'node:test';
  if (runner === 'playwright') return 'Playwright';
  if (runner === 'manual') return '手动';
  return '未知';
}
