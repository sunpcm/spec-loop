import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeMetaBlock } from './github.ts';
import type { GitClient } from './git.ts';
import type { GithubClient } from './github.ts';
import { redact, type Logger } from './log.ts';
import { preparePiAgentDir, runPi, type PiInvocation, type PiResult } from './pi-runner.ts';
import { WORKER_PROMPT } from './prompts.ts';
import { buildIsolationPaths, type IsolationPaths, type SandboxProfileSpec } from './sandbox.ts';
import { parseSpecs } from './specs.ts';
import {
  buildVerifierEnv,
  defaultVerificationCommands,
  makeSandboxedRunner,
  runVerification,
  validateWorkerManifest,
  verificationPassed,
  type VerificationResult,
} from './validate.ts';
import type { Spec } from './types.ts';

export interface WorkerDeps {
  repoDir: string;
  runDir: string;
  git: GitClient;
  github: GithubClient;
  runPi?: (inv: PiInvocation) => Promise<PiResult>;
  verify?: (cwd: string) => Promise<VerificationResult[]>;
  checkCurrent?: (spec: Spec) => Promise<boolean>;
  logger: Logger;
  notify?: (text: string) => Promise<void>;
  mainBranch?: string;
  piProvider?: string;
  piModel?: string;
  piAgentDir?: string;
  piTimeoutMs?: number;
  piGraceMs?: number;
  piAttempts?: number;
  piTotalBudgetMs?: number;
  verifyTimeoutMs?: number;
}

export interface WorkerInput {
  jobId: string;
  reqId: string;
  issueNumber: number;
  spec: Spec;
  sourceMainSha: string;
  attempt: number;
}

export type WorkerStatus = 'published' | 'failed' | 'stale';

export interface WorkerOutcome {
  status: WorkerStatus;
  prNumber?: number;
  branch?: string;
  error?: string;
  failureStage?: 'plan' | 'write' | 'verify' | 'commit' | 'publish';
  resumeAction?: string;
  piAttempts?: number;
  piLogDir?: string;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function checkSpecCurrent(
  git: GitClient,
  repoDir: string,
  mainBranch: string,
  spec: Spec,
): Promise<boolean> {
  await git.fetch(repoDir, mainBranch);
  const files = await git.readSpecSnapshot(repoDir, `origin/${mainBranch}`);
  const parsed = parseSpecs(files);
  return parsed.specs.some((s) => s.id === spec.id && s.hash === spec.hash);
}

function linkNodeModules(repoDir: string, workDir: string): void {
  const source = join(repoDir, 'node_modules');
  const target = join(workDir, 'node_modules');
  if (existsSync(source) && !existsSync(target)) {
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      // Optional convenience; verification can still resolve modules from the parent.
    }
  }
}

function readSrcSnapshot(workDir: string): Record<string, string> {
  const srcDir = join(workDir, 'src');
  if (!existsSync(srcDir)) return {};
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result[full.slice(workDir.length + 1)] = readFileSync(full, 'utf8');
    }
  };
  walk(srcDir);
  return result;
}

function buildWorkerPrompt(spec: Spec, srcSnapshot: Record<string, string>): string {
  const srcText = Object.entries(srcSnapshot)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `### ${path}\n\`\`\`ts\n${content}\n\`\`\``)
    .join('\n\n');
  return `${WORKER_PROMPT}\n\n## 当前需求\n${spec.body}\n\n需求 ID: ${spec.id}\n需求哈希: ${spec.hash}\n\n## 当前 src 快照\n${srcText || '(无 src 文件)'}`;
}

const MAX_PI_LOG_BYTES = 64 * 1024;
const DEFAULT_PI_ATTEMPTS = 2;
const DEFAULT_PI_TOTAL_BUDGET_MS = 300000;

