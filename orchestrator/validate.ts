import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { runSandboxed, sandboxExecAvailable, sandboxExecBin, type SandboxProfileSpec } from './sandbox.ts';

export interface WorkerFile {
  path: string;
  content: string;
}

export interface WorkerManifest {
  summary?: string;
  files?: WorkerFile[];
}

export interface ValidatedFile {
  relPath: string;
  absPath: string;
  content: string;
}

function assertNoSymlinkIn(baseAbs: string, parts: string[]): void {
  let cursor = baseAbs;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`拒绝符号链接路径: ${cursor}`);
    }
  }
}

export function resolveSafePath(baseDir: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('空路径');
  }
  if (relPath.includes('\0')) throw new Error(`路径包含 NUL: ${relPath}`);
  if (isAbsolute(relPath)) throw new Error(`拒绝绝对路径: ${relPath}`);

  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`拒绝绝对路径: ${relPath}`);
  }

  const parts = normalized.split('/');
  if (parts.some((p) => p === '..')) {
    throw new Error(`拒绝路径穿越: ${relPath}`);
  }
  if (parts[0] !== 'src') {
    throw new Error(`越权路径（仅允许 src/**）: ${relPath}`);
  }

  const baseAbs = resolve(baseDir);
  const absPath = resolve(baseAbs, ...parts);
  if (absPath !== baseAbs && !absPath.startsWith(`${baseAbs}${sep}`)) {
    throw new Error(`越权路径: ${relPath}`);
  }
  assertNoSymlinkIn(baseAbs, parts);
  return absPath;
}

export function validateWorkerManifest(baseDir: string, output: unknown): ValidatedFile[] {
  if (!output || typeof output !== 'object') {
    throw new Error('Worker 输出必须是 JSON 对象');
  }
  const manifest = output as WorkerManifest;
  if (!Array.isArray(manifest.files)) {
    throw new Error('Worker 输出缺少 files 数组');
  }
  const files: ValidatedFile[] = [];
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Worker 文件项必须包含 string path 与 string content');
    }
    files.push({ relPath: file.path, absPath: resolveSafePath(baseDir, file.path), content: file.content });
  }
  return files;
}

export interface VerificationCommand {
  name: string;
  cmd: string;
  args: string[];
}

export interface VerificationResult {
  name: string;
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function defaultVerificationCommands(): VerificationCommand[] {
  return [
    { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
    { name: 'test', cmd: 'npm', args: ['test'] },
    { name: 'build', cmd: 'npm', args: ['run', 'build'] },
  ];
}

export async function runVerification(
  commands: VerificationCommand[],
  cwd: string,
  runner: CommandRunner,
  env: Record<string, string>,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    const res = await runner(command.cmd, command.args, { cwd, env });
    results.push({
      name: command.name,
      ok: res.code === 0,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
    });
    if (res.code !== 0) break;
  }
  return results;
}

export function verificationPassed(results: VerificationResult[]): boolean {
  return results.length > 0 && results.every((r) => r.ok);
}

export const VERIFIER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'NO_COLOR',
  'SPEC_LOOP_OUT_DIR',
  'SPEC_LOOP_VERSION',
  'SPEC_LOOP_ASSET_BASE',
];

export function buildVerifierEnv(extra: Record<string, string> = {}, tmpDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of VERIFIER_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  const merged = { ...env, ...extra };
  if (tmpDir) {
    merged.HOME = tmpDir;
    merged.TMPDIR = tmpDir;
  }
  return merged;
}

export interface SandboxedRunnerOptions {
  execBin?: string;
  timeoutMs?: number;
}

export function makeSandboxedRunner(spec: SandboxProfileSpec, options: SandboxedRunnerOptions = {}): CommandRunner {
  return async (cmd, args, opts) => {
    const execBin = options.execBin ?? sandboxExecBin();
    if (!sandboxExecAvailable(execBin)) {
      return { code: 1, stdout: '', stderr: 'fail-closed: sandbox-exec 不可用，拒绝无隔离执行验证' };
    }
    const res = await runSandboxed(cmd, args, spec, {
      cwd: opts.cwd,
      env: opts.env,
      execBin,
      timeoutMs: options.timeoutMs,
    });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr };
  };
}
