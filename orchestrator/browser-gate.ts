import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import type { Logger } from './log.ts';
import { buildIsolationPaths, runSandboxed, sandboxExecAvailable, sandboxExecBin, type IsolationPaths, type SandboxProfileSpec } from './sandbox.ts';
import { splitSpecSections } from './dispatch-task.ts';
import { parseSpecs } from './specs.ts';
import {
  artifactKindFromName,
  createManualTestRunRecord,
  writeTestRunRecord,
  type TestArtifactSummary,
  type TestCaseSummary,
  type TestArtifactKind,
  type TestRunRecord,
  type TestRunStatus,
  type TestRunSummaryDetail,
} from './test-evidence.ts';

export type E2eProject = 'counter' | 'panel';

export interface E2eContract {
  reqId?: string;
  specPath?: string;
  specHash?: string;
  caseIds: string[];
  /** 面板业务门禁的验收映射：键 A1..An，值是对应受信 caseId 非空数组。 */
  acceptanceCases?: Record<string, string[]>;
}

export interface E2eReportSummary {
  specCount: number;
  targetTestCount: number;
  resultCount: number;
  skipped: number;
  flaky: number;
  unexpected: number;
  errorCount: number;
  caseIds: string[];
  failedResultCount: number;
  retriedCount: number;
  unexpectedExpectedStatusCount: number;
  wrongTestCount: number;
  wrongResultCount: number;
}

const CASE_ID_RE = /^\s*([A-Za-z0-9][A-Za-z0-9_-]*)/;
const SHA256_RE = /^[0-9a-f]{64}$/;
export const DEFAULT_BROWSER_GATE_TIMEOUT_MS = 180_000;
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const MAX_RUN_ATTACHMENT_BYTES = 1024 * 1024 * 1024;

/** 进程内单调序号，配合时间戳保证每次执行目录唯一，同时不删除历史 attempt 证据。 */
let gateRunSeq = 0;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function resolveBrowserCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PLAYWRIGHT_BROWSERS_PATH?.trim() || env.SPEC_LOOP_PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (explicit) return resolveExistingOrNormalize(explicit);
  return resolveExistingOrNormalize(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
}

/**
 * macOS 的 os.tmpdir() 可能返回 `/var/folders/...` 别名，而 Seatbelt 写范围只匹配真实
 * `/private/var/folders/...`。所有门禁目录统一落到真实路径，避免 EPERM 别名不一致。
 */
export function resolveSeatbeltPath(path: string): string {
  if (!path) return path;
  const normalized = normalize(path);
  try {
    return realpathSync(normalized);
  } catch {
    const parts = normalized.split(sep);
    let index = parts.length;
    while (index > 0) {
      const candidate = parts.slice(0, index).join(sep) || sep;
      try {
        const real = realpathSync(candidate);
        return join(real, ...parts.slice(index));
      } catch {
        index -= 1;
      }
    }
    return normalized;
  }
}

function resolveExistingOrNormalize(path: string): string {
  if (existsSync(path)) return resolveSeatbeltPath(path);
  return normalize(path);
}

export function browserGateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPEC_LOOP_E2E_TIMEOUT_MS;
  if (!raw) return DEFAULT_BROWSER_GATE_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BROWSER_GATE_TIMEOUT_MS;
}

function normalizeCaseIds(caseIds: unknown, legacyCases: unknown): string[] {
  const source = Array.isArray(caseIds) ? caseIds : Array.isArray(legacyCases) ? legacyCases : undefined;
  if (!source) {
    if (caseIds !== undefined || legacyCases !== undefined) {
      throw new Error('验收契约 caseIds/cases 必须是数组');
    }
    return [];
  }
  const ids: string[] = [];
  for (const item of source) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error('caseIds 只能包含非空字符串');
    }
    const id = item.trim();
    if (id) {
      ids.push(id);
    }
  }
  if (ids.length !== new Set(ids).size) {
    throw new Error('caseIds 存在重复项');
  }
  return ids;
}

function normalizeLegacyCases(caseIds: unknown, legacyCases: unknown): string[] {
  if (Array.isArray(caseIds)) {
    return normalizeCaseIds(caseIds, undefined);
  }
  if (Array.isArray(legacyCases)) {
    const ids: string[] = [];
    for (const item of legacyCases) {
      if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') {
        throw new Error('cases 兼容字段只能包含带 string id 的对象');
      }
      const id = (item as { id: string }).id.trim();
      if (!id) throw new Error('cases 兼容字段存在空 id');
      ids.push(id);
    }
    if (ids.length !== new Set(ids).size) {
      throw new Error('caseIds 存在重复项');
    }
    return ids;
  }
  if (caseIds !== undefined || legacyCases !== undefined) {
    throw new Error('验收契约 caseIds/cases 必须是数组');
  }
  return [];
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value.trim();
}

const ACCEPTANCE_KEY_RE = /^A[0-9]+$/;

/**
 * 解析面板可选验收映射：键 A1..An，值是对应受信 caseId 非空数组，且必须都已在 caseIds 中声明。
 * 各条 A 的 caseId 之间不要求互斥，同一个真实浏览器用例可以覆盖多条验收（如 A6/A8）；
 * 只要求同一条 A 内没有重复 caseId。
 */
function normalizeAcceptanceCases(raw: unknown, caseIds: string[]): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('acceptanceCases 必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw new Error('acceptanceCases 不能为空');
  }
  const declared = new Set(caseIds);
  const result: Record<string, string[]> = {};
  for (const key of keys) {
    if (!ACCEPTANCE_KEY_RE.test(key)) {
      throw new Error(`acceptanceCases 键必须是 A1..An，非法键: ${key}`);
    }
    const value = record[key];
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`acceptanceCases.${key} 必须是非空数组`);
    }
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`acceptanceCases.${key} 只能包含非空字符串`);
      }
      const id = item.trim();
      if (!declared.has(id)) {
        throw new Error(`acceptanceCases.${key} 的 caseId ${id} 未在 caseIds 中声明`);
      }
      ids.push(id);
    }
    if (ids.length !== new Set(ids).size) {
      throw new Error(`acceptanceCases.${key} 的 caseId 存在重复`);
    }
    result[key] = ids;
  }
  return result;
}

export function parseE2eContract(raw: unknown, project: E2eProject): E2eContract {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('验收契约必须是 JSON 对象');
  }
  const c = raw as Record<string, unknown>;
  const caseIds = normalizeLegacyCases(c.caseIds, c.cases);
  if (caseIds.length === 0) {
    throw new Error('验收契约缺少非空 caseIds');
  }
  if (project === 'counter') {
    const reqId = readNonEmptyString(c, 'reqId') ?? '';
    const specPath = readNonEmptyString(c, 'specPath') ?? '';
    const specHash = readNonEmptyString(c, 'specHash') ?? '';
    if (!reqId || !specPath || !SHA256_RE.test(specHash)) {
      throw new Error('counter 契约必须包含 reqId、specPath 与 64 位 specHash');
    }
    return { reqId, specPath, specHash, caseIds };
  }
  const reqId = readNonEmptyString(c, 'reqId') ?? '';
  const specPath = readNonEmptyString(c, 'specPath') ?? '';
  const specHash = readNonEmptyString(c, 'specHash') ?? '';
  if ((reqId || specPath || specHash) && (!reqId || !specPath || !specHash)) {
    throw new Error('panel 契约的产品绑定必须同时包含 reqId、specPath 与 specHash');
  }
  if (specHash && !SHA256_RE.test(specHash)) {
    throw new Error('panel 契约 specHash 必须是 64 位十六进制');
  }
  const acceptanceCases = normalizeAcceptanceCases(c.acceptanceCases, caseIds);
  if (reqId || specPath || specHash) {
    return { reqId, specPath, specHash, caseIds, acceptanceCases };
  }
  return { caseIds, acceptanceCases };
}

