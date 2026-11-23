import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  resolveBrowserCacheDir,
  resolveSeatbeltPath,
  runBrowserGate,
  readSpecFilesFromDir,
  type BrowserGateOptions,
  type BrowserGateResult,
  type BrowserGateRunner,
  type E2eProject,
} from './browser-gate.ts';
import { PANEL_REQ_ID, PANEL_SPEC_PATH } from './delivery-profile.ts';
import { GitClient } from './git.ts';
import { createLogger, type Logger } from './log.ts';
import { parseSpecs } from './specs.ts';

const SHA_RE = /^[0-9a-f]{40}$/;

function readOptionalRegularFile(path: string, label: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`无法读取${label}（${path}）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label}不得是符号链接: ${path}`);
  if (!stat.isFile()) throw new Error(`${label}必须是普通文件: ${path}`);
  return readFileSync(path, 'utf8');
}

function parseVersionManifest(raw: string, path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`面板产物 version.json 不是有效 JSON（${path}）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`面板产物 version.json 必须是 JSON 对象（${path}）`);
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`面板产物 version.json 缺少非空 version（${path}）`);
  }
  const normalized = version.trim();
  if (normalized.length > 200) throw new Error('面板产物 version 过长，拒绝读取');
  return normalized;
}

/** 读取面板构建产物的真实版本清单；缺失、坏 JSON、空版本或符号链接都 fail closed。 */
export function readPanelArtifactVersion(artifactDir: string): string {
  const path = join(artifactDir, 'version.json');
  const raw = readOptionalRegularFile(path, '面板产物 version.json');
  if (raw === undefined) throw new Error(`面板产物缺少 version.json: ${path}`);
  return parseVersionManifest(raw, path);
}

function readCounterArtifactVersion(artifactDir: string, env: NodeJS.ProcessEnv): string {
  const path = join(artifactDir, 'version.json');
  const raw = readOptionalRegularFile(path, '计数器产物 version.json');
  if (raw === undefined) return env.SPEC_LOOP_VERSION?.trim() || 'dev';
  return parseVersionManifest(raw, path);
}

function assertArtifact(artifactDir: string, project: E2eProject, env: NodeJS.ProcessEnv): void {
  let stat;
  try {
    stat = lstatSync(artifactDir);
  } catch (error) {
    throw new Error(`未找到构建产物 ${artifactDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`构建产物目录不得是符号链接: ${artifactDir}`);
  if (!stat.isDirectory()) throw new Error(`构建产物必须是目录: ${artifactDir}`);
  const indexPath = join(artifactDir, 'index.html');
  let index;
  try {
    index = lstatSync(indexPath);
  } catch (error) {
    throw new Error(`未找到已构建产物 ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (index.isSymbolicLink() || !index.isFile()) {
    throw new Error(`构建产物 index.html 必须是普通文件: ${indexPath}`);
  }
  if (project === 'counter') readCounterArtifactVersion(artifactDir, env);
}

function resolveArtifactDir(repoDir: string, project: E2eProject, env: NodeJS.ProcessEnv): string {
  const configured = env.SPEC_LOOP_OUT_DIR?.trim();
  if (configured) return isAbsolute(configured) ? resolve(configured) : resolve(repoDir, configured);
  return project === 'counter'
    ? join(repoDir, 'dist')
    : join(repoDir, '.orchestrator', 'panel-dist');
}

function assertNoSymlinkPath(rootDir: string, relPath: string, label: string): void {
  const parts = relPath.split('/');
  let cursor = rootDir;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]!);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`无法读取${label}（${cursor}）: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label}路径不得包含符号链接: ${cursor}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label}路径父级不是目录: ${cursor}`);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(`${label}必须是普通文件: ${cursor}`);
    }
  }
}

interface PanelArchiveSpec {
  specFiles: Record<string, string>;
  specHash?: string;
  archiveDir?: string;
  productBinding: 'bound' | 'unbound-product-smoke';
}

type PanelArchiveGit = Pick<GitClient, 'hasCommit' | 'archive'>;

async function resolvePanelArchiveSpec(input: {
  repoDir: string;
  version: string;
  jobTmp: string;
  git: PanelArchiveGit;
}): Promise<PanelArchiveSpec> {
  if (!SHA_RE.test(input.version)) {
    return { specFiles: {}, productBinding: 'unbound-product-smoke' };
  }
  if (!(await input.git.hasCommit(input.repoDir, input.version))) {
    // 构建产物可能来自当前工作树未包含的历史提交。保留真实展示版本并执行
    // 未绑定产品冒烟，不伪造规格、版本或业务成功证据。
    return { specFiles: {}, productBinding: 'unbound-product-smoke' };
  }
  const archiveDir = join(input.jobTmp, `panel-archive-${input.version}`);
  rmSync(archiveDir, { recursive: true, force: true });
  await input.git.archive(input.repoDir, input.version, archiveDir);
  assertNoSymlinkPath(archiveDir, PANEL_SPEC_PATH, '面板归档规格');
  const archivedPath = join(archiveDir, ...PANEL_SPEC_PATH.split('/'));
  let stat;
  try {
    stat = lstatSync(archivedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { specFiles: {}, archiveDir, productBinding: 'unbound-product-smoke' };
    }
    throw new Error(`无法读取面板归档规格（${archivedPath}）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`面板归档规格必须是普通文件: ${archivedPath}`);
  }
  const body = readFileSync(archivedPath, 'utf8');
  const parsed = parseSpecs({ [PANEL_SPEC_PATH]: body });
  if (parsed.errors.length > 0) {
    throw new Error(`面板归档规格解析失败: ${parsed.errors[0]?.reason ?? '未知错误'}`);
  }
  const spec = parsed.specs.find(
    (candidate) => candidate.id === PANEL_REQ_ID && candidate.path === PANEL_SPEC_PATH,
  );
  if (!spec) throw new Error(`面板归档缺少 ${PANEL_REQ_ID} @ ${PANEL_SPEC_PATH}`);
  return {
    specFiles: { [PANEL_SPEC_PATH]: body },
    specHash: spec.hash,
    archiveDir,
    productBinding: 'bound',
  };
}

