import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSandboxProfile,
  sandboxExecAvailable,
  sandboxExecBin,
  type SandboxProfileSpec,
} from './sandbox.ts';

export interface PiSandbox extends SandboxProfileSpec {
  execBin?: string;
}

export interface PiInvocation {
  role: string;
  prompt: string;
  workDir: string;
  agentDir: string;
  provider: string;
  model: string;
  timeoutMs: number;
  graceMs: number;
  repoDir?: string;
  bin?: string;
  flags?: string[];
  extraEnvAllowlist?: string[];
  sandbox?: PiSandbox;
}

export interface PiResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  output: unknown;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

const DEFAULT_FLAGS = [
  '-p',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-mcp',
  '--no-context-files',
  '--no-session',
  '--offline',
];

const ENV_ALLOWLIST = [
  'SPEC_LOOP_PI_API_KEY',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_CODING_AGENT_DIR',
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'NO_COLOR',
];

export function resolvePiBin(repoDir: string, override?: string): string {
  if (override) return override;
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const local = join(repoDir, 'node_modules', '.bin', 'pi');
  if (existsSync(local)) return local;
  return 'pi';
}

/**
 * 把全局模型 registry（models.json，apiKey 为 `${SPEC_LOOP_PI_API_KEY}` 环境引用、不含秘密）
 * 按需复制到作业内 agentDir。全局配置只读，Pi 只接触作业内副本。
 */
export function preparePiAgentDir(globalAgentDir: string, targetAgentDir: string): void {
  mkdirSync(targetAgentDir, { recursive: true });
  const src = join(globalAgentDir, 'models.json');
  const dst = join(targetAgentDir, 'models.json');
  if (existsSync(src) && !existsSync(dst)) {
    copyFileSync(src, dst);
  }
}

export function buildPiEnv(inv: PiInvocation): Record<string, string> {
  const allow = new Set<string>([...ENV_ALLOWLIST, ...(inv.extraEnvAllowlist ?? [])]);
  const env: Record<string, string> = {};
  for (const name of allow) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  env.PI_PROVIDER = inv.provider;
  env.PI_MODEL = inv.model;
  env.PI_CODING_AGENT_DIR = inv.agentDir;
  env.HOME = inv.agentDir;
  return env;
}

function extractJson(stdout: string): unknown | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export async function runPi(inv: PiInvocation): Promise<PiResult> {
  const bin = resolvePiBin(inv.repoDir ?? process.cwd(), inv.bin);
  const piArgs = [...(inv.flags ?? DEFAULT_FLAGS), '--provider', inv.provider, '--model', inv.model];
  const env = buildPiEnv(inv);

  if (!inv.sandbox) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: '缺少 sandbox 配置',
      output: undefined,
      durationMs: 0,
      timedOut: false,
      error: 'fail-closed: 缺少 sandbox 配置，拒绝无隔离运行 Pi',
    };
  }

  const execBin = inv.sandbox.execBin ?? sandboxExecBin();
  if (!sandboxExecAvailable(execBin)) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: `sandbox-exec 不可用: ${execBin}`,
      output: undefined,
      durationMs: 0,
      timedOut: false,
      error: 'fail-closed: sandbox-exec 不可用，拒绝无隔离运行 Pi',
    };
  }
  const profile = buildSandboxProfile(inv.sandbox);
  const command = execBin;
  const commandArgs = ['-p', profile, bin, ...piArgs];

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: inv.workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (result: PiResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      }
    };

    if (inv.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        graceTimer = setTimeout(() => {
          killGroup('SIGKILL');
        }, inv.graceMs);
      }, inv.timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        output: undefined,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: error.message,
      });
    });
    child.on('close', (code) => {
      const output = extractJson(stdout);
      const exitCode = code ?? 1;
      const ok = !timedOut && exitCode === 0 && output !== undefined;
      finish({
        ok,
        exitCode,
        stdout,
        stderr,
        output,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: ok ? undefined : `退出码 ${exitCode} 或输出未通过 JSON 校验`,
      });
    });

    child.stdin.write(inv.prompt);
    child.stdin.end();
  });
}
