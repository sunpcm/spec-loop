import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DispatchLabelEvent } from './dispatch-grant.ts';
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
  labels?: Array<{ name?: string }>;
  html_url?: string;
  pull_request?: unknown;
}

interface GhDispatchLabelEvent {
  id?: unknown;
  event?: unknown;
  actor?: { id?: unknown } | null;
  label?: { name?: unknown } | null;
  created_at?: unknown;
}

interface GhComment {
  id?: unknown;
  body?: unknown;
  user?: { id?: unknown } | null;
  created_at?: unknown;
}

interface GhPr {
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  head?: { ref: string; sha?: string };
  base?: { ref: string };
  merge_commit_sha?: string;
  html_url?: string;
  labels?: Array<{ name: string }>;
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

  /** 受控 REST 入口：保留退出码，供合并状态机区分离线失败与结果未知。 */
  async runApi(args: string[], opts?: { input?: string }): Promise<GhResult> {
    return this.runner(args, opts);
  }

  private async ghApiPaginate(path: string): Promise<string> {
    // --paginate 会把各页 JSON 数组原样串联，多页时直接 parse 会失败；
    // --slurp 让 gh 输出「页数组」，flatten 后重新序列化，调用方仍拿到单个 JSON 数组。
    const raw = await this.gh(['api', '--paginate', '--slurp', path]);
    const pages = JSON.parse(raw) as unknown;
    if (!Array.isArray(pages)) throw new Error('gh api --slurp 输出不是页数组');
    if (pages.length > 0 && pages.some((page) => Array.isArray(page)) && !pages.every((page) => Array.isArray(page))) {
      throw new Error('gh api --slurp 输出包含非数组页，拒绝使用不完整分页');
    }
    return JSON.stringify(pages.every((page) => Array.isArray(page)) ? pages.flat() : pages);
  }