export interface BrowserGateCliPlan {
  project: E2eProject;
  repoDir: string;
  e2eRoot: string;
  artifactDir: string;
  version: string;
  specFiles: Record<string, string>;
  specHash?: string;
  productBinding: 'bound' | 'unbound-product-smoke';
  jobTmp: string;
  browserCacheDir: string;
  testRunsRoot: string;
  jobId: string;
  archiveDir?: string;
  video: 'retain-on-failure' | 'on';
}

export interface BrowserGateCliOptions {
  repoDir?: string;
  e2eRoot?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  runner?: BrowserGateRunner;
  git?: PanelArchiveGit;
  jobTmp?: string;
  jobTmpRoot?: string;
  browserCacheDir?: string;
  testRunsRoot?: string;
  evidenceJobId?: string;
  execBin?: string;
  timeoutMs?: number;
  /** 测试注入点，生产调用固定使用真实 runBrowserGate。 */
  gateRunner?: (options: BrowserGateOptions) => Promise<BrowserGateResult>;
}

export async function resolveBrowserGateCliPlan(
  project: E2eProject,
  options: BrowserGateCliOptions = {},
  video: 'retain-on-failure' | 'on' = 'retain-on-failure',
): Promise<BrowserGateCliPlan> {
  const env = options.env ?? process.env;
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const artifactDir = resolveArtifactDir(repoDir, project, env);
  assertArtifact(artifactDir, project, env);
  const jobTmp = options.jobTmp
    ? resolveSeatbeltPath(options.jobTmp)
    : mkdtempSync(resolveSeatbeltPath(join(options.jobTmpRoot ?? tmpdir(), 'spec-loop-e2e-')));
  mkdirSync(jobTmp, { recursive: true });
  const jobId = options.evidenceJobId?.trim()
    || env.SPEC_LOOP_JOB_ID?.trim()
    || `manual-${project}-${Date.now()}-${process.pid}`;

  if (project === 'counter') {
    return {
      project,
      repoDir,
      e2eRoot: resolve(options.e2eRoot ?? repoDir),
      artifactDir,
      version: readCounterArtifactVersion(artifactDir, env),
      specFiles: readSpecFilesFromDir(repoDir),
      productBinding: 'bound',
      jobTmp,
      browserCacheDir: options.browserCacheDir ?? resolveBrowserCacheDir(env),
      testRunsRoot: options.testRunsRoot ?? join(repoDir, '.orchestrator', 'test-runs'),
      jobId,
      video,
    };
  }

  const version = readPanelArtifactVersion(artifactDir);
  const archived = await resolvePanelArchiveSpec({
    repoDir,
    version,
    jobTmp,
    git: options.git ?? new GitClient(),
  });
  return {
    project,
    repoDir,
    e2eRoot: resolve(options.e2eRoot ?? repoDir),
    artifactDir,
    version,
    specFiles: archived.specFiles,
    ...(archived.specHash ? { specHash: archived.specHash } : {}),
    productBinding: archived.productBinding,
    jobTmp,
    browserCacheDir: options.browserCacheDir ?? resolveBrowserCacheDir(env),
    testRunsRoot: options.testRunsRoot ?? join(repoDir, '.orchestrator', 'test-runs'),
    jobId,
    ...(archived.archiveDir ? { archiveDir: archived.archiveDir } : {}),
    video,
  };
}

