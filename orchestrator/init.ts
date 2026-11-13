import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config.ts';
import { GitClient } from './git.ts';
import { GithubClient, type GhRunner } from './github.ts';
import { acquireInstanceLock } from './lock.ts';
import { createLogger } from './log.ts';
import { resolvePiBin } from './pi-runner.ts';
import { createBuild, resolveRepoFromOrigin, verifyReleaseOverHttp } from './runtime.ts';
import { probeSandbox } from './sandbox.ts';
import { STATUS_LABELS } from './scheduler.ts';
import { parseSpecs } from './specs.ts';
import { StateStore } from './state.ts';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = Number.parseInt(process.env.SPEC_LOOP_GH_TIMEOUT_MS ?? '120000', 10);

/** 带界的 gh runner：直接给 execFile timeout，超时会终止子进程，避免初始化卡住实例锁。 */
const boundedGhRunner: GhRunner = async (args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      env: { ...process.env, ...(opts?.env ?? {}) },
      maxBuffer: 64 * 1024 * 1024,
      timeout: GH_TIMEOUT_MS,
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { code?: number; stderr?: string; stdout?: string };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
};

function nodeVersionAtLeast(required: string): boolean {
  const [major, minor] = required.split('.').map((n) => Number.parseInt(n, 10));
  const parts = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  const currentMajor = parts[0] ?? 0;
  const currentMinor = parts[1] ?? 0;
  if (currentMajor !== major) return currentMajor > major;
  return currentMinor >= (minor ?? 0);
}

interface Precheck {
  ok: boolean;
  detail: string;
}

async function checkGhAuth(): Promise<Precheck> {
  const res = await boundedGhRunner(['auth', 'status']);
  if (res.code !== 0) {
    return { ok: false, detail: `gh 未登录或认证失败: ${res.stderr.trim()}` };
  }
  return { ok: true, detail: 'gh 已登录' };
}