export interface CounterContractCheck {
  ok: boolean;
  detail: string;
  specHash: string;
}

export function verifyCounterContract(
  contract: E2eContract,
  specFiles: Record<string, string>,
  expectedReqId?: string,
): CounterContractCheck {
  const reqId = contract.reqId ?? '';
  const specPath = contract.specPath ?? '';
  const specHash = contract.specHash ?? '';
  const parsed = parseSpecs(specFiles);
  if (parsed.errors.length > 0) {
    return { ok: false, detail: `规格解析失败: ${parsed.errors[0]?.reason ?? '未知错误'}`, specHash: '' };
  }
  const spec = parsed.specs.find((s) => s.id === reqId);
  if (!spec) {
    return { ok: false, detail: `契约 reqId ${reqId} 不在候选规格快照中`, specHash: '' };
  }
  if (spec.path !== specPath) {
    return { ok: false, detail: `契约 specPath ${specPath} 与候选 ${spec.path} 不一致`, specHash: spec.hash };
  }
  if (spec.hash !== specHash) {
    return {
      ok: false,
      detail: `验收基线 specHash 已过期：契约 ${specHash.slice(0, 8)} 与候选 ${spec.hash.slice(0, 8)} 不一致`,
      specHash: spec.hash,
    };
  }
  if (expectedReqId !== undefined && expectedReqId !== reqId) {
    return { ok: false, detail: `契约 reqId ${reqId} 与本次需求 ${expectedReqId} 不匹配`, specHash: spec.hash };
  }
  return { ok: true, detail: '验收契约与候选规格一致', specHash: spec.hash };
}

/**
 * 面板业务门禁的第二道校验：对照所选规格的每条验收（A1..An），验收映射必须完整覆盖。
 * 规格本身无验收条目时不强制映射；缺失映射即 fail closed，避免冒烟单独产生产品成功。
 */
export function verifyPanelAcceptanceCoverage(
  contract: E2eContract,
  specFiles: Record<string, string>,
  expectedReqId?: string,
): CounterContractCheck {
  const reqId = contract.reqId ?? '';
  const parsed = parseSpecs(specFiles);
  if (parsed.errors.length > 0) {
    return { ok: false, detail: `规格解析失败: ${parsed.errors[0]?.reason ?? '未知错误'}`, specHash: '' };
  }
  const spec = parsed.specs.find((s) => s.id === reqId);
  if (!spec) {
    return { ok: false, detail: `契约 reqId ${reqId} 不在候选规格快照中`, specHash: '' };
  }
  const requiredKeys = splitSpecSections(spec.body).acceptances.map((_, index) => `A${index + 1}`);
  const mapping = contract.acceptanceCases ?? {};
  const actualKeys = Object.keys(mapping);
  const required = new Set(requiredKeys);
  const actual = new Set(actualKeys);
  const missing = requiredKeys.filter((key) => !actual.has(key));
  const extra = actualKeys.filter((key) => !required.has(key));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      detail: `验收映射键必须与规格 A1..An 精确相等：缺失 [${missing.join(', ') || '无'}]，多余 [${extra.join(', ') || '无'}]`,
      specHash: spec.hash,
    };
  }
  return { ok: true, detail: '验收映射与所选规格 A1..An 精确相等', specHash: spec.hash };
}

export function extractCaseId(title: string): string | undefined {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  const match = CASE_ID_RE.exec(trimmed);
  return match?.[1];
}

export function matchCaseIds(contractCaseIds: string[], executedCaseIds: string[]): { ok: boolean; detail: string } {
  if (executedCaseIds.length === 0) {
    return { ok: false, detail: '未执行任何验收用例' };
  }
  if (executedCaseIds.length !== new Set(executedCaseIds).size) {
    return { ok: false, detail: '执行用例存在重复 caseId' };
  }
  if (contractCaseIds.length !== new Set(contractCaseIds).size) {
    return { ok: false, detail: '契约 caseIds 存在重复' };
  }
  const expected = new Set(contractCaseIds);
  const actual = new Set(executedCaseIds);
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      detail: `用例集合不匹配：缺失 [${missing.join(', ') || '无'}]，多余 [${extra.join(', ') || '无'}]`,
    };
  }
  return { ok: true, detail: `已核对 ${actual.size} 个验收用例` };
}

interface RawTestResult {
  status?: unknown;
  retry?: unknown;
  duration?: unknown;
  error?: unknown;
  attachments?: unknown;
}

interface RawTest {
  expectedStatus?: unknown;
  status?: unknown;
  results?: unknown;
  projectName?: unknown;
}

interface RawSpec {
  title?: unknown;
  tests?: unknown;
}

interface RawSuite {
  specs?: unknown;
  suites?: unknown;
}

function collectSpecs(suites: unknown, out: RawSpec[]): void {
  if (!Array.isArray(suites)) return;
  for (const suite of suites) {
    if (!suite || typeof suite !== 'object') continue;
    const s = suite as RawSuite;
    if (Array.isArray(s.specs)) {
      for (const spec of s.specs) {
        if (spec && typeof spec === 'object') out.push(spec as RawSpec);
      }
    }
    collectSpecs(s.suites, out);
  }
}

function requireObjectArray(root: Record<string, unknown>, key: string): unknown[] {
  const value = root[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Playwright 报告 ${key} 必须是数组`);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Playwright 报告 ${key} 数组只能包含对象`);
    }
  }
  return value as unknown[];
}

export function summarizePlaywrightReport(raw: unknown, project: E2eProject): E2eReportSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Playwright 报告必须是 JSON 对象');
  }
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.suites)) {
    throw new Error('Playwright 报告缺少 suites 数组');
  }
  const errors = requireObjectArray(root, 'errors');

  const specs: RawSpec[] = [];
  collectSpecs(root.suites, specs);

  let specCount = 0;
  let targetTestCount = 0;
  let resultCount = 0;
  let skipped = 0;
  let flaky = 0;
  let unexpected = 0;
  let failedResultCount = 0;
  let retriedCount = 0;
  let unexpectedExpectedStatusCount = 0;
  let wrongTestCount = 0;
  let wrongResultCount = 0;
  const caseIds: string[] = [];

  for (const spec of specs) {
    specCount += 1;
    const title = typeof spec.title === 'string' ? spec.title.trim() : '';
    if (!title) throw new Error('spec 缺少标题');
    const caseId = extractCaseId(title);
    if (!caseId) throw new Error(`spec 标题缺少前导 caseId: ${title}`);
    caseIds.push(caseId);

    if (!Array.isArray(spec.tests)) {
      throw new Error(`spec 缺少 tests 数组: ${title}`);
    }
    const targetTests = spec.tests.filter((t) => {
      if (!t || typeof t !== 'object') throw new Error(`test 必须是对象: ${title}`);
      const test = t as RawTest;
      if (test.projectName !== undefined && typeof test.projectName !== 'string') {
        throw new Error(`test.projectName 必须是字符串: ${title}`);
      }
      return test.projectName === project;
    });
    if (targetTests.length !== 1) {
      wrongTestCount += 1;
      continue;
    }
    targetTestCount += 1;
    const test = targetTests[0] as RawTest;

    const expectedStatus = typeof test.expectedStatus === 'string' ? test.expectedStatus : '';
    if (expectedStatus !== 'passed') unexpectedExpectedStatusCount += 1;

    const status = typeof test.status === 'string' ? test.status : 'unknown';
    switch (status) {
      case 'expected':
        break;
      case 'skipped':
        skipped += 1;
        break;
      case 'flaky':
        flaky += 1;
        break;
      default:
        unexpected += 1;
        break;
    }

    if (!Array.isArray(test.results)) {
      throw new Error(`test 缺少 results 数组: ${title}`);
    }
    const results = test.results.filter((r) => {
      if (!r || typeof r !== 'object') throw new Error(`result 必须是对象: ${title}`);
      return true;
    });
    if (results.length !== 1) {
      wrongResultCount += 1;
      continue;
    }
    resultCount += 1;
    const result = results[0] as RawTestResult;
    const resultStatus = typeof result.status === 'string' ? result.status : '';
    if (resultStatus !== 'passed') failedResultCount += 1;
    const retry = typeof result.retry === 'number' ? result.retry : -1;
    if (retry !== 0) retriedCount += 1;
  }

  return {
    specCount,
    targetTestCount,
    resultCount,
    caseIds,
    skipped,
    flaky,
    unexpected,
    errorCount: errors.length,
    failedResultCount,
    retriedCount,
    unexpectedExpectedStatusCount,
    wrongTestCount,
    wrongResultCount,
  };
}

