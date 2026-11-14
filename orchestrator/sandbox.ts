import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SandboxProfileSpec {
  writableDirs: string[];
  writableLiterals: string[];
  /** 广义读拒绝（在 allow 之前，如 home），用于覆盖整个宿主数据目录。 */
  denyReadDirs: string[];
  /** 广义读拒绝 literal（在 allow 之前）。 */
  denyReadLiterals: string[];
  /** 可信读允许（在 deny 之后、sensitiveDeny 之前）。 */
  allowReadDirs: string[];
  /** 更具体的读拒绝（在 allow 之后，如仓库内 .git/.review/模型配置）。 */
  sensitiveDenyDirs?: string[];
  /** 更具体的读拒绝 literal（在 allow 之后，如仓库内 .env）。 */
  sensitiveDenyLiterals?: string[];
  denyNetwork: boolean;
}

export function sandboxExecBin(): string {
  return process.env.SANDBOX_EXEC_BIN || '/usr/bin/sandbox-exec';
}

export function sandboxExecAvailable(bin: string = sandboxExecBin()): boolean {
  return existsSync(bin);
}

function quotePath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildSandboxProfile(spec: SandboxProfileSpec): string {
  const lines: string[] = ['(version 1)', '(allow default)', '(deny file-write*)'];
  for (const dir of spec.writableDirs) {
    lines.push(`(allow file-write* (subpath "${quotePath(dir)}"))`);
  }
  for (const literal of spec.writableLiterals) {
    lines.push(`(allow file-write* (literal "${quotePath(literal)}"))`);
  }
  // 顺序关键：广义 deny → allow → 更具体的 sensitive deny（后者更靠后/更具体时胜出）。
  for (const dir of spec.denyReadDirs) {
    lines.push(`(deny file-read-data (subpath "${quotePath(dir)}"))`);
  }
  for (const literal of spec.denyReadLiterals) {
    lines.push(`(deny file-read-data (literal "${quotePath(literal)}"))`);
  }
  for (const dir of spec.allowReadDirs) {
    lines.push(`(allow file-read-data (subpath "${quotePath(dir)}"))`);
  }
  for (const dir of spec.sensitiveDenyDirs ?? []) {
    lines.push(`(deny file-read-data (subpath "${quotePath(dir)}"))`);
  }
  for (const literal of spec.sensitiveDenyLiterals ?? []) {
    lines.push(`(deny file-read-data (literal "${quotePath(literal)}"))`);
  }
  if (spec.denyNetwork) {
    lines.push('(deny network*)');
  }
  return `${lines.join('\n')}\n`;
}

export interface IsolationPaths {
  /** 广义读拒绝（home 等）。 */
  denyReadDirs: string[];
  /** 广义读拒绝 literal。 */
  denyReadLiterals: string[];
  /** 可信读允许（repo、依赖）。 */
  allowReadDirs: string[];
  /** 更具体读拒绝（仓库内 .git/.review 等，在 allow 之后）。 */
  sensitiveDenyDirs: string[];
  /** 更具体读拒绝 literal（仓库内 .env 等，在 allow 之后）。 */
  sensitiveDenyLiterals: string[];
}

function resolveNodeRuntimeRoot(): string {
  // process.execPath 形如 .../nvm/versions/node/v24.15.0/bin/node，
  // 发行根为 bin 的上级，覆盖 node 二进制、npm 及其内置模块（无秘密）。
  return dirname(dirname(process.execPath));
}

export function buildIsolationPaths(repoDir: string): IsolationPaths {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const denyReadDirs: string[] = [];
  const denyReadLiterals: string[] = [];
  const allowReadDirs: string[] = [];
  const sensitiveDenyDirs: string[] = [];
  const sensitiveDenyLiterals: string[] = [];

  // 1. 广义拒绝 home 数据读：覆盖 ~/code 下所有宿主仓库、配置与密钥。
  //    不再依赖“枚举当前 worktree 同级目录”，嵌套 worktree 外的仓库同样被拒。
  if (home && existsSync(home)) {
    denyReadDirs.push(home);
  }

  // 2. 精确开放可信仓库源码与依赖。
  if (repoDir && existsSync(repoDir)) allowReadDirs.push(repoDir);
  const nodeModules = join(repoDir, 'node_modules');
  if (existsSync(nodeModules)) allowReadDirs.push(nodeModules);

  // 可信运行时：node/npm 发行目录通常位于 $HOME 下的 nvm，广义拒绝 home 读会
  // 使 node 二进制无法加载（EPERM/SIGABRT）。此目录无秘密，显式放开。
  const nodeRuntimeRoot = resolveNodeRuntimeRoot();
  if (nodeRuntimeRoot && existsSync(nodeRuntimeRoot)) allowReadDirs.push(nodeRuntimeRoot);

  // 3. 更具体的敏感拒绝（在 allow 之后，覆盖仓库内的 .env/.git/.review）。
  const addSensitiveDir = (p: string): void => {
    if (p && existsSync(p)) sensitiveDenyDirs.push(p);
  };
  const addSensitiveLiteral = (p: string): void => {
    if (p && existsSync(p)) sensitiveDenyLiterals.push(p);
  };
  addSensitiveLiteral(process.env.SPEC_LOOP_ENV_FILE ?? '');
  addSensitiveLiteral(join(repoDir, '.env'));
  addSensitiveLiteral(join(repoDir, '.env.local'));
  addSensitiveDir(join(repoDir, '.git'));
  addSensitiveDir(join(repoDir, '.review'));

  return { denyReadDirs, denyReadLiterals, allowReadDirs, sensitiveDenyDirs, sensitiveDenyLiterals };
}

export interface SandboxRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  execBin?: string;
  input?: string;
}

export interface SandboxResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runSandboxed(
  bin: string,
  args: string[],
  spec: SandboxProfileSpec,
  opts: SandboxRunOptions = {},
): Promise<SandboxResult> {
  const execBin = opts.execBin ?? sandboxExecBin();
  const profile = buildSandboxProfile(spec);
  const timeoutMs = opts.timeoutMs ?? 0;

  return new Promise((resolve) => {
    const child = spawn(execBin, ['-p', profile, bin, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

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

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 1000);
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

export interface SandboxProbeOptions {
  execBin?: string;
  jobRoot: string;
  sensitivePaths: string[];
}

export async function probeSandbox(opts: SandboxProbeOptions): Promise<{ ok: boolean; detail: string }> {
  const execBin = opts.execBin ?? sandboxExecBin();
  if (!sandboxExecAvailable(execBin)) {
    return { ok: false, detail: `sandbox-exec 不存在: ${execBin}` };
  }

  const spec: SandboxProfileSpec = {
    writableDirs: [opts.jobRoot],
    writableLiterals: ['/dev/null'],
    denyReadDirs: opts.sensitivePaths,
    denyReadLiterals: [],
    allowReadDirs: [],
    denyNetwork: false,
  };

  const basic = await runSandboxed('/bin/sh', ['-c', 'exit 0'], spec, { execBin });
  if (basic.code !== 0) {
    return { ok: false, detail: `sandbox-exec 基础执行失败: ${basic.stderr.trim()}` };
  }

  const outside = opts.jobRoot ? '/tmp/spec-loop-probe-denied' : '/tmp/spec-loop-probe-denied';
  const writeProbe = await runSandboxed(
    '/bin/sh',
    ['-c', `echo x > "${outside}"`],
    spec,
    { execBin },
  );
  if (writeProbe.code === 0) {
    return { ok: false, detail: `作业目录外写入未被阻断: ${outside}` };
  }

  return { ok: true, detail: 'sandbox-exec 隔离探针通过' };
}
