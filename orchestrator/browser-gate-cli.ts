import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveBrowserCacheDir,
  resolveSeatbeltPath,
  runBrowserGate,
  readSpecFilesFromDir,
  type E2eProject,
} from './browser-gate.ts';
import { createLogger } from './log.ts';

function readBuiltVersion(artifactDir: string, fallback: string): string {
  const p = join(artifactDir, 'version.json');
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.trim()) return raw.version.trim();
    } catch {
      // fall through to fallback
    }
  }
  return fallback;
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
  const video = args.includes('--record') ? 'on' : 'retain-on-failure';
  const project: E2eProject = rawProject;
  const repoDir = process.cwd();
  const logger = createLogger('BROWSER-GATE');
  const artifactDir = project === 'counter' ? join(repoDir, 'dist') : join(repoDir, '.orchestrator', 'panel-dist');

  if (!existsSync(join(artifactDir, 'index.html'))) {
    logger.error(`未找到已构建产物 ${artifactDir}，请先运行 ${project === 'counter' ? 'npm run build' : 'npm run build:panel'}`);
    process.exitCode = 1;
    return;
  }

  const version =
    project === 'counter'
      ? readBuiltVersion(artifactDir, process.env.SPEC_LOOP_VERSION?.trim() || 'dev')
      : process.env.SPEC_LOOP_E2E_VERSION?.trim() || 'panel';

  const jobTmp = mkdtempSync(resolveSeatbeltPath(join(tmpdir(), 'spec-loop-e2e-')));
  const result = await runBrowserGate({
    repoDir,
    e2eRoot: repoDir,
    artifactDir,
    mountPath: '/',
    version,
    project,
    specFiles: readSpecFilesFromDir(repoDir),
    jobTmp,
    browserCacheDir: resolveBrowserCacheDir(),
    logger,
    testRunsRoot: join(repoDir, '.orchestrator', 'test-runs'),
    evidenceStage: 'manual',
    video,
  });

  if (result.ok) {
    logger.info(`浏览器验收通过（${project}），报告 ${result.reportDir}`);
    process.exitCode = 0;
  } else {
    logger.error(`浏览器验收失败（${project}）：${result.detail}`);
    logger.error(`诊断证据：报告目录 ${result.reportDir}`);
    logger.error(`诊断证据：stdout ${result.stdoutLogPath}`);
    logger.error(`诊断证据：stderr ${result.stderrLogPath}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