export function validateE2eReport(
  summary: E2eReportSummary,
  contractCaseIds: string[],
): { ok: boolean; detail: string } {
  if (summary.specCount === 0) {
    return { ok: false, detail: 'Playwright 报告包含 0 个用例' };
  }
  if (summary.wrongTestCount > 0) {
    return { ok: false, detail: `存在 ${summary.wrongTestCount} 个 spec 的目标 project test 数不为 1` };
  }
  if (summary.wrongResultCount > 0) {
    return { ok: false, detail: `存在 ${summary.wrongResultCount} 个 test 的实际 result 数不为 1` };
  }
  if (summary.targetTestCount !== summary.specCount || summary.resultCount !== summary.specCount) {
    return { ok: false, detail: '用例数量与执行结果数量不一致' };
  }
  if (summary.skipped > 0) {
    return { ok: false, detail: `存在 ${summary.skipped} 个 skipped 用例` };
  }
  if (summary.flaky > 0) {
    return { ok: false, detail: `存在 ${summary.flaky} 个 flaky 用例` };
  }
  if (summary.unexpected > 0) {
    return { ok: false, detail: `存在 ${summary.unexpected} 个 unexpected 用例` };
  }
  if (summary.errorCount > 0) {
    return { ok: false, detail: `Playwright 报告存在 ${summary.errorCount} 个错误` };
  }
  if (summary.failedResultCount > 0) {
    return { ok: false, detail: `存在 ${summary.failedResultCount} 个实际执行结果非 passed` };
  }
  if (summary.retriedCount > 0) {
    return { ok: false, detail: `存在 ${summary.retriedCount} 个 retry != 0 的结果，验收要求 retry=0` };
  }
  if (summary.unexpectedExpectedStatusCount > 0) {
    return { ok: false, detail: `存在 ${summary.unexpectedExpectedStatusCount} 个 expectedStatus 非 passed 用例` };
  }
  return matchCaseIds(contractCaseIds, summary.caseIds);
}