  async listIssues(): Promise<ManagedIssue[]> {
    const raw = await this.ghApiPaginate(`repos/${this.repo}/issues?state=all&per_page=100`);
    const parsed = JSON.parse(raw) as GhIssue[];
    return parsed
      .filter((i) => !i.pull_request)
      .map((i) => ({
        ...toManagedIssue(i),
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
      headSHA: p.head?.sha,
      baseRefName: p.base?.ref ?? '',
      mergeCommitSha: p.merge_commit_sha,
      meta: extractMeta(p.body ?? ''),
      labels: (p.labels ?? []).map((label) => label.name),
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

  /** 读取受管仓库的稳定数字 ID，用于把开工许可绑定到具体仓库。 */
  async getDispatchRepositoryId(): Promise<string> {
    const raw = await this.gh(['api', `repos/${this.repo}`]);
    let parsed: { id?: unknown };
    try {
      parsed = JSON.parse(raw) as { id?: unknown };
    } catch {
      throw new Error('读取仓库 ID 返回非法 JSON');
    }
    const id = githubId(parsed.id);
    if (!id) throw new Error('仓库响应缺少有效数字 ID');
    return id;
  }

  /** 读取单张受管 Issue；PR 即使共享 issues 路径也必须明确拒绝。 */
  async getDispatchIssue(number: number): Promise<ManagedIssue> {
    assertIssueNumber(number);
    const raw = await this.gh(['api', `repos/${this.repo}/issues/${number}`]);
    let parsed: GhIssue;
    try {
      parsed = JSON.parse(raw) as GhIssue;
    } catch {
      throw new Error(`读取 Issue #${number} 返回非法 JSON`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error(`Issue #${number} 响应不是对象`);
    if (parsed.pull_request !== undefined) throw new Error(`#${number} 是 PR，不是受管 Issue`);
    if (parsed.number !== number) throw new Error(`Issue 响应编号与 #${number} 不一致`);
    if (parsed.state !== 'open' && parsed.state !== 'closed') {
      throw new Error(`Issue #${number} 响应缺少有效状态`);
    }
    return toManagedIssue(parsed);
  }

  /** 读取完整分页的标签事件；任何标签事件字段残缺都 fail closed。 */
  async listDispatchLabelEvents(number: number): Promise<DispatchLabelEvent[]> {
    assertIssueNumber(number);
    const raw = await this.ghApiPaginate(`repos/${this.repo}/issues/${number}/events?per_page=100`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`读取 Issue #${number} 事件返回非法 JSON`);
    }
    if (!Array.isArray(parsed)) throw new Error(`Issue #${number} 事件响应不是数组`);

    const result: DispatchLabelEvent[] = [];
    for (const item of parsed as GhDispatchLabelEvent[]) {
      if (!item || typeof item !== 'object') {
        throw new Error(`Issue #${number} 事件包含非对象记录`);
      }
      if (typeof item.event !== 'string') {
        throw new Error(`Issue #${number} 事件缺少有效类型`);
      }
      if (item.event !== 'labeled' && item.event !== 'unlabeled') continue;

      const id = positiveSafeInteger(item.id);
      const name = item.label?.name;
      const createdAt = item.created_at;
      if (!id || typeof name !== 'string' || name.length === 0) {
        throw new Error(`Issue #${number} 标签事件字段残缺`);
      }
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
        throw new Error(`Issue #${number} 标签事件时间无效`);
      }

      const actorId = item.actor === null
        ? null
        : githubId(item.actor?.id);
      if (item.actor !== null && item.actor !== undefined && actorId === null) {
        throw new Error(`Issue #${number} 标签事件操作者 ID 无效`);
      }
      result.push({
        id,
        actorId,
        name,
        event: item.event,
        createdAt,
      });
    }
    return result;
  }

  /** 只确保全仓共享的标签定义存在，不改写既有定义，也不向任何 Issue 添加标签。 */
  async ensureDispatchLabel(label: string): Promise<void> {
    const normalized = label.trim();
    if (!normalized || normalized !== label || /[\r\n]/.test(label)) {
      throw new Error('开工标签名必须是非空单行精确文本');
    }

    const path = `repos/${this.repo}/labels/${encodeURIComponent(label)}`;
    const readDefinition = async (): Promise<'exists' | 'missing'> => {
      const result = await this.runner(['api', path]);
      if (result.code !== 0) {
        if (/\bHTTP 404\b/i.test(result.stderr)) return 'missing';
        throw new Error(`读取开工标签定义失败: ${result.stderr.trim() || `退出码 ${result.code}`}`);
      }
      let parsed: { name?: unknown };
      try {
        parsed = JSON.parse(result.stdout) as { name?: unknown };
      } catch {
        throw new Error('读取开工标签定义返回非法 JSON');
      }
      if (parsed.name !== label) throw new Error('开工标签定义回读名称不精确匹配');
      return 'exists';
    };

    if (await readDefinition() === 'exists') return;

    const createResult = await this.runner(['label', 'create', label, '--repo', this.repo]);
    if (createResult.code === 0) return;

    if (await readDefinition() === 'exists') return;
    const detail = createResult.stderr.trim() || `退出码 ${createResult.code}`;
    throw new Error(`创建开工标签定义失败: ${detail}`);
  }

  /**
   * 用当前 gh 认证身份写入唯一 marker 评论。
   *
   * marker 必须独占 body 中的一行。已有可信评论只认当前认证用户，且正文必须与
   * 本次冻结预期完全一致；重复可信评论、同 marker 不同依据、未知作者或创建结果
   * 不明且无法唯一恢复时均拒绝继续。
   */
  async ensureDispatchComment(
    number: number,
    marker: string,
    body: string,
  ): Promise<{ id: number; createdAt: string }> {
    assertIssueNumber(number);
    if (!marker || marker !== marker.trim() || /[\r\n]/.test(marker)) {
      throw new Error('评论 marker 必须是非空单行精确文本');
    }
    if (!bodyHasExactMarker(body, marker)) {
      throw new Error('评论正文必须包含独占一行的精确 marker');
    }

    const controllerId = await this.dispatchControllerId();
    const path = `repos/${this.repo}/issues/${number}/comments`;
    const existing = selectTrustedDispatchComment(
      await this.listDispatchCommentRecords(number),
      marker,
      body,
      controllerId,
    );
    if (existing) return existing;

    let createResult: GhResult;
    try {
      createResult = await this.runner(
        ['api', '--method', 'POST', path, '--input', '-'],
        { input: JSON.stringify({ body }) },
      );
    } catch {
      createResult = { stdout: '', stderr: '', code: 1 };
    }

    if (createResult.code === 0) {
      const created = parseDispatchComment(createResult.stdout, controllerId, marker, body);
      if (created) return created;
    }

    const recovered = selectTrustedDispatchComment(
      await this.listDispatchCommentRecords(number),
      marker,
      body,
      controllerId,
    );
    if (recovered) return recovered;

    if (createResult.code !== 0) {
      const detail = createResult.stderr.trim() || `退出码 ${createResult.code}`;
      throw new Error(`创建派工评论失败且未恢复: ${detail}`);
    }
    throw new Error('创建派工评论结果不明，回读后未找到唯一可信评论');
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

  /** 按 head 分支精确查找 PR（含已合并/关闭），用于 spec-intake 的确定性恢复。 */
  async findPRByHead(headRef: string): Promise<ManagedPR | null> {
    const prs = await this.listPRs();
    return prs.find((p) => p.headRefName === headRef) ?? null;
  }

  async addPrLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.gh(['pr', 'edit', String(number), '--repo', this.repo, '--add-label', labels.join(',')]);
  }

  /** 分支是否存在（用于 push 前/后的远端对账）；读取失败不当作不存在。 */
  async branchExists(branch: string): Promise<boolean> {
    return (await this.branchSHA(branch)) !== null;
  }

  /** 读取远端分支 SHA。只有明确的 HTTP 404 才表示不存在，其余读取错误 fail closed。 */
  async branchSHA(branch: string): Promise<string | null> {
    const res = await this.runner(['api', `repos/${this.repo}/git/ref/heads/${branch}`]);
    if (res.code !== 0) {
      if (/\bHTTP 404\b/i.test(res.stderr)) return null;
      throw new Error(`读取远端分支 ${branch} 失败: ${res.stderr.trim() || `退出码 ${res.code}`}`);
    }
    let parsed: { object?: { sha?: unknown } };
    try {
      parsed = JSON.parse(res.stdout) as { object?: { sha?: unknown } };
    } catch {
      throw new Error(`远端分支 ${branch} 返回非法 JSON`);
    }
    const sha = parsed.object?.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`远端分支 ${branch} 响应缺少有效 SHA`);
    }
    return sha;
  }

  private async dispatchControllerId(): Promise<string> {
    const raw = await this.gh(['api', 'user']);
    let parsed: { id?: unknown };
    try {
      parsed = JSON.parse(raw) as { id?: unknown };
    } catch {
      throw new Error('读取 gh 认证身份返回非法 JSON');
    }
    const id = githubId(parsed.id);
    if (!id) throw new Error('无法确认 gh 认证用户的数字 ID');
    return id;
  }

  private async listDispatchCommentRecords(number: number): Promise<Array<{
    id: number;
    body: string;
    userId: string | null;
    createdAt: string;
  }>> {
    const raw = await this.ghApiPaginate(`repos/${this.repo}/issues/${number}/comments?per_page=100`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`读取 Issue #${number} 评论返回非法 JSON`);
    }
    if (!Array.isArray(parsed)) throw new Error(`Issue #${number} 评论响应不是数组`);

    return (parsed as GhComment[]).map((comment) => {
      if (!comment || typeof comment !== 'object') {
        throw new Error(`Issue #${number} 评论包含非对象记录`);
      }
      const id = positiveSafeInteger(comment.id);
      if (!id || typeof comment.body !== 'string') {
        throw new Error(`Issue #${number} 评论字段残缺`);
      }
      if (typeof comment.created_at !== 'string' || !Number.isFinite(Date.parse(comment.created_at))) {
        throw new Error(`Issue #${number} 评论时间无效`);
      }
      return {
        id,
        body: comment.body,
        userId: comment.user === null ? null : githubId(comment.user?.id),
        createdAt: comment.created_at,
      };
    });
  }
}

function toManagedIssue(issue: GhIssue): ManagedIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: (issue.labels ?? []).flatMap((label) => (
      typeof label.name === 'string' ? [label.name] : []
    )),
    meta: extractMeta(issue.body ?? ''),
    url: issue.html_url,
  };
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function githubId(value: unknown): string | null {
  const id = positiveSafeInteger(value);
  return id === null ? null : String(id);
}

function assertIssueNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Issue 编号必须是正整数');
}

function bodyHasExactMarker(body: string, marker: string): boolean {
  return body.split(/\r?\n/).some((line) => line === marker);
}

function parseDispatchComment(
  raw: string,
  controllerId: string,
  marker: string,
  expectedBody: string,
): { id: number; createdAt: string } | null {
  let parsed: GhComment;
  try {
    parsed = JSON.parse(raw) as GhComment;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const id = positiveSafeInteger(parsed.id);
  const userId = githubId(parsed.user?.id);
  const createdAt = parsed.created_at;
  if (
    !id
    || userId !== controllerId
    || typeof parsed.body !== 'string'
    || !bodyHasExactMarker(parsed.body, marker)
    || parsed.body !== expectedBody
    || typeof createdAt !== 'string'
    || !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return { id, createdAt };
}

function selectTrustedDispatchComment(
  comments: Array<{
    id: number;
    body: string;
    userId: string | null;
    createdAt: string;
  }>,
  marker: string,
  expectedBody: string,
  controllerId: string,
): { id: number; createdAt: string } | null {
  const matching = comments.filter((comment) => bodyHasExactMarker(comment.body, marker));
  if (matching.some((comment) => comment.userId === null)) {
    throw new Error('存在无法确认作者身份的 marker 评论，拒绝继续');
  }
  const trusted = matching.filter((comment) => comment.userId === controllerId);
  if (trusted.some((comment) => comment.body !== expectedBody)) {
    throw new Error('同一 marker 的认证评论正文与预期冻结依据不一致，拒绝继续');
  }
  if (trusted.length > 1) throw new Error('存在重复的可信 marker 评论，拒绝继续');
  const comment = trusted[0];
  return comment ? { id: comment.id, createdAt: comment.createdAt } : null;
}

function writeBodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-gh-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, body, 'utf8');
  return file;
}