async function checkPi(repoDir: string): Promise<Precheck> {
  const bin = resolvePiBin(repoDir);
  try {
    const { stdout } = await execFileAsync(bin, ['--version']);
    return { ok: true, detail: `pi 可用: ${stdout.trim()}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `pi 调用失败（${bin}）: ${detail}` };
  }
}

async function checkSandbox(repoDir: string): Promise<Precheck> {
  const jobRoot = join(repoDir, '.orchestrator', 'probe');
  const sensitive = [
    process.env.HOME ? join(process.env.HOME, '.config', 'gh') : '',
    process.env.SPEC_LOOP_ENV_FILE ?? '',
  ].filter((p): p is string => p.length > 0);
  const result = await probeSandbox({ jobRoot, sensitivePaths: sensitive });
  return { ok: result.ok, detail: result.detail };
}

export function checkFeishu(enabled: boolean, appId?: string, appSecret?: string, chatId?: string): Precheck {
  if (!enabled) return { ok: true, detail: '飞书未启用' };
  const missing: string[] = [];
  if (!appId) missing.push('FEISHU_APP_ID');
  if (!appSecret) missing.push('FEISHU_APP_SECRET');
  if (!chatId) missing.push('FEISHU_CHAT_ID');
  if (missing.length > 0) return { ok: false, detail: `飞书已启用但缺少: ${missing.join('、')}` };
  return { ok: true, detail: '飞书配置完整' };
}

export type InitGuardResult = 'ok' | 'precheck-failed' | 'repo-mismatch';

/**
 * init 前置守卫：任一预检缺项即拒绝；预检通过后再校验仓库绑定是否与既有 state 一致。
 * 命中拒绝时调用方必须在任何 labels/baseline/publish 之前直接返回，保证旧 state 字节不被污染。
 */
export function initGuardDecision(
  allOk: boolean,
  existingRepo: string | null | undefined,
  repo: string | null | undefined,
): InitGuardResult {
  if (!allOk) return 'precheck-failed';
  if (repo && existingRepo && existingRepo !== repo) return 'repo-mismatch';
  return 'ok';
}

/**
 * 幂等记录当前远端 main 为需求基线：首次成功时写入游标与真实 docs 快照，
 * 并持久化绑定仓库（用于 status 展示与跨仓状态复用校验）。失败返回 false，
 * 不再静默吞掉让 init 误报成功。
 */
export async function recordBaseline(
  config: Config,
  git: GitClient,
  repoDir: string,
  repo: string,
  state: StateStore,
  logger: Logger,
): Promise<boolean> {
  try {
    await git.fetch(repoDir, config.mainBranch);
    const sha = await git.revParse(repoDir, `origin/${config.mainBranch}`);
    // 单次 state 更新：首次记录游标 + 幂等持久化绑定仓库，避免多实例各自 load 互相覆盖。
    await state.update((s) => {
      if (!s.cursorMainSha) s.cursorMainSha = sha;
      if (s.repo !== repo) s.repo = repo;
      return undefined;
    });
    logger.info(`已记录需求基线游标: ${sha}`);

    const baselineFile = join(config.runDir, 'baseline.json');
    if (!existsSync(baselineFile)) {
      const files = await git.readSpecSnapshot(repoDir, `origin/${config.mainBranch}`);
      const parsed = parseSpecs(files);
      const specs = parsed.specs.map((s) => ({ id: s.id, path: s.path, hash: s.hash }));
      mkdirSync(config.runDir, { recursive: true });
      writeFileSync(
        baselineFile,
        JSON.stringify({ mainSha: sha, specs, recordedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      logger.info(`已记录需求基线快照: ${baselineFile}`);
    }
    return true;
  } catch (error) {
    logger.warn(`基线记录失败（可稍后重试）: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 首次 init 且尚无 activeSha 时，用固定 origin/main 源码做一次沙箱构建 + 真实 HTTP
 * 健康检查，成功后写入预览指针。只发布基线、不创建 Issue、不标记任何任务 done；
 * 任一步失败返回 false 并计入 init 失败，避免“报成功却 503 / 推进不完整基线”。
 */
export async function publishBaselinePreview(
  config: Config,
  git: GitClient,
  state: StateStore,
  logger: Logger,
): Promise<boolean> {
  try {
    if (state.snapshot().deploy.activeSha) return true;
    const sha = await git.revParse(config.repoDir, `origin/${config.mainBranch}`);
    const build = createBuild(config, git);
    const built = await build(sha);
    if (!built.ok) {
      logger.warn(`基线构建失败: ${built.detail}`);
      return false;
    }
    const healthy = await verifyReleaseOverHttp(join(config.runDir, 'releases', sha), sha);
    if (!healthy) {
      logger.warn('基线健康检查失败');
      return false;
    }
    await state.update((s) => {
      s.deploy.activeSha = sha;
      s.deploy.releaseDir = join(config.runDir, 'releases', sha);
      return undefined;
    });
    logger.info(`已发布基线预览: ${sha}`);
    return true;
  } catch (error) {
    logger.warn(`基线发布失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('INIT');
  const git = new GitClient();
  const repo = config.repo ?? (await resolveRepoFromOrigin(git, config.repoDir));

  const lock = acquireInstanceLock(join(config.runDir, 'daemon.lock'));
  if (!lock.acquired) {
    logger.error(`无法初始化：${lock.reason ?? '已有实例运行'}`);
    process.exitCode = 1;
    return;
  }

  try {
    const github = new GithubClient(repo ?? '', boundedGhRunner);
    const state = new StateStore(config.stateFile);
    state.load();

    logger.info(`仓库目录: ${config.repoDir}`);
    logger.info(`绑定仓库: ${repo ?? '未绑定'}`);
    logger.info(`主分支: ${config.mainBranch}`);
    logger.info(`Pi provider/model: ${config.piProvider || '(未设置)'} / ${config.piModel || '(未设置)'}`);

    const checks: Array<{ name: string; result: Precheck }> = [
      { name: 'Node 版本', result: nodeVersionAtLeast('22.19') ? { ok: true, detail: process.versions.node } : { ok: false, detail: `需要 Node >= 22.19，当前 ${process.versions.node}` } },
      { name: 'Git 仓库绑定', result: repo ? { ok: true, detail: repo } : { ok: false, detail: '未配置 origin 或 SPEC_LOOP_REPO' } },
      { name: 'gh 认证', result: await checkGhAuth() },
      { name: 'Pi 可用性', result: await checkPi(config.repoDir) },
      { name: '沙箱隔离探针', result: await checkSandbox(config.repoDir) },
      { name: '飞书配置', result: checkFeishu(config.feishu.enabled, config.feishu.appId, config.feishu.appSecret, config.feishu.chatId) },
    ];

    let allOk = true;
    for (const check of checks) {
      logger.info(`${check.result.ok ? '✅' : '❌'} ${check.name}: ${check.result.detail}`);
      if (!check.result.ok) allOk = false;
    }

    // 预检任一缺项或跨仓不匹配时，在任何 labels/baseline/publish 之前直接 return
    // （finally 释放锁），保证旧 state 字节不被后续写入污染。
    const existingRepo = state.snapshot().repo;
    const guard = initGuardDecision(allOk, existingRepo, repo);
    if (guard === 'precheck-failed') {
      logger.error('预检存在缺项，请先补齐后再运行 demo:init');
      process.exitCode = 1;
      return;
    }
    if (guard === 'repo-mismatch') {
      logger.error(`状态文件已绑定仓库 ${existingRepo}，与目标 ${repo} 不一致，拒绝初始化`);
      process.exitCode = 1;
      return;
    }

    if (repo) {
      try {
        await github.initLabels(['pi-task', 'spec-patch', ...STATUS_LABELS]);
        logger.info('✅ 已确保 GitHub 标签存在');
      } catch (error) {
        logger.warn(`标签初始化失败（可稍后重试）: ${error instanceof Error ? error.message : String(error)}`);
        allOk = false;
      }

      const baselineOk = await recordBaseline(config, git, config.repoDir, repo, state, logger);
      if (!baselineOk) {
        allOk = false;
      } else {
        const baselinePreviewOk = await publishBaselinePreview(config, git, state, logger);
        if (!baselinePreviewOk) {
          logger.error('基线预览发布失败，demo 启动后 5173 将无可验基线');
          allOk = false;
        }
      }
    }

    if (!allOk) {
      logger.error('初始化存在缺项，请补齐后再运行 demo:init');
      process.exitCode = 1;
      return;
    }
    logger.info('预检全部通过，可运行 npm run demo');
  } finally {
    lock.release();
  }
}

if (import.meta.main) void main();
