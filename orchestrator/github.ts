import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ManagedIssue, ManagedMeta, ManagedPR } from './types.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_GH_TIMEOUT_MS = 120_000;

/** 每次调用读取，保证测试或运行中修改 SPEC_LOOP_GH_TIMEOUT_MS 即时生效；非法值回退默认。 */
function ghTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.SPEC_LOOP_GH_TIMEOUT_MS ?? '120000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GH_TIMEOUT_MS;
}

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GhRunner = (
  args: string[],
  opts?: { input?: string; env?: Record<string, string> },
) => Promise<GhResult>;

export const defaultGhRunner: GhRunner = async (args, opts) => {
  const timeoutMs = ghTimeoutMs();
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      env: { ...process.env, ...(opts?.env ?? {}) },
      maxBuffer: 64 * 1024 * 1024,
      // 与 init 的 boundedGhRunner 同界：daemon/部署轮询里的 gh 请求不再可能永久挂起。
      timeout: timeoutMs,
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as {
      code?: number | null;
      stderr?: string;
      stdout?: string;
      killed?: boolean;
      message?: string;
    };
    if (err.killed || /timed out/i.test(err.message ?? '')) {
      // execFile 超时会终止子进程且 code 为 null；显式给非 0 退出码与超时摘要。
      return {
        stdout: err.stdout ?? '',
        stderr: `gh ${args.join(' ')} 超时（${timeoutMs}ms，SPEC_LOOP_GH_TIMEOUT_MS），子进程已终止`,
        code: 124,
      };
    }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
};

const META_BEGIN = '<!-- spec-loop:meta';
const META_END = '-->';

export function encodeMetaBlock(meta: ManagedMeta): string {
  return `${META_BEGIN}\n${JSON.stringify(meta, null, 2)}\n${META_END}`;
}

export function extractMeta(body: string): ManagedMeta | null {
  const start = body.indexOf(META_BEGIN);
  if (start < 0) return null;
  const end = body.indexOf(META_END, start);
  if (end < 0) return null;
  const json = body.slice(start + META_BEGIN.length, end);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as ManagedMeta) : null;
  } catch {
    return null;
  }
}

export function stripMeta(body: string): string {
  const start = body.indexOf(META_BEGIN);
  if (start < 0) return body;
  const end = body.indexOf(META_END, start);
  if (end < 0) return body;
  return `${body.slice(0, start)}${body.slice(end + META_END.length)}`.trim();
}

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  labels?: Array<{ name: string }>;
  html_url?: string;
  pull_request?: unknown;
}

interface GhPr {
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  head?: { ref: string };
  base?: { ref: string };
  merge_commit_sha?: string;
  html_url?: string;
}

export class GithubClient {
  private readonly repo: string;
  private readonly runner: GhRunner;

  constructor(repo: string, runner: GhRunner = defaultGhRunner) {
    this.repo = repo;
    this.runner = runner;
  }

  private async gh(args: string[], opts?: { input?: string }): Promise<string> {
    const res = await this.runner(args, opts);
    if (res.code !== 0) {
      throw new Error(`gh ${args.join(' ')} 失败: ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  private async ghApiPaginate(path: string): Promise<string> {
    // --paginate 会把各页 JSON 数组原样串联，多页时直接 parse 会失败；
    // --slurp 让 gh 输出「页数组」，flatten 后重新序列化，调用方仍拿到单个 JSON 数组。
    const raw = await this.gh(['api', '--paginate', '--slurp', path]);
    const pages = JSON.parse(raw) as unknown;
    if (!Array.isArray(pages)) throw new Error('gh api --slurp 输出不是页数组');
    return JSON.stringify(pages.flat());
  }

  async listIssues(): Promise<ManagedIssue[]> {
    const raw = await this.ghApiPaginate(`repos/${this.repo}/issues?state=all&per_page=100`);
    const parsed = JSON.parse(raw) as GhIssue[];
    return parsed
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        state: i.state,
        labels: (i.labels ?? []).map((l) => l.name),
        meta: extractMeta(i.body ?? ''),
        url: i.html_url,
      }));
  }

  async listPRs(): Promise<ManagedPR[]> {
    const raw = await this.ghApiPaginate(`repos/${this.repo}/pulls?state=all&per_page=100`);
    const parsed = JSON.parse(raw) as GhPr[];
    return parsed.map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? '',
      state: p.state,
      merged: p.merged ?? p.merged_at != null,
      mergedAt: p.merged_at ?? undefined,
      headRefName: p.head?.ref ?? '',
      baseRefName: p.base?.ref ?? '',
      mergeCommitSha: p.merge_commit_sha,
      meta: extractMeta(p.body ?? ''),
      url: p.html_url,
    }));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const bodyFile = writeBodyFile(body);
    try {
      const args = ['issue', 'create', '--repo', this.repo, '--title', title, '--body-file', bodyFile];
      for (const label of labels) args.push('--label', label);
      const out = await this.gh(args);
      const match = /(\d+)\s*$/.exec(out.trim());
      const number = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (!Number.isFinite(number)) throw new Error(`无法解析 issue 编号: ${out.trim()}`);
      return number;
    } finally {
      rmSync(bodyFile, { force: true });
    }
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    const bodyFile = writeBodyFile(body);
    try {
      await this.gh(['issue', 'edit', String(number), '--repo', this.repo, '--body-file', bodyFile]);
    } finally {
      rmSync(bodyFile, { force: true });
    }
  }

  async closeIssue(number: number): Promise<void> {
    await this.gh(['issue', 'close', String(number), '--repo', this.repo]);
  }

  async reopenIssue(number: number): Promise<void> {
    await this.gh(['issue', 'reopen', String(number), '--repo', this.repo]);
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.gh(['issue', 'edit', String(number), '--repo', this.repo, '--add-label', labels.join(',')]);
  }

  async removeLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.gh(['issue', 'edit', String(number), '--repo', this.repo, '--remove-label', labels.join(',')]);
  }

  async createPR(title: string, body: string, head: string, base: string): Promise<number> {
    const bodyFile = writeBodyFile(body);
    try {
      const out = await this.gh([
        'pr', 'create', '--repo', this.repo, '--title', title,
        '--body-file', bodyFile, '--head', head, '--base', base,
      ]);
      const match = /(\d+)\s*$/.exec(out.trim());
      const number = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (!Number.isFinite(number)) throw new Error(`无法解析 PR 编号: ${out.trim()}`);
      return number;
    } finally {
      rmSync(bodyFile, { force: true });
    }
  }

  async comment(number: number, body: string): Promise<void> {
    const bodyFile = writeBodyFile(body);
    try {
      await this.gh(['issue', 'comment', String(number), '--repo', this.repo, '--body-file', bodyFile]);
    } finally {
      rmSync(bodyFile, { force: true });
    }
  }

  async listIssueComments(number: number): Promise<Array<{ id: number; body: string }>> {
    const raw = await this.ghApiPaginate(`repos/${this.repo}/issues/${number}/comments?per_page=100`);
    const parsed = JSON.parse(raw) as Array<{ id: number; body?: string }>;
    return parsed.map((c) => ({ id: c.id, body: c.body ?? '' }));
  }

  async closePR(number: number): Promise<void> {
    await this.gh(['pr', 'close', String(number), '--repo', this.repo]);
  }

  async initLabels(labels: string[]): Promise<void> {
    // gh label create 每次只接受一个 name，逐个幂等初始化。
    for (const label of labels) {
      await this.gh(['label', 'create', label, '--repo', this.repo, '--force']);
    }
  }
}

function writeBodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-gh-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, body, 'utf8');
  return file;
}
