import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// git fetch/push/worktree 等外部命令应有界，避免在网络异常或凭据提示时无限卡住实例锁。
const GIT_EXEC_TIMEOUT_MS = Number.parseInt(process.env.SPEC_LOOP_GIT_TIMEOUT_MS ?? '120000', 10);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_EXEC_TIMEOUT_MS,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { code?: number; stderr?: string; stdout?: string };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
};

export class GitClient {
  private readonly runner: GitRunner;

  constructor(runner: GitRunner = defaultGitRunner) {
    this.runner = runner;
  }

  async raw(args: string[], cwd: string): Promise<string> {
    const res = await this.runner(args, cwd);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(' ')} 失败: ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  async revParse(cwd: string, ref = 'HEAD'): Promise<string> {
    return (await this.raw(['rev-parse', ref], cwd)).trim();
  }

  async writeTree(cwd: string): Promise<string> {
    return (await this.raw(['write-tree'], cwd)).trim();
  }

  async fetch(cwd: string, branch = 'main'): Promise<void> {
    // 第二参数明确为分支名，固定 remote=origin；用完整 refspec 强制更新远程跟踪分支，
    // 否则 `git fetch origin <branch>` 只写 FETCH_HEAD，`origin/<branch>` 会保持陈旧。
    await this.raw(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], cwd);
  }

  async readSpecSnapshot(cwd: string, ref: string): Promise<Record<string, string>> {
    // ls-tree 输出的是仓库根起的完整路径（如 docs/specs/REQ-A-01.md），
    // 用 -z 空分隔避免文件名含空格/换行被错误拆分；读取失败直接抛出而非伪装空快照。
    const list = await this.raw(['ls-tree', '-z', '--name-only', ref, 'docs/specs/'], cwd);
    const paths = list.split('\0').map((s) => s.trim()).filter(Boolean);
    const files: Record<string, string> = {};
    for (const path of paths) {
      if (!path.endsWith('.md')) continue;
      const rel = path.slice('docs/specs/'.length);
      if (!rel || rel.includes('/')) continue;
      files[path] = await this.raw(['show', `${ref}:${path}`], cwd);
    }
    return files;
  }

  async createWorktree(cwd: string, dir: string, base: string, branch: string): Promise<void> {
    await this.raw(['worktree', 'add', '-b', branch, dir, base], cwd);
  }

  async attachWorktree(cwd: string, dir: string, branch: string): Promise<void> {
    await this.raw(['worktree', 'add', dir, branch], cwd);
  }

  async createDetachedWorktree(cwd: string, dir: string, sha: string): Promise<void> {
    await this.raw(['worktree', 'add', '--detach', dir, sha], cwd);
  }

  async archive(cwd: string, sha: string, destDir: string): Promise<void> {
    mkdirSync(destDir, { recursive: true });
    const tarFile = `${destDir}.archive.tar`;
    await this.raw(['archive', '--format=tar', '--output', tarFile, sha], cwd);
    try {
      await execFileAsync('tar', ['-xf', tarFile, '-C', destDir]);
    } finally {
      rmSync(tarFile, { force: true });
    }
  }

  async removeWorktree(cwd: string, dir: string): Promise<void> {
    await this.raw(['worktree', 'remove', '--force', dir], cwd);
  }

  async createBranch(cwd: string, branch: string, base: string): Promise<void> {
    await this.raw(['checkout', '-b', branch, base], cwd);
  }

  async hasBranch(cwd: string, branch: string): Promise<boolean> {
    const out = await this.raw(['branch', '--list', branch], cwd);
    return out.trim().length > 0;
  }

  async hasCommit(cwd: string, sha: string): Promise<boolean> {
    try {
      await this.raw(['cat-file', '-e', `${sha}^{commit}`], cwd);
      return true;
    } catch {
      return false;
    }
  }

  async add(cwd: string, paths: string[]): Promise<void> {
    await this.raw(['add', '--', ...paths], cwd);
  }

  async reset(cwd: string, ref = 'HEAD'): Promise<void> {
    await this.raw(['reset', ref], cwd);
  }

  async commit(cwd: string, message: string): Promise<void> {
    await this.raw(['commit', '-m', message], cwd);
  }

  async push(cwd: string, branch: string, remote = 'origin'): Promise<void> {
    await this.raw(['push', '-u', remote, branch], cwd);
  }

  async checkout(cwd: string, ref: string): Promise<void> {
    await this.raw(['checkout', ref], cwd);
  }

  async status(cwd: string): Promise<string> {
    return this.raw(['status', '--short'], cwd);
  }

  async diffNameOnly(cwd: string, ref = 'HEAD'): Promise<string[]> {
    const out = await this.raw(['diff', '--name-only', '--cached', ref, '--'], cwd);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** 提交与工作树（已暂存）之间相对 HEAD 的改动文件，用 git diff-tree 核对 docs-only 提交。 */
  async diffTreeNames(cwd: string, ref = 'HEAD'): Promise<string[]> {
    const out = await this.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', ref], cwd);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async stagedMode(cwd: string, path: string): Promise<string> {
    const out = await this.raw(['ls-files', '--stage', '--', path], cwd);
    return out.trim().split(/\s+/, 1)[0] ?? '';
  }
}