export async function runBrowserGateCli(
  project: E2eProject,
  options: BrowserGateCliOptions = {},
  video: 'retain-on-failure' | 'on' = 'retain-on-failure',
): Promise<BrowserGateResult> {
  const plan = await resolveBrowserGateCliPlan(project, options, video);
  const executeGate = options.gateRunner ?? runBrowserGate;
  try {
    return await executeGate({
      repoDir: plan.repoDir,
      e2eRoot: plan.e2eRoot,
      artifactDir: plan.artifactDir,
      mountPath: '/',
      version: plan.version,
      project: plan.project,
      ...(plan.project === 'panel' && plan.productBinding === 'bound'
        ? { reqId: PANEL_REQ_ID, specPath: PANEL_SPEC_PATH }
        : {}),
      specFiles: plan.specFiles,
      jobTmp: plan.jobTmp,
      browserCacheDir: plan.browserCacheDir,
      logger: options.logger ?? createLogger('BROWSER-GATE'),
      execBin: options.execBin,
      timeoutMs: options.timeoutMs,
      runner: options.runner,
      testRunsRoot: plan.testRunsRoot,
      evidenceStage: 'manual',
      video: plan.video,
      jobId: plan.jobId,
      ...(plan.project === 'panel'
        ? plan.productBinding === 'bound'
          ? { requireProductBinding: true }
          : { unboundProductSmoke: true }
        : {}),
    });
  } finally {
    if (plan.archiveDir) rmSync(plan.archiveDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const rawProject = process.argv[2] ?? '';
  if (rawProject !== 'counter' && rawProject !== 'panel') {
    console.error('用法: node orchestrator/browser-gate-cli.ts <counter|panel> [--record]');
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(3);
  if (args.some((arg) => arg !== '--record')) {
    console.error('未知参数：仅支持 --record（成功保留录屏）');
    process.exitCode = 2;
    return;
  }
  const logger = createLogger('BROWSER-GATE');
  const result = await runBrowserGateCli(
    rawProject,
    { logger },
    args.includes('--record') ? 'on' : 'retain-on-failure',
  );

  if (result.ok) {
    if (rawProject === 'panel' && result.productBinding === 'unbound-product-smoke') {
      logger.info(`未绑定产品的手动冒烟通过（面板），报告 ${result.reportDir}`);
    } else {
      logger.info(`浏览器验收通过（${rawProject}），报告 ${result.reportDir}`);
    }
    process.exitCode = 0;
  } else {
    logger.error(`浏览器验收失败（${rawProject}）：${result.detail}`);
    logger.error(`诊断证据：报告目录 ${result.reportDir}`);
    logger.error(`诊断证据：stdout ${result.stdoutLogPath}`);
    logger.error(`诊断证据：stderr ${result.stderrLogPath}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