/** 有界截断，避免单一日志无限膨胀；截断只发生在末端，不改变原始前缀。 */
function boundedText(text: string, maxBytes: number = MAX_PI_LOG_BYTES): string {
  if (text.length <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n...[截断 ${text.length - maxBytes} 字节]`;
}

/** 将一次 Pi 尝试的原始输出写入私有作业日志目录（有界），返回实际落盘路径。 */
export function writeBoundedLog(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, boundedText(text), 'utf8');
  return file;
}

/** 从 Pi 失败结果提取安全、简洁的摘要：脱敏后仅保留退出码/超时/错误与有界 stderr 摘录。 */
export function summarizePiFailure(pi: PiResult): string {
  const detail = (pi.stderr || pi.stdout || '').trim();
  const excerpt = detail.slice(0, 400);
  const parts: string[] = [];
  if (pi.timedOut) parts.push('超时');
  parts.push(`退出码 ${pi.exitCode}`);
  if (pi.error) parts.push(pi.error);
  if (excerpt) parts.push(excerpt);
  return redact(parts.join('；') || '未知错误');
}

function buildWorkerRetryPrompt(spec: Spec, srcSnapshot: Record<string, string>, failureSummary: string): string {
  return `${buildWorkerPrompt(spec, srcSnapshot)}\n\n## 上一次尝试失败摘要\n${failureSummary}\n\n请修正上述问题后，重新输出完整 JSON 对象。`;
}

/**
 * 构建 Worker 验证沙箱：源/测试/配置只读，仅 dist 与 job 临时目录可写，禁网。
 * 显式拒绝全局模型 registry（globalAgentDir）与当前作业 agent 副本（agentDir），
 * 不让验证进程读到任何 Pi 模型配置；只拒绝这两个目录，不 deny 整个 jobRoot，
 * 以保留 jobTmp（HOME/TMPDIR）对验证命令的可读/可写。
 */
export function buildVerifierSandboxSpec(
  isolation: IsolationPaths,
  snapshotDir: string,
  jobTmp: string,
  globalAgentDir: string,
  agentDir: string,
): SandboxProfileSpec {
  return {
    writableDirs: [join(snapshotDir, 'dist'), jobTmp],
    writableLiterals: ['/dev/null'],
    denyReadDirs: isolation.denyReadDirs,
    denyReadLiterals: isolation.denyReadLiterals,
    allowReadDirs: isolation.allowReadDirs,
    sensitiveDenyDirs: [...isolation.sensitiveDenyDirs, globalAgentDir, agentDir],
    sensitiveDenyLiterals: isolation.sensitiveDenyLiterals,
    denyNetwork: true,
  };
}

export async function runWorkerJob(deps: WorkerDeps, input: WorkerInput): Promise<WorkerOutcome> {
  const logger = deps.logger;
  const mainBranch = deps.mainBranch ?? 'main';
  const branch = `pi/${slugify(input.reqId)}-i${input.issueNumber}-r${input.spec.hash.slice(0, 8)}-a${input.attempt}-s${input.sourceMainSha.slice(0, 8)}`;
  const workDir = join(deps.runDir, 'worktrees', input.jobId);
  const snapshotDir = join(deps.runDir, 'verify', input.jobId);
  const jobRoot = join(deps.runDir, 'jobs', input.jobId);
  const jobTmp = join(jobRoot, 'tmp');
  const jobCache = join(jobRoot, 'cache');
  const agentDir = join(jobRoot, 'agent');
  const jobLogDir = join(jobRoot, 'logs');
  let published = false;

  try {
    mkdirSync(workDir, { recursive: true });
    mkdirSync(jobTmp, { recursive: true });
    mkdirSync(jobCache, { recursive: true });
    await deps.git.createWorktree(deps.repoDir, workDir, input.sourceMainSha, branch);
    linkNodeModules(deps.repoDir, workDir);

    const isolation = buildIsolationPaths(deps.repoDir);
    const globalAgentDir = deps.piAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(deps.runDir, 'agent');
    preparePiAgentDir(globalAgentDir, agentDir);
    const piSandbox: SandboxProfileSpec = {
      writableDirs: [jobCache, agentDir],
      writableLiterals: ['/dev/null'],
      denyReadDirs: isolation.denyReadDirs,
      denyReadLiterals: isolation.denyReadLiterals,
      allowReadDirs: [...isolation.allowReadDirs, agentDir],
      sensitiveDenyDirs: isolation.sensitiveDenyDirs,
      sensitiveDenyLiterals: isolation.sensitiveDenyLiterals,
      denyNetwork: false,
    };

    const srcSnapshot = readSrcSnapshot(workDir);
    mkdirSync(jobLogDir, { recursive: true });
    const basePrompt = buildWorkerPrompt(input.spec, srcSnapshot);
    const piAttempts = Math.max(1, deps.piAttempts ?? DEFAULT_PI_ATTEMPTS);
    const totalBudgetMs = deps.piTotalBudgetMs ?? DEFAULT_PI_TOTAL_BUDGET_MS;
    const piTimeoutMs = deps.piTimeoutMs ?? Number.parseInt(process.env.SPEC_LOOP_PI_TIMEOUT_MS ?? '300000', 10);
    const piGraceMs = deps.piGraceMs ?? Number.parseInt(process.env.SPEC_LOOP_PI_GRACE_MS ?? '5000', 10);

    // 本作业内最多 piAttempts 次修复：首次失败保存有界原始输出，带具体摘要重试一次，
    // 总预算（含两次超时/宽限）有界，绝不无限自动重跑。
    const piStartedAt = Date.now();
    let piResult: PiResult | undefined;
    let attemptError = '';
    let attemptsRun = 0;
    for (let n = 0; n < piAttempts; n++) {
      const remaining = totalBudgetMs - (Date.now() - piStartedAt);
      if (remaining <= 0) {
        attemptError = 'Pi 总预算耗尽，未再尝试';
        break;
      }
      const prompt = n === 0 ? basePrompt : buildWorkerRetryPrompt(input.spec, srcSnapshot, attemptError);
      const invocation: PiInvocation = {
        role: 'worker',
        prompt,
        workDir,
        agentDir,
        provider: deps.piProvider ?? process.env.PI_PROVIDER ?? '',
        model: deps.piModel ?? process.env.PI_MODEL ?? '',
        timeoutMs: Math.min(piTimeoutMs, remaining),
        graceMs: piGraceMs,
        repoDir: deps.repoDir,
        sandbox: piSandbox,
      };
      piResult = await (deps.runPi ?? runPi)(invocation);
      attemptsRun += 1;
      writeBoundedLog(jobLogDir, `attempt-${n + 1}.stdout.txt`, piResult.stdout);
      writeBoundedLog(jobLogDir, `attempt-${n + 1}.stderr.txt`, piResult.stderr);
      if (piResult.ok) {
        attemptError = '';
        break;
      }
      attemptError = summarizePiFailure(piResult);
      logger.warn(`Pi 第 ${n + 1} 次尝试失败: ${attemptError}`);
    }

    if (!piResult?.ok) {
      return {
        status: 'failed',
        error: attemptError || piResult?.error || 'Pi 未产出有效输出',
        failureStage: 'plan',
        resumeAction: 'worker',
        piAttempts: attemptsRun,
        piLogDir: jobLogDir,
      };
    }

    let files;
    try {
      files = validateWorkerManifest(workDir, piResult!.output);
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        failureStage: 'write',
        resumeAction: 'worker',
      };
    }

    for (const file of files) {
      mkdirSync(dirname(file.absPath), { recursive: true });
      writeFileSync(file.absPath, file.content, 'utf8');
    }

    // 提交前核对实际变更范围：仅允许 src/**。
    await deps.git.add(workDir, ['src']);
    const changed = await deps.git.diffNameOnly(workDir, 'HEAD');
    const outOfScope = changed.filter((p) => !p.startsWith('src/'));
    if (outOfScope.length > 0) {
      await deps.git.reset(workDir);
      return {
        status: 'failed',
        error: `越权变更范围：${outOfScope.join(', ')}`,
        failureStage: 'write',
        resumeAction: 'worker',
      };
    }

    // 在无 .git 的候选快照中验证：源/测试/配置只读，仅 dist 与作业临时目录可写。
    const treeSha = await deps.git.writeTree(workDir);
    rmSync(snapshotDir, { recursive: true, force: true });
    await deps.git.archive(deps.repoDir, treeSha, snapshotDir);
    linkNodeModules(deps.repoDir, snapshotDir);

    const verifierSandbox = buildVerifierSandboxSpec(isolation, snapshotDir, jobTmp, globalAgentDir, agentDir);

    const verify = deps.verify ?? (async (cwd: string) => {
      const runner = makeSandboxedRunner(verifierSandbox, { timeoutMs: deps.verifyTimeoutMs ?? 300000 });
      return runVerification(
        defaultVerificationCommands(),
        cwd,
        runner,
        buildVerifierEnv(
          {
            SPEC_LOOP_OUT_DIR: join(cwd, 'dist'),
            SPEC_LOOP_VERSION: input.sourceMainSha,
          },
          jobTmp,
        ),
      );
    });
    const verification = await verify(snapshotDir);
    if (!verificationPassed(verification)) {
      await deps.git.reset(workDir);
      return {
        status: 'failed',
        error: verification.map((v) => `${v.name}: ${v.stderr.trim() || v.stdout.trim()}`).join('\n'),
        failureStage: 'verify',
        resumeAction: 'worker',
      };
    }

    const stillCurrent = await (deps.checkCurrent ?? (() => checkSpecCurrent(deps.git, deps.repoDir, mainBranch, input.spec)))(
      input.spec,
    );
    if (!stillCurrent) {
      await deps.git.reset(workDir);
      return { status: 'stale', error: `需求 ${input.reqId} 版本已变化，取消发布`, failureStage: 'publish' };
    }

    await deps.git.commit(workDir, `feat(${input.reqId}): 实现 ${input.spec.title}`);
    await deps.git.push(workDir, branch);

    const prBody = buildPrBody(input, verification);
    const prNumber = await deps.github.createPR(`[${input.reqId}] ${input.spec.title}`, prBody, branch, mainBranch);

    published = true;
    await deps.notify?.(`🔎 PR #${prNumber} 等待审查`);
    return { status: 'published', prNumber, branch, piAttempts: attemptsRun };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      failureStage: 'commit',
      resumeAction: 'worker',
    };
  } finally {
    if (!published) {
      logger.warn(`保留失败/过期作业 worktree 与日志供诊断: ${workDir}（日志 ${jobLogDir}）`);
      // 仅清理体积较大的缓存/临时/agent，保留有界日志与 worktree。
      rmSync(jobCache, { recursive: true, force: true });
      rmSync(jobTmp, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    } else {
      try {
        await deps.git.removeWorktree(deps.repoDir, workDir);
      } catch {
        // Cleanup is best-effort.
      }
      rmSync(jobRoot, { recursive: true, force: true });
    }
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function buildPrBody(input: WorkerInput, verification: VerificationResult[]): string {
  const checks = verification.map((v) => `${v.ok ? '✅' : '❌'} ${v.name}`).join('\n');
  const meta = encodeMetaBlock({
    schema: 1,
    system: 'spec-loop',
    kind: 'code-pr',
    reqId: input.reqId,
    specPath: input.spec.path,
    specHash: input.spec.hash,
    sourceMainSha: input.sourceMainSha,
    jobId: input.jobId,
    attempt: input.attempt,
    operationKey: `${input.spec.hash}:${input.sourceMainSha}:${input.attempt}`,
  });
  return `Closes #${input.issueNumber}\n\n需求 ID：\`${input.reqId}\`\n需求哈希：\`${input.spec.hash}\`\n来源 SHA：\`${input.sourceMainSha}\`\n\n验证结果：\n${checks}\n\n${meta}`;
}