export function computeE2eSuiteFingerprint(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(files[path] ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function readSpecFilesFromDir(rootDir: string): Record<string, string> {
  const specsDir = join(rootDir, 'docs', 'specs');
  const files: Record<string, string> = {};
  if (!existsSync(specsDir)) return files;
  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const rel = `docs/specs/${entry.name}`;
    files[rel] = readFileSync(join(specsDir, entry.name), 'utf8');
  }
  return files;
}

/** 受信规格的冻结身份：门禁按此精确读取候选快照，缺失或不符 fail closed。 */
export interface FrozenSpecIdentity {
  reqId: string;
  specPath: string;
  specHash: string;
}

/**
 * 从候选快照按冻结身份读取精确白名单规格文件（不递归）。
 *
 * 与 `readSpecFilesFromDir` 的目录扫描不同，这里只读取冻结 `specPath` 指向的整份文件，
 * 用 lstat 拒绝符号链接、以 parseSpecs 复核 reqId/path/hash；链接或哈希不符抛错，
 * 缺失时返回空对象，由真实门禁按“reqId 不在候选规格快照中”fail closed。返回
 * `{ [specPath]: 原文 }`，供 Worker 与合并构建的浏览器门禁共用，不能用输入正文补写所验树。
 */
export function readCandidateSpecFile(
  candidateRoot: string,
  frozen: FrozenSpecIdentity,
): Record<string, string> {
  if (!frozen.reqId || !frozen.specPath || !frozen.specHash) {
    throw new Error('候选规格读取缺少冻结身份 reqId/specPath/specHash');
  }
  const path = frozen.specPath.replace(/\\/g, '/');
  if (path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`冻结规格路径非法: ${frozen.specPath}`);
  }
  if (path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`冻结规格路径非法: ${frozen.specPath}`);
  }
  const parts = path.split('/');
  let archivedPath = candidateRoot;
  for (let index = 0; index < parts.length; index += 1) {
    archivedPath = join(archivedPath, parts[index]!);
    let stat;
    try {
      stat = lstatSync(archivedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(
        `无法读取候选快照中的受信规格（${archivedPath}）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`候选快照中的受信规格路径包含符号链接: ${frozen.specPath}`);
    }
    const last = index === parts.length - 1;
    if ((!last && !stat.isDirectory()) || (last && !stat.isFile())) {
      throw new Error(`候选快照中的受信规格不是普通文件: ${frozen.specPath}`);
    }
  }
  const body = readFileSync(archivedPath, 'utf8');
  const parsed = parseSpecs({ [frozen.specPath]: body });
  if (parsed.errors.length > 0) {
    throw new Error(`候选规格解析失败: ${parsed.errors[0]?.reason ?? '未知错误'}`);
  }
  const exact = parsed.specs.find(
    (spec) =>
      spec.id === frozen.reqId
      && spec.path === frozen.specPath
      && spec.hash === frozen.specHash,
  );
  if (!exact) {
    throw new Error(`候选规格与冻结身份不一致: ${frozen.reqId} ${frozen.specPath}`);
  }
  return { [frozen.specPath]: body };
}

function readE2eSuiteFiles(e2eRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  const collect = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        collect(full, rel);
      } else if (entry.isFile()) {
        files[rel] = readFileSync(full, 'utf8');
      }
    }
  };
  collect(join(e2eRoot, 'tests', 'e2e'), 'tests/e2e');
  const config = join(e2eRoot, 'playwright.config.ts');
  if (existsSync(config)) files['playwright.config.ts'] = readFileSync(config, 'utf8');
  return files;
}

/** 将一次性读取的套件字节冻结到独立目录，实际运行以该副本为准，避免读取与运行之间的 TOCTOU。 */
function freezeSuiteFiles(files: Record<string, string>, suiteDir: string): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(suiteDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/**
 * 将受信 node_modules 以只读链接接到冻结套件目录，使 config/tests 里的裸导入
 * （如 `@playwright/test`）不依赖原 cwd，而统一从受信依赖目录解析，保持版本与 CLI 一致。
 */
function linkTrustedNodeModules(suiteDir: string, trustedNodeModules: string): void {
  const target = join(suiteDir, 'node_modules');
  if (existsSync(target)) return;
  if (!trustedNodeModules || !existsSync(trustedNodeModules)) {
    throw new Error(`fail-closed: 缺少受信 node_modules（${trustedNodeModules}），拒绝运行`);
  }
  symlinkSync(trustedNodeModules, target, 'dir');
}

/**
 * 一次性读取并冻结验收套件字节到独立目录，返回同一份字节与指纹，供实际运行与测试使用。
 *
 * 冻结副本位于 jobTmp 下、通常不在 repoRoot 祖先链内，因此：
 * 1) 显式写入 `package.json`（`type: module`），避免 config/tests 的 import/export 被按 CJS 解析；
 * 2) 用只读 `node_modules` 链接解析 `@playwright/test` 等受信依赖，不复制依赖、不依赖原 cwd。
 * `package.json` 与 `node_modules` 链接属于运行脚手架，不进入 suiteFingerprint（指纹只覆盖 config/tests/contracts 字节）。
 */
export function freezeE2eSuite(
  e2eRoot: string,
  suiteDir: string,
  trustedNodeModules?: string,
): { files: Record<string, string>; fingerprint: string } {
  const files = readE2eSuiteFiles(e2eRoot);
  freezeSuiteFiles(files, suiteDir);
  writeFileSync(
    join(suiteDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  linkTrustedNodeModules(suiteDir, trustedNodeModules ?? join(e2eRoot, 'node_modules'));
  return { files, fingerprint: computeE2eSuiteFingerprint(files) };
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath || mountPath === '/') return '/';
  let p = mountPath;
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  return p;
}

type ResolvedFile = { ok: true; filePath: string } | { ok: false; status: 403 | 404 };

function resolveArtifactFile(rootDir: string, relPath: string): ResolvedFile {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return { ok: false, status: 403 };
  }
  if (decoded.includes('\0')) return { ok: false, status: 403 };

  const root = normalize(rootDir);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return { ok: false, status: 403 };
  }

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(candidate);
  } catch {
    return { ok: false, status: 404 };
  }
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
    return { ok: false, status: 403 };
  }
  try {
    if (!statSync(realFile).isFile()) return { ok: false, status: 404 };
  } catch {
    return { ok: false, status: 404 };
  }
  return { ok: true, filePath: realFile };
}

export interface CandidateStaticServerOptions {
  artifactDir: string;
  mountPath: string;
}

/** 门禁专用静态服务：仅暴露单一候选 artifactDir，不提供 /releases/<otherSha>/ 兄弟目录路由。 */
export function createCandidateStaticServer(opts: CandidateStaticServerOptions): Server {
  const artifactDir = opts.artifactDir;
  const mountPath = normalizeMountPath(opts.mountPath);

  return createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (mountPath === '/') {
      const rel = pathname === '/' ? 'index.html' : pathname;
      const resolved = resolveArtifactFile(artifactDir, rel);
      if (!resolved.ok) {
        res.statusCode = resolved.status;
        res.end(resolved.status === 403 ? 'forbidden\n' : 'not found\n');
        return;
      }
      res.setHeader('Content-Type', CONTENT_TYPES[extname(resolved.filePath)] ?? 'application/octet-stream');
      createReadStream(resolved.filePath).pipe(res);
      return;
    }

    if (pathname !== mountPath && !pathname.startsWith(mountPath)) {
      res.statusCode = 404;
      res.end('not found\n');
      return;
    }
    const rel = pathname === mountPath ? 'index.html' : pathname.slice(mountPath.length);
    const resolved = resolveArtifactFile(artifactDir, rel);
    if (!resolved.ok) {
      res.statusCode = resolved.status;
      res.end(resolved.status === 403 ? 'forbidden\n' : 'not found\n');
      return;
    }
    res.setHeader('Content-Type', CONTENT_TYPES[extname(resolved.filePath)] ?? 'application/octet-stream');
    createReadStream(resolved.filePath).pipe(res);
  });
}

export function buildLoopbackPortRule(port: number): string {
  return `(allow network-outbound (remote tcp4 "localhost:${port}"))`;
}

export interface BrowserGateSandboxOptions {
  isolation: IsolationPaths;
  jobTmp: string;
  browserCacheDir: string;
  port: number;
  globalAgentDir: string;
  agentDir: string;
  /** 冻结套件副本目录（只读，不在可写 jobTmp/runDir 内）。 */
  suiteDir: string;
  /** 受信依赖目录（e2eRoot/node_modules），经 suiteDir/node_modules 只读链接解析。 */
  trustedNodeModules: string;
}

export function buildBrowserGateSandboxSpec(opts: BrowserGateSandboxOptions): SandboxProfileSpec {
  const sensitiveDenyDirs = [...opts.isolation.sensitiveDenyDirs];
  for (const dir of [opts.globalAgentDir, opts.agentDir]) {
    if (dir && existsSync(dir) && !sensitiveDenyDirs.includes(dir)) sensitiveDenyDirs.push(dir);
  }
  const allowReadDirs = [...opts.isolation.allowReadDirs];
  if (opts.browserCacheDir && existsSync(opts.browserCacheDir) && !allowReadDirs.includes(opts.browserCacheDir)) {
    allowReadDirs.push(opts.browserCacheDir);
  }
  // 冻结套件副本必须可读；写入仍被顶层 (deny file-write*) 拒绝，只有 runDir 可写。
  if (opts.suiteDir && existsSync(opts.suiteDir) && !allowReadDirs.includes(opts.suiteDir)) {
    allowReadDirs.push(opts.suiteDir);
  }
  // 只读链接指向的受信 node_modules 需可读，否则 sandbox 子进程无法解析 @playwright/test。
  if (opts.trustedNodeModules && existsSync(opts.trustedNodeModules) && !allowReadDirs.includes(opts.trustedNodeModules)) {
    allowReadDirs.push(opts.trustedNodeModules);
  }
  return {
    writableDirs: [opts.jobTmp],
    writableLiterals: ['/dev/null'],
    denyReadDirs: opts.isolation.denyReadDirs,
    denyReadLiterals: opts.isolation.denyReadLiterals,
    allowReadDirs,
    sensitiveDenyDirs,
    sensitiveDenyLiterals: opts.isolation.sensitiveDenyLiterals,
    denyNetwork: true,
    allowNetworkRules: [buildLoopbackPortRule(opts.port)],
  };
}

export const BROWSER_GATE_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'NO_COLOR'];

export interface BrowserGateEnvOptions {
  jobTmp: string;
  reportDir: string;
  baseUrl: string;
  version: string;
  browserCacheDir: string;
  video: 'retain-on-failure' | 'on';
  reqId?: string;
  specPath?: string;
  specHash?: string;
  dispatchRevision?: number;
  sourceMainSha?: string;
  candidateTreeSha?: string;
  jobId?: string;
}

export function buildBrowserGateEnv(opts: BrowserGateEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BROWSER_GATE_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = join(opts.jobTmp, 'home');
  env.TMPDIR = join(opts.jobTmp, 'tmp');
  env.CI = '1';
  env.SPEC_LOOP_E2E_BASE_URL = opts.baseUrl;
  env.SPEC_LOOP_E2E_VERSION = opts.version;
  env.SPEC_LOOP_E2E_REPORT_DIR = opts.reportDir;
  env.SPEC_LOOP_E2E_VIDEO = opts.video;
  env.PLAYWRIGHT_BROWSERS_PATH = opts.browserCacheDir;
  if (opts.reqId?.trim()) env.SPEC_LOOP_E2E_REQ_ID = opts.reqId.trim();
  if (opts.specPath?.trim()) env.SPEC_LOOP_E2E_SPEC_PATH = opts.specPath.trim();
  if (opts.specHash?.trim()) env.SPEC_LOOP_E2E_SPEC_HASH = opts.specHash.trim();
  if (opts.dispatchRevision !== undefined) {
    env.SPEC_LOOP_E2E_DISPATCH_REVISION = String(opts.dispatchRevision);
  }
  if (opts.sourceMainSha?.trim()) env.SPEC_LOOP_E2E_SOURCE_MAIN_SHA = opts.sourceMainSha.trim();
  if (opts.candidateTreeSha?.trim()) {
    env.SPEC_LOOP_E2E_CANDIDATE_TREE_SHA = opts.candidateTreeSha.trim();
  }
  if (opts.jobId?.trim()) env.SPEC_LOOP_E2E_JOB_ID = opts.jobId.trim();
  return env;
}

export interface BrowserGateRunnerOptions {
  cwd: string;
  env: Record<string, string>;
  cliArgs: string[];
  execBin: string;
  timeoutMs: number;
  spec: SandboxProfileSpec;
}

export interface BrowserGateRunnerResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type BrowserGateRunner = (opts: BrowserGateRunnerOptions) => Promise<BrowserGateRunnerResult>;

export function defaultBrowserGateRunner(): BrowserGateRunner {
  return async (opts) => {
    const bin = process.execPath;
    return runSandboxed(bin, opts.cliArgs, opts.spec, {
      cwd: opts.cwd,
      env: opts.env,
      execBin: opts.execBin,
      timeoutMs: opts.timeoutMs,
    });
  };
}

export interface BrowserGateOptions {
  repoDir: string;
  e2eRoot: string;
  artifactDir: string;
  mountPath: string;
  version: string;
  project: E2eProject;
  reqId?: string;
  specPath?: string;
  dispatchRevision?: number;
  specFiles: Record<string, string>;
  jobTmp: string;
  browserCacheDir: string;
  globalAgentDir?: string;
  agentDir?: string;
  logger: Logger;
  execBin?: string;
  timeoutMs?: number;
  runner?: BrowserGateRunner;
  testRunsRoot?: string;
  evidenceStage?: 'worker' | 'build' | 'manual';
  video?: 'retain-on-failure' | 'on';
  jobId?: string;
  sourceMainSha?: string;
  candidateTreeSha?: string;
  /** 仅允许未绑定产品的手动冒烟跳过产品绑定；不会生成本轮产品成功证据。 */
  unboundProductSmoke?: boolean;
  /** 面板调用方要求契约必须具有完整产品绑定；缺任一项 fail closed。 */
  requireProductBinding?: boolean;
}

export interface BrowserGateResult {
  ok: boolean;
  detail: string;
  reportDir: string;
  reportPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  receiptPath?: string;
  contract?: E2eContract;
  executedCaseIds?: string[];
  summary?: E2eReportSummary;
  suiteFingerprint?: string;
  specHash?: string;
  productBinding?: 'bound' | 'unbound-product-smoke';
  testRunRecord?: TestRunRecord | null;
}

export interface BrowserGateReceipt {
  schema: 1;
  kind: 'browser-gate-receipt';
  project: E2eProject;
  reqId?: string;
  specPath?: string;
  specHash?: string;
  dispatchRevision?: number;
  sourceMainSha?: string;
  candidateTreeSha?: string;
  jobId?: string;
  productBinding: 'bound' | 'unbound-product-smoke';
  displayVersion: string;
  suiteFingerprint?: string;
  node: string;
  platform: string;
  arch: string;
  ok: boolean;
  detail: string;
  reportDir: string;
  reportPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  executedCaseIds?: string[];
  startedAt: string;
  finishedAt: string;
}

async function listenOnEphemeralPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

function platformString(): string {
  return `${process.platform}/${process.arch}`;
}

function writeBrowserGateReceipt(
  path: string,
  receipt: Omit<BrowserGateReceipt, 'startedAt' | 'finishedAt' | 'node' | 'platform' | 'arch'>,
  startedAt: string,
): void {
  const finishedAt = new Date().toISOString();
  const full: BrowserGateReceipt = {
    ...receipt,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    startedAt,
    finishedAt,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
}

const ATTACHMENT_KIND_EXT: Record<TestArtifactKind, string> = {
  screenshot: '.png',
  video: '.webm',
  trace: '.zip',
  json: '.json',
};

export function artifactKindFor(contentType: string | undefined, sourcePath: string | undefined): TestArtifactKind | null {
  const ct = (contentType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  const kind =
    ct === 'video/webm'
      ? 'video'
      : ct === 'image/png'
        ? 'screenshot'
        : ct === 'application/zip' || ct === 'application/x-zip-compressed'
          ? 'trace'
          : ct === 'application/json' || ct === 'text/json'
            ? 'json'
            : null;
  if (kind) {
    const suffix = sourcePath ? extname(sourcePath).toLowerCase() : '';
    if (suffix && suffix !== ATTACHMENT_KIND_EXT[kind]) return null;
    return kind;
  }
  if (sourcePath) return artifactKindFromName(sourcePath);
  return null;
}

function attachmentDisplayName(kind: TestArtifactKind, source: string): string {
  const base = basename(source).trim();
  return base || `${kind}${ATTACHMENT_KIND_EXT[kind]}`;
}

function stringifyPlaywrightError(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim().slice(0, 800) || null;
  if (typeof value === 'object') {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 800);
  }
  return String(value).slice(0, 800);
}

function playwrightResultStatus(status: unknown): TestRunStatus {
  if (status === 'passed') return 'passed';
  if (status === 'failed' || status === 'timedOut' || status === 'interrupted') return 'failed';
  return 'unknown';
}

interface RawPlaywrightAttachment {
  kind: TestArtifactKind;
  contentType: string;
  source: string;
  name: string;
}

interface RawPlaywrightCase {
  id: string;
  title: string;
  status: TestRunStatus;
  durationMs: number | null;
  error: string | null;
  attachments: RawPlaywrightAttachment[];
}

function collectRawAttachments(value: unknown): RawPlaywrightAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: RawPlaywrightAttachment[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const source = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : null;
    const contentType = typeof record.contentType === 'string' ? record.contentType : undefined;
    const kind = artifactKindFor(contentType, source ?? undefined);
    if (!kind || !source) continue;
    attachments.push({ kind, contentType: contentType ?? '', source, name: attachmentDisplayName(kind, source) });
  }
  return attachments;
}

function collectRawPlaywrightCases(raw: unknown, project: E2eProject): RawPlaywrightCase[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).suites)) return [];
  const specs: RawSpec[] = [];
  collectSpecs((raw as Record<string, unknown>).suites, specs);
  const cases: RawPlaywrightCase[] = [];
  for (const spec of specs) {
    const title = typeof spec.title === 'string' ? spec.title.trim() : '';
    const caseId = extractCaseId(title) ?? 'unknown';
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    for (const testRaw of tests) {
      if (!testRaw || typeof testRaw !== 'object') continue;
      const test = testRaw as RawTest;
      if (test.projectName !== project) continue;
      const results = Array.isArray(test.results) ? test.results : [];
      for (const resultRaw of results) {
        if (!resultRaw || typeof resultRaw !== 'object') continue;
        const result = resultRaw as RawTestResult;
        cases.push({
          id: caseId,
          title,
          status: playwrightResultStatus(result.status),
          durationMs:
            typeof result.duration === 'number' && Number.isFinite(result.duration) ? result.duration : null,
          error: stringifyPlaywrightError(result.error),
          attachments: collectRawAttachments(result.attachments),
        });
      }
    }
  }
  return cases;
}

function isSafeAttachmentSource(root: string, source: string): boolean {
  let rootReal: string;
  let sourceReal: string;
  let stat: import('node:fs').Stats;
  try {
    rootReal = realpathSync(root);
    sourceReal = realpathSync(source);
    stat = lstatSync(source);
  } catch {
    return false;
  }
  if (sourceReal !== rootReal && !sourceReal.startsWith(`${rootReal}${sep}`)) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  return stat.size <= MAX_ATTACHMENT_BYTES;
}

export function materializeBrowserEvidence(opts: {
  raw: unknown;
  project: E2eProject;
  reportPath: string;
  reportDir: string;
  managedRunDir: string;
}): { cases: TestCaseSummary[]; runArtifacts: TestArtifactSummary[] } {
  const rawCases = collectRawPlaywrightCases(opts.raw, opts.project);
  const cases: TestCaseSummary[] = [];
  const runArtifacts: TestArtifactSummary[] = [];
  let totalBytes = 0;
  let artifactSeq = 0;
  const nextArtifactId = (): string =>
    `artifact-${Date.now().toString(36)}-${(++artifactSeq).toString(36)}-${randomBytes(4).toString('hex')}`;

  for (const rawCase of rawCases) {
    const caseArtifacts: TestArtifactSummary[] = [];
    for (const attachment of rawCase.attachments) {
      if (totalBytes >= MAX_RUN_ATTACHMENT_BYTES) break;
      let size = 0;
      try {
        if (!isSafeAttachmentSource(opts.reportDir, attachment.source)) continue;
        size = lstatSync(attachment.source).size;
      } catch {
        continue;
      }
      if (totalBytes + size > MAX_RUN_ATTACHMENT_BYTES) continue;
      const artifactId = nextArtifactId();
      try {
        copyFileSync(attachment.source, join(opts.managedRunDir, artifactId));
      } catch {
        continue;
      }
      totalBytes += size;
      caseArtifacts.push({ id: artifactId, kind: attachment.kind, name: attachment.name, href: '' });
    }
    cases.push({
      id: rawCase.id,
      title: rawCase.title,
      status: rawCase.status,
      durationMs: rawCase.durationMs,
      error: rawCase.error,
      artifacts: caseArtifacts,
    });
  }

  if (opts.raw && existsSync(opts.reportPath)) {
    try {
      if (isSafeAttachmentSource(opts.reportDir, opts.reportPath)) {
        const size = lstatSync(opts.reportPath).size;
        if (totalBytes + size <= MAX_RUN_ATTACHMENT_BYTES) {
          const artifactId = nextArtifactId();
          copyFileSync(opts.reportPath, join(opts.managedRunDir, artifactId));
          totalBytes += size;
          runArtifacts.push({ id: artifactId, kind: 'json', name: 'results.json', href: '' });
        }
      }
    } catch {
      // 原始报告附件复制失败不影响门禁结果，只影响面板下载。
    }
  }

  return { cases, runArtifacts };
}

function summaryFromPlaywright(raw: unknown, project: E2eProject): TestRunSummaryDetail {
  try {
    const parsed = summarizePlaywrightReport(raw, project);
    return {
      runner: 'playwright',
      specCount: parsed.specCount,
      targetTestCount: parsed.targetTestCount,
      resultCount: parsed.resultCount,
      skipped: parsed.skipped,
      flaky: parsed.flaky,
      unexpected: parsed.unexpected,
      errorCount: parsed.errorCount,
      failedResultCount: parsed.failedResultCount,
      retriedCount: parsed.retriedCount,
      unknown: false,
    };
  } catch {
    return {
      runner: 'playwright',
      specCount: null,
      targetTestCount: null,
      resultCount: null,
      skipped: null,
      flaky: null,
      unexpected: null,
      errorCount: null,
      failedResultCount: null,
      retriedCount: null,
      unknown: true,
    };
  }
}

function makeBrowserTestRunRecord(opts: {
  project: E2eProject;
  reqId?: string;
  specPath?: string;
  specHash?: string;
  dispatchRevision?: number;
  sourceMainSha?: string;
  candidateTreeSha?: string;
  jobId?: string;
  version: string;
  suiteFingerprint: string | null;
  ok: boolean;
  startedAt: string;
  reportPath: string;
  reportDir: string;
  testRunsRoot: string;
  stage: 'worker' | 'build' | 'manual';
}): TestRunRecord | null {
  const id = `browser-${opts.project}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const managedRunDir = join(opts.testRunsRoot, id);
  let raw: unknown = null;
  try {
    if (existsSync(opts.reportPath)) raw = readJsonFile(opts.reportPath);
  } catch {
    raw = null;
  }
  const summary = raw ? summaryFromPlaywright(raw, opts.project) : {
    runner: 'playwright',
    specCount: null,
    targetTestCount: null,
    resultCount: null,
    skipped: null,
    flaky: null,
    unexpected: null,
    errorCount: null,
    failedResultCount: null,
    retriedCount: null,
    unknown: true,
  } as const;
  mkdirSync(managedRunDir, { recursive: true });
  const materialized = materializeBrowserEvidence({
    raw,
    project: opts.project,
    reportPath: opts.reportPath,
    reportDir: opts.reportDir,
    managedRunDir,
  });
  return createManualTestRunRecord({
    id,
    stage: opts.stage,
    runner: 'playwright',
    version: opts.version,
    startedAt: opts.startedAt,
    finishedAt: new Date().toISOString(),
    jobId: opts.jobId ?? null,
    reqId: opts.reqId ?? null,
    specPath: opts.specPath ?? null,
    specHash: opts.specHash ?? null,
    dispatchRevision: opts.dispatchRevision ?? null,
    sourceMainSha: opts.sourceMainSha ?? null,
    candidateTreeSha: opts.candidateTreeSha ?? null,
    suiteFingerprint: opts.suiteFingerprint ?? null,
    ok: opts.ok,
    summary,
    cases: materialized.cases,
    artifacts: materialized.runArtifacts,
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function runBrowserGate(opts: BrowserGateOptions): Promise<BrowserGateResult> {
  const logger = opts.logger;
  const execBin = opts.execBin ?? sandboxExecBin();
  const timeoutMs = opts.timeoutMs ?? browserGateTimeoutMs();
  const jobTmp = resolveSeatbeltPath(opts.jobTmp);
  const e2eRoot = resolveSeatbeltPath(opts.e2eRoot);
  const artifactDir = resolveSeatbeltPath(opts.artifactDir);
  const browserCacheDir = resolveSeatbeltPath(opts.browserCacheDir);
  // 每次执行使用唯一子目录：避免误读历史 results.json，同时保留旧 attempt 证据（不 rm 父目录）。
  const runDir = join(jobTmp, `run-${Date.now()}-${++gateRunSeq}`);
  const suiteDir = join(jobTmp, `suite-${Date.now()}-${gateRunSeq}`);
  const reportDir = join(runDir, 'report');
  const stdoutLogPath = join(runDir, 'playwright.stdout.txt');
  const stderrLogPath = join(runDir, 'playwright.stderr.txt');
  const receiptPath = join(runDir, 'browser-gate-receipt.json');
  const startedAt = new Date().toISOString();
  const evidenceStage = opts.evidenceStage ?? 'manual';
  const testRunsRoot = opts.testRunsRoot;
  let evidenceReqId = opts.reqId;
  let evidenceSpecPath = opts.specPath;
  let productBinding: 'bound' | 'unbound-product-smoke' =
    opts.project === 'counter' ? 'bound' : 'unbound-product-smoke';
  const writeEvidence = (
    ok: boolean,
    reportPath = join(reportDir, 'results.json'),
    currentSuiteFingerprint = '',
    currentSpecHash: string | undefined = undefined,
  ): TestRunRecord | null => {
    if (!testRunsRoot) return null;
    const record = makeBrowserTestRunRecord({
      project: opts.project,
      reqId: evidenceReqId,
      specPath: evidenceSpecPath,
      specHash: currentSpecHash,
      dispatchRevision: opts.dispatchRevision,
      sourceMainSha: opts.sourceMainSha,
      candidateTreeSha: opts.candidateTreeSha,
      jobId: opts.jobId,
      version: opts.version,
      suiteFingerprint: currentSuiteFingerprint || null,
      ok,
      startedAt,
      reportPath,
      reportDir,
      testRunsRoot,
      stage: evidenceStage,
    });
    if (!record) return null;
    try {
      writeTestRunRecord(testRunsRoot, record);
      return record;
    } catch (error) {
      logger.warn(`写入 test-runs 记录失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const fail = (
    detail: string,
    extra: Partial<BrowserGateResult> = {},
  ): BrowserGateResult => ({
    ok: false,
    detail,
    reportDir,
    reportPath: join(reportDir, 'results.json'),
    stdoutLogPath,
    stderrLogPath,
    receiptPath,
    productBinding,
    ...extra,
  });

  if (opts.project === 'panel' && opts.unboundProductSmoke && opts.requireProductBinding) {
    const result = fail('unboundProductSmoke 与 requireProductBinding 不能同时启用');
    result.testRunRecord = writeEvidence(false);
    return result;
  }

  if (!sandboxExecAvailable(execBin)) {
    const result = fail(`fail-closed: sandbox-exec 不可用（${execBin}），拒绝无隔离浏览器验收`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'));
    return result;
  }
  if (!existsSync(browserCacheDir)) {
    const result = fail(`fail-closed: Playwright 浏览器缓存目录缺失（${browserCacheDir}），拒绝运行`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'));
    return result;
  }
  const cliPath = join(e2eRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cliPath)) {
    const result = fail(`fail-closed: 缺少 @playwright/test CLI（${cliPath}）`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'));
    return result;
  }

  // 一次性读取并冻结套件字节（config + tests/e2e，含 contracts）到唯一只读副本，
  // fingerprint 与后续实际加载完全来自同一份字节，避免读取与运行之间的 TOCTOU。
  const trustedNodeModules = join(e2eRoot, 'node_modules');
  let suiteFiles: Record<string, string>;
  let suiteFingerprint: string;
  try {
    const frozen = freezeE2eSuite(e2eRoot, suiteDir, trustedNodeModules);
    suiteFiles = frozen.files;
    suiteFingerprint = frozen.fingerprint;
  } catch (error) {
    const result = fail(`fail-closed: 冻结验收套件失败: ${error instanceof Error ? error.message : String(error)}`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'));
    return result;
  }
  if (suiteFiles['playwright.config.ts'] === undefined) {
    const result = fail(`fail-closed: 缺少 playwright.config.ts（${join(e2eRoot, 'playwright.config.ts')}）`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'));
    return result;
  }

  const contractRel = `tests/e2e/contracts/${opts.project}.json`;
  const contractRaw = suiteFiles[contractRel];
  if (contractRaw === undefined) {
    const result = fail(`fail-closed: 缺少验收契约（${contractRel}）`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint);
    return result;
  }
  let contract: E2eContract;
  try {
    contract = parseE2eContract(JSON.parse(contractRaw) as unknown, opts.project);
  } catch (error) {
    const result = fail(`验收契约解析失败: ${error instanceof Error ? error.message : String(error)}`);
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint);
    return result;
  }

  let specHash: string | undefined;
  const contractBound = Boolean(contract.reqId && contract.specPath && contract.specHash);
  const versionBound = opts.project === 'counter'
    || (contractBound && !opts.unboundProductSmoke);
  productBinding = versionBound ? 'bound' : 'unbound-product-smoke';
  if (opts.project === 'panel' && opts.requireProductBinding && !versionBound) {
    const result = fail('panel 产品门禁要求完整 reqId/specPath/specHash 契约绑定', {
      contract,
    });
    result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint);
    return result;
  }
  if (versionBound) {
    if (opts.reqId && contract.reqId && opts.reqId !== contract.reqId) {
      const result = fail(`门禁 reqId ${opts.reqId} 与契约 ${contract.reqId} 不一致`, {
        contract,
      });
      result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint);
      return result;
    }
    if (opts.specPath && contract.specPath && opts.specPath !== contract.specPath) {
      const result = fail(`门禁 specPath ${opts.specPath} 与契约 ${contract.specPath} 不一致`, {
        contract,
      });
      result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint);
      return result;
    }
    evidenceReqId = opts.reqId ?? contract.reqId;
    evidenceSpecPath = opts.specPath ?? contract.specPath;
  } else {
    evidenceReqId = undefined;
    evidenceSpecPath = undefined;
  }
  if (versionBound) {
    const check = verifyCounterContract(contract, opts.specFiles, opts.reqId);
    if (!check.ok) {
      specHash = check.specHash;
      const result = fail(`验收基线待独立维护：${check.detail}`, { contract, specHash: check.specHash });
      result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint, specHash);
      return result;
    }
    specHash = check.specHash;
  }
  if (
    opts.project === 'panel'
    && (versionBound || evidenceStage === 'worker' || evidenceStage === 'build')
  ) {
    const acceptance = contract.acceptanceCases;
    if (!acceptance || Object.keys(acceptance).length === 0) {
      const result = fail('panel 业务门禁缺少 acceptanceCases 验收映射，仅冒烟不得产生产品成功', {
        contract,
        specHash,
      });
      result.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint, specHash);
      return result;
    }
    const coverage = verifyPanelAcceptanceCoverage(contract, opts.specFiles, opts.reqId);
    if (!coverage.ok) {
      const result = fail(`panel 验收映射不完整：${coverage.detail}`, {
        contract,
        specHash: coverage.specHash || specHash,
      });
      result.testRunRecord = writeEvidence(
        false,
        join(reportDir, 'results.json'),
        suiteFingerprint,
        coverage.specHash || specHash,
      );
      return result;
    }
  }

  const receiptIdentity = (currentSpecHash: string | undefined) => ({
    reqId: productBinding === 'bound' ? evidenceReqId : undefined,
    specPath: productBinding === 'bound' ? evidenceSpecPath : undefined,
    specHash: productBinding === 'bound' ? currentSpecHash : undefined,
    dispatchRevision: opts.dispatchRevision,
    sourceMainSha: opts.sourceMainSha,
    candidateTreeSha: opts.candidateTreeSha,
    jobId: opts.jobId,
    productBinding,
  });

  const server = createCandidateStaticServer({ artifactDir, mountPath: opts.mountPath });
  let port = 0;
  try {
    port = await listenOnEphemeralPort(server);
    const baseUrl = `http://127.0.0.1:${port}${opts.mountPath === '/' ? '/' : normalizeMountPath(opts.mountPath)}`;

    mkdirSync(join(runDir, 'home'), { recursive: true });
    mkdirSync(join(runDir, 'tmp'), { recursive: true });
    mkdirSync(reportDir, { recursive: true });

    const isolation = buildIsolationPaths(resolveSeatbeltPath(opts.repoDir));
    const spec = buildBrowserGateSandboxSpec({
      isolation,
      jobTmp: runDir,
      browserCacheDir,
      port,
      globalAgentDir: opts.globalAgentDir ?? '',
      agentDir: opts.agentDir ?? '',
      suiteDir,
      trustedNodeModules,
    });
    const env = buildBrowserGateEnv({
      jobTmp: runDir,
      reportDir,
      baseUrl,
      version: opts.version,
      browserCacheDir,
      video: opts.video ?? 'retain-on-failure',
      reqId: productBinding === 'bound' ? evidenceReqId : undefined,
      specPath: productBinding === 'bound' ? evidenceSpecPath : undefined,
      specHash: productBinding === 'bound' ? specHash : undefined,
      dispatchRevision: opts.dispatchRevision,
      sourceMainSha: opts.sourceMainSha,
      candidateTreeSha: opts.candidateTreeSha,
      jobId: opts.jobId,
    });

    const runner = opts.runner ?? defaultBrowserGateRunner();
    const result = await runner({
      cwd: suiteDir,
      env,
      cliArgs: [cliPath, 'test', '--project', opts.project, '--config', join(suiteDir, 'playwright.config.ts')],
      execBin,
      timeoutMs,
      spec,
    });

    writeFileSync(stdoutLogPath, result.stdout, 'utf8');
    writeFileSync(stderrLogPath, result.stderr, 'utf8');

    if (result.timedOut) {
      writeBrowserGateReceipt(
        receiptPath,
        {
          schema: 1,
          kind: 'browser-gate-receipt',
          project: opts.project,
          ...receiptIdentity(specHash),
          displayVersion: opts.version,
          suiteFingerprint,
          ok: false,
          detail: `浏览器验收超时（${timeoutMs}ms）`,
          reportDir,
          reportPath: join(reportDir, 'results.json'),
          stdoutLogPath,
          stderrLogPath,
        },
        startedAt,
      );
      const gateResult = fail(`浏览器验收超时（${timeoutMs}ms）`, { contract, specHash, suiteFingerprint });
      gateResult.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint, specHash);
      return gateResult;
    }
    if (result.code !== 0) {
      const tail = (result.stderr || result.stdout || '').trim().slice(-500);
      const detail = `Playwright 退出码 ${result.code}；报告目录 ${reportDir}；stdout ${stdoutLogPath}；stderr ${stderrLogPath}${tail ? `；尾部：${tail}` : ''}`;
      writeBrowserGateReceipt(
        receiptPath,
        {
          schema: 1,
          kind: 'browser-gate-receipt',
          project: opts.project,
          ...receiptIdentity(specHash),
          displayVersion: opts.version,
          suiteFingerprint,
          ok: false,
          detail,
          reportDir,
          reportPath: join(reportDir, 'results.json'),
          stdoutLogPath,
          stderrLogPath,
        },
        startedAt,
      );
      const gateResult = fail(
        detail,
        { contract, specHash, suiteFingerprint },
      );
      gateResult.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint, specHash);
      return gateResult;
    }

    const reportPath = join(reportDir, 'results.json');
    if (!existsSync(reportPath)) {
      writeBrowserGateReceipt(
        receiptPath,
        {
          schema: 1,
          kind: 'browser-gate-receipt',
          project: opts.project,
          ...receiptIdentity(specHash),
          displayVersion: opts.version,
          suiteFingerprint,
          ok: false,
          detail: '缺少 Playwright JSON 报告（results.json）',
          reportDir,
          reportPath,
          stdoutLogPath,
          stderrLogPath,
        },
        startedAt,
      );
      const gateResult = fail('缺少 Playwright JSON 报告（results.json）', { contract, specHash, suiteFingerprint });
      gateResult.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint, specHash);
      return gateResult;
    }

    let summary: E2eReportSummary;
    try {
      summary = summarizePlaywrightReport(readJsonFile(reportPath), opts.project);
    } catch (error) {
      const detail = `Playwright 报告解析失败: ${error instanceof Error ? error.message : String(error)}`;
      writeBrowserGateReceipt(
        receiptPath,
        {
          schema: 1,
          kind: 'browser-gate-receipt',
          project: opts.project,
          ...receiptIdentity(specHash),
          displayVersion: opts.version,
          suiteFingerprint,
          ok: false,
          detail,
          reportDir,
          reportPath,
          stdoutLogPath,
          stderrLogPath,
        },
        startedAt,
      );
      const gateResult = fail(detail, {
        contract,
        specHash,
        suiteFingerprint,
      });
      gateResult.testRunRecord = writeEvidence(false, reportPath, suiteFingerprint, specHash);
      return gateResult;
    }

    const validation = validateE2eReport(summary, contract.caseIds);
    if (!validation.ok) {
      writeBrowserGateReceipt(
        receiptPath,
        {
          schema: 1,
          kind: 'browser-gate-receipt',
          project: opts.project,
          ...receiptIdentity(specHash),
          displayVersion: opts.version,
          suiteFingerprint,
          ok: false,
          detail: validation.detail,
          reportDir,
          reportPath,
          stdoutLogPath,
          stderrLogPath,
          executedCaseIds: summary.caseIds,
        },
        startedAt,
      );
      const gateResult = fail(validation.detail, {
        contract,
        summary,
        executedCaseIds: summary.caseIds,
        specHash,
        suiteFingerprint,
      });
      gateResult.testRunRecord = writeEvidence(false, reportPath, suiteFingerprint, specHash);
      return gateResult;
    }

    writeBrowserGateReceipt(
      receiptPath,
      {
        schema: 1,
        kind: 'browser-gate-receipt',
        project: opts.project,
        ...receiptIdentity(specHash),
        displayVersion: opts.version,
        suiteFingerprint,
        ok: true,
        detail: '浏览器验收通过',
        reportDir,
        reportPath,
        stdoutLogPath,
        stderrLogPath,
        executedCaseIds: summary.caseIds,
      },
      startedAt,
    );

    logger.info(
      `浏览器验收通过：${opts.project} ${summary.specCount} 用例，指纹 ${suiteFingerprint.slice(0, 12)}，报告 ${reportDir}`,
    );
    const gateResult: BrowserGateResult = {
      ok: true,
      detail: '浏览器验收通过',
      reportDir,
      reportPath,
      stdoutLogPath,
      stderrLogPath,
      receiptPath,
      contract,
      executedCaseIds: summary.caseIds,
      summary,
      suiteFingerprint,
      specHash,
      productBinding,
    };
    gateResult.testRunRecord = writeEvidence(true, reportPath, suiteFingerprint, specHash);
    return gateResult;
  } catch (error) {
    const detail = `浏览器验收异常: ${error instanceof Error ? error.message : String(error)}`;
    try {
      writeBrowserGateReceipt(
        receiptPath,
        {
          schema: 1,
          kind: 'browser-gate-receipt',
          project: opts.project,
          ...receiptIdentity(specHash),
          displayVersion: opts.version,
          suiteFingerprint,
          ok: false,
          detail,
          reportDir,
          reportPath: join(reportDir, 'results.json'),
          stdoutLogPath,
          stderrLogPath,
        },
        startedAt,
      );
    } catch {
      // 诊断回执失败不改变原错误。
    }
    const gateResult = fail(detail, {
      contract,
      specHash,
      suiteFingerprint,
    });
    gateResult.testRunRecord = writeEvidence(false, join(reportDir, 'results.json'), suiteFingerprint, specHash);
    return gateResult;
  } finally {
    await closeServer(server);
  }
}
