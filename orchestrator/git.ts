import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PANEL_SPEC_PATH,
  isValidPanelBinding,
  type PanelBinding,
} from './delivery-profile.ts';

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
  private readonly panelBinding?: PanelBinding;

  constructor(runner: GitRunner = defaultGitRunner, panelBinding?: PanelBinding) {
    if (panelBinding !== undefined && !isValidPanelBinding(panelBinding)) {
      throw new Error('GitClient 面板绑定格式非法');
    }
    this.runner = runner;
    this.panelBinding = panelBinding;
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
    // 默认不递归 docs/specs；只有显式有效的面板绑定才额外精确读取唯一 pending 路径。
    const entries = await this.readTreeEntries(cwd, ref, 'docs/specs/');
    const files: Record<string, string> = {};
    for (const entry of entries) {
      if (!entry.path.endsWith('.md')) continue;
      const rel = entry.path.slice('docs/specs/'.length);
      if (!rel || rel.includes('/')) continue;
      assertRegularBlob(entry);
      files[entry.path] = await this.raw(['show', `${ref}:${entry.path}`], cwd);
    }
    if (this.panelBinding) {
      const matches = (await this.readTreeEntries(cwd, ref, PANEL_SPEC_PATH))
        .filter((entry) => entry.path === PANEL_SPEC_PATH);
      if (matches.length > 1) {
        throw new Error(`Git 快照返回重复受信规格路径: ${PANEL_SPEC_PATH}`);
      }
      const panel = matches[0];
      if (panel) {
        assertRegularBlob(panel);
        files[PANEL_SPEC_PATH] = await this.raw(['show', `${ref}:${PANEL_SPEC_PATH}`], cwd);
      }
    }
    return files;
  }

  /**
   * 读取一条 `ls-tree -z` 记录并保留 mode/type，避免把符号链接、子模块或目录
   * 当成普通 Markdown。`git ls-tree <tree> -- <dir>` 默认只返回该层条目。
   */
  private async readTreeEntries(cwd: string, ref: string, path: string): Promise<TreeEntry[]> {
    const list = await this.raw(
      ['ls-tree', '-z', '--full-tree', ref, '--', path],
      cwd,
    );
    const entries: TreeEntry[] = [];
    for (const record of list.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 1) throw new Error(`Git 树条目格式非法: ${path}`);
      const [mode, type, sha] = record.slice(0, tab).split(' ');
      const entryPath = record.slice(tab + 1);
      if (!mode || !type || !sha || !entryPath) {
        throw new Error(`Git 树条目格式非法: ${path}`);
      }
      entries.push({ mode, type, sha, path: entryPath });
    }
    return entries;
  }

  /** 读取某个 ref 下单个文件的完整内容；文件缺失或读取失败时直接抛出。 */
  async showFile(cwd: string, ref: string, path: string): Promise<string> {
    return this.raw(['show', `${ref}:${path}`], cwd);
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

  /** 从 from 到 to（不含 from、含 to）沿第一父链的提交列表，旧到新。 */
  async firstParentCommits(cwd: string, from: string, to: string): Promise<string[]> {
    const out = await this.raw(['rev-list', '--first-parent', '--reverse', `${from}..${to}`], cwd);
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /** 该提交相对第一父（合并提交也只对比第一父）改动的文件路径。 */
  async changedPathsFirstParent(cwd: string, sha: string): Promise<string[]> {
    const out = await this.raw(['show', '--first-parent', '--name-only', '--format=', sha], cwd);
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /**
   * 判断 ancestor 是否为 descendant 的祖先。git 无法判定或出错时返回 false（fail closed），
   * 调用方据此拒绝继续领取，而不是把未知历史当作满足条件。
   */
  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const res = await this.runner(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return res.code === 0;
  }
}

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

function assertRegularBlob(entry: TreeEntry): void {
  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
    throw new Error(`受信规格不是普通文件: ${entry.path} (${entry.mode} ${entry.type})`);
  }
}
