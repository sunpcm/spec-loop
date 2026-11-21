import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig, type Config } from '../orchestrator/config.ts';
import type { DispatchLabelEvent } from '../orchestrator/dispatch-grant.ts';
import { extractMeta, type GithubClient } from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { createCore, runOnce, type Core } from '../orchestrator/runtime.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import type {
  DispatchRevision,
  DispatchTask,
  ManagedIssue,
  ManagedPR,
  OrchestratorState,
} from '../orchestrator/types.ts';
import { emptyState } from '../orchestrator/types.ts';
import type { WorkerInput, WorkerOutcome } from '../orchestrator/worker.ts';

const REPO = 'sunpcm/spec-loop';
const REQ_ID = 'REQ-CNT-01';
const SPEC_PATH = 'docs/specs/counter.md';
const ALLOWED_USER_ID = '42';
const SILENT_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

interface DispatchComment {
  id: number;
  marker: string;
  body: string;
  createdAt: string;
}

class PersistentDispatchGithub {
  readonly issues = new Map<number, ManagedIssue>();
  readonly prs = new Map<number, ManagedPR>();
  readonly comments = new Map<number, DispatchComment[]>();
  readonly labelEvents = new Map<number, DispatchLabelEvent[]>();
  readonly ensuredLabels = new Set<string>();
  createPRCalls = 0;
  private nextIssueNumber = 12;
  private nextPRNumber = 40;
  private nextEventId = 500;
  private nextCommentId = 900;
  private clock = Date.now();

  getDispatchRepositoryId(): string {
    return 'github-repository-id:9001';
  }

  async getDispatchIssue(number: number): Promise<ManagedIssue> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`未知 Issue #${number}`);
    return structuredClone(issue);
  }

  async listDispatchLabelEvents(number: number): Promise<DispatchLabelEvent[]> {
    return structuredClone(this.labelEvents.get(number) ?? []);
  }

  async ensureDispatchLabel(label: string): Promise<void> {
    this.ensuredLabels.add(label);
  }

  async ensureDispatchComment(
    number: number,
    marker: string,
    body: string,
  ): Promise<{ id: number; createdAt: string }> {
    const comments = this.comments.get(number) ?? [];
    const existing = comments.find((comment) => comment.marker === marker || comment.body.includes(marker));
    if (existing) return { id: existing.id, createdAt: existing.createdAt };
    const comment: DispatchComment = {
      id: this.nextCommentId++,
      marker,
      body,
      createdAt: this.tick(),
    };
    comments.push(comment);
    this.comments.set(number, comments);
    return { id: comment.id, createdAt: comment.createdAt };
  }

  addLabelByUser(number: number, name: string, actorId: string): void {
    const issue = this.requireIssue(number);
    if (!issue.labels.includes(name)) issue.labels.push(name);
    this.appendLabelEvent(number, actorId, name, 'labeled');
  }

  removeLabelByUser(number: number, name: string, actorId: string): void {
    const issue = this.requireIssue(number);
    issue.labels = issue.labels.filter((label) => label !== name);
    this.appendLabelEvent(number, actorId, name, 'unlabeled');
  }

  appendLateLabelEvent(
    number: number,
    name: string,
    actorId: string,
    event: 'labeled' | 'unlabeled',
  ): void {
    this.appendLabelEvent(number, actorId, name, event);
  }

  async listIssues(): Promise<ManagedIssue[]> {
    return [...this.issues.values()].map((issue) => structuredClone(issue));
  }

  async listPRs(): Promise<ManagedPR[]> {
    return [...this.prs.values()].map((pr) => structuredClone(pr));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const number = this.nextIssueNumber++;
    this.issues.set(number, {
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      meta: extractMeta(body),
      url: `https://github.com/${REPO}/issues/${number}`,
    });
    return number;
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    const issue = this.requireIssue(number);
    issue.body = body;
    issue.meta = extractMeta(body);
  }

  async closeIssue(number: number): Promise<void> {
    this.requireIssue(number).state = 'closed';
  }

  async reopenIssue(number: number): Promise<void> {
    this.requireIssue(number).state = 'open';
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    const issue = this.requireIssue(number);
    for (const label of labels) {
      if (!issue.labels.includes(label)) issue.labels.push(label);
    }
  }

  async removeLabels(number: number, labels: string[]): Promise<void> {
    const issue = this.requireIssue(number);
    issue.labels = issue.labels.filter((label) => !labels.includes(label));
  }

  async createPR(title: string, body: string, head: string, base: string): Promise<number> {
    this.createPRCalls += 1;
    const number = this.nextPRNumber++;
    this.prs.set(number, {
      number,
      title,
      body,
      state: 'open',
      merged: false,
      headRefName: head,
      baseRefName: base,
      meta: extractMeta(body),
      labels: [],
      url: `https://github.com/${REPO}/pull/${number}`,
    });
    return number;
  }

  async comment(number: number, body: string): Promise<void> {
    this.requireIssue(number);
    const comments = this.comments.get(number) ?? [];
    comments.push({
      id: this.nextCommentId++,
      marker: '',
      body,
      createdAt: this.tick(),
    });
    this.comments.set(number, comments);
  }

  async listIssueComments(number: number): Promise<Array<{ id: number; body: string }>> {
    return (this.comments.get(number) ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body,
    }));
  }

  async listTrustedDispatchComments(number: number): Promise<Array<{
    id: number;
    body: string;
    userId: string;
    createdAt: string;
  }>> {
    return (this.comments.get(number) ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body,
      userId: 'github-repository-id:9001',
      createdAt: comment.createdAt,
    }));
  }

  async closePR(number: number): Promise<void> {
    const pr = this.prs.get(number);
    if (pr) pr.state = 'closed';
  }

  async initLabels(_labels: string[]): Promise<void> {}

  async findPRByHead(headRef: string): Promise<ManagedPR | null> {
    return structuredClone(
      [...this.prs.values()].find((pr) => pr.headRefName === headRef) ?? null,
    );
  }

  async addPrLabels(number: number, labels: string[]): Promise<void> {
    const pr = this.prs.get(number);
    if (!pr) return;
    pr.labels ??= [];
    for (const label of labels) {
      if (!pr.labels.includes(label)) pr.labels.push(label);
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    return [...this.prs.values()].some((pr) => pr.headRefName === branch);
  }

  async branchSHA(branch: string): Promise<string | null> {
    return (await this.branchExists(branch)) ? 'f'.repeat(40) : null;
  }

  async runApi(): Promise<{ stdout: string; stderr: string; code: number }> {
    return { stdout: '[]', stderr: '', code: 0 };
  }

  visibleIssueText(number: number): string {
    const issue = this.requireIssue(number);
    return [issue.body, ...(this.comments.get(number) ?? []).map((comment) => comment.body)].join('\n');
  }

  private requireIssue(number: number): ManagedIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`未知 Issue #${number}`);
    return issue;
  }

  private appendLabelEvent(
    number: number,
    actorId: string,
    name: string,
    event: 'labeled' | 'unlabeled',
  ): void {
    const events = this.labelEvents.get(number) ?? [];
    events.push({
      id: this.nextEventId++,
      actorId,
      name,
      event,
      createdAt: this.tick(),
    });
    this.labelEvents.set(number, events);
  }

  private tick(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }
}

interface GitFixture {
  root: string;
  remote: string;
  seed: string;
  controller: string;
  mergeDoc(content: string, branch: string, message: string): string;
  commitUnrelated(message: string): string;
  currentMain(): string;
  specHash(content: string): string;
}

interface FlowFixture extends GitFixture {
  core: Core;
  github: PersistentDispatchGithub;
  workerInputs: WorkerInput[];
  state: () => OrchestratorState;
  createCore(): Core;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Spec Loop Test',
      GIT_AUTHOR_EMAIL: 'spec-loop-test@example.invalid',
      GIT_COMMITTER_NAME: 'Spec Loop Test',
      GIT_COMMITTER_EMAIL: 'spec-loop-test@example.invalid',
    },
  }).trim();
}

function counterDoc(change: string, acceptance: string): string {
  return `# 计数器需求

### [${REQ_ID}] 计数器

#### 功能
- 保留现有增加、减少与重置行为。
- ${change}

#### 验收
- ${acceptance}
- 重置后显示 0，原步长保持不变。
`;
}

function createGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-dispatch-flow-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const controller = join(root, 'controller');
  git(['init', '--bare', '--initial-branch=main', remote], root);
  git(['clone', remote, seed], root);
  git(['config', 'user.name', 'Spec Loop Test'], seed);
  git(['config', 'user.email', 'spec-loop-test@example.invalid'], seed);
  mkdirSync(join(seed, 'docs', 'specs'), { recursive: true });
  writeFileSync(
    join(seed, SPEC_PATH),
    counterDoc('当前版本只使用固定步长。', '步长为 2 时点击增加得到原值加 2。'),
    'utf8',
  );
  git(['add', SPEC_PATH], seed);
  git(['commit', '-m', 'seed counter requirement'], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['clone', remote, controller], root);

  return {
    root,
    remote,
    seed,
    controller,
    mergeDoc(content, branch, message) {
      git(['checkout', 'main'], seed);
      git(['pull', '--ff-only', 'origin', 'main'], seed);
      git(['checkout', '-b', branch], seed);
      writeFileSync(join(seed, SPEC_PATH), content, 'utf8');
      git(['add', SPEC_PATH], seed);
      git(['commit', '-m', `${message} docs-only`], seed);
      git(['push', 'origin', branch], seed);
      git(['checkout', 'main'], seed);
      git(['merge', '--no-ff', branch, '-m', message], seed);
      git(['push', 'origin', 'main'], seed);
      git(['branch', '-d', branch], seed);
      return git(['rev-parse', 'main'], seed);
    },
    commitUnrelated(message) {
      git(['checkout', 'main'], seed);
      git(['pull', '--ff-only', 'origin', 'main'], seed);
      writeFileSync(join(seed, `unrelated-${Date.now()}.txt`), `${message}\n`, 'utf8');
      git(['add', '-A'], seed);
      git(['commit', '-m', message], seed);
      git(['push', 'origin', 'main'], seed);
      return git(['rev-parse', 'main'], seed);
    },
    currentMain() {
      return git(['rev-parse', 'main'], seed);
    },
    specHash(content) {
      const parsed = parseSpecs({ [SPEC_PATH]: content });
      assert.deepEqual(parsed.errors, []);
      const spec = parsed.specs.find((candidate) => candidate.id === REQ_ID);
      assert.ok(spec);
      return spec.hash;
    },
  };
}

function makeFlowConfig(gitFixture: GitFixture): Config {
  const config = loadConfig(gitFixture.controller);
  Object.assign(config, {
    repo: REPO,
    repoDir: gitFixture.controller,
    dispatchAllowedUserIds: [ALLOWED_USER_ID],
    piProvider: '',
    piModel: '',
    pollIntervalMs: 0,
  });
  return config;
}

async function createFlowFixture(): Promise<FlowFixture> {
  const gitFixture = createGitFixture();
  const github = new PersistentDispatchGithub();
  const workerInputs: WorkerInput[] = [];
  const config = makeFlowConfig(gitFixture);
  writeFileSync(
    config.stateFile,
    JSON.stringify({
      ...emptyState(),
      repo: REPO,
      cursorMainSha: gitFixture.currentMain(),
    }, null, 2),
    'utf8',
  );

  const createFlowCore = (): Core => {
    const core = createCore(config, REPO);
    const client = github as unknown as GithubClient;
    core.github = client;
    core.workerDeps.github = client;
    core.deployDeps.github = client;
    core.reconcileContext.github = client;
    core.specIntakeDeps.github = client;
    if (core.retryBaselineDeps) core.retryBaselineDeps.github = client;

    core.logger = SILENT_LOGGER;
    core.workerDeps.logger = SILENT_LOGGER;
    core.deployDeps.logger = SILENT_LOGGER;
    core.reconcileContext.logger = SILENT_LOGGER;
    core.specIntakeDeps.logger = SILENT_LOGGER;
    if (core.retryBaselineDeps) core.retryBaselineDeps.logger = SILENT_LOGGER;

    core.workerRunner = async (deps, input): Promise<WorkerOutcome> => {
      workerInputs.push(structuredClone(input));
      const prNumber = await deps.github.createPR(
        `[${input.reqId}] 测试交付`,
        `需求 ${input.reqId}\n\n来源 ${input.sourceMainSha}`,
        `pi/test-${workerInputs.length}`,
        'main',
      );
      return {
        status: 'published',
        prNumber,
        branch: `pi/test-${workerInputs.length}`,
        headSHA: 'a'.repeat(40),
      };
    };
    return core;
  };

  const core = createFlowCore();
  return {
    ...gitFixture,
    core,
    github,
    workerInputs,
    state: () => core.state.snapshot(),
    createCore: createFlowCore,
  };
}

function revisions(core: Core): DispatchRevision[] {
  return core.state.snapshot().dispatchRevisions?.[REQ_ID] ?? [];
}

function latestRevision(core: Core): DispatchRevision {
  const current = revisions(core);
  const latest = current.at(-1);
  assert.ok(latest, `缺少 ${REQ_ID} 的 dispatchRevision`);
  return latest;
}

function issueNumber(core: Core): number {
  const number = core.state.snapshot().requirements[REQ_ID]?.issueNumber;
  assert.ok(number, `缺少 ${REQ_ID} 的受管 Issue`);
  return number;
}

function frozenTask(input: WorkerInput): DispatchTask | undefined {
  return input.dispatchRevision?.task;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function publishedTask(
  github: PersistentDispatchGithub,
  revision: DispatchRevision,
): DispatchTask & Record<string, unknown> {
  const marker = `spec-loop:dispatch:${revision.reqId}:r${revision.revision}`;
  const comment = (github.comments.get(revision.issueNumber) ?? []).find(
    (candidate) => candidate.marker === marker,
  );
  assert.ok(comment, `缺少 r${revision.revision} 的发布评论`);
  assert.equal(comment.id, revision.publicationCommentId);
  assert.equal(comment.createdAt, revision.publishedAt);

  const blocks = [...comment.body.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)];
  assert.equal(blocks.length, 1, '发布评论必须包含唯一的 JSON 任务快照');
  const parsed = JSON.parse(blocks[0]![1]!) as DispatchTask & Record<string, unknown>;
  assert.deepEqual(
    {
      schema: parsed.schema,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      revision: parsed.revision,
      reqId: parsed.reqId,
      specPath: parsed.specPath,
      sourceMainSha: parsed.sourceMainSha,
      specHash: parsed.specHash,
    },
    {
      schema: 1,
      repo: REPO,
      issueNumber: revision.issueNumber,
      revision: `r${revision.revision}`,
      reqId: revision.reqId,
      specPath: revision.specPath,
      sourceMainSha: revision.sourceMainSha,
      specHash: revision.specHash,
    },
    '发布 JSON 的身份字段必须与冻结版本一致',
  );
  assert.deepEqual(
    {
      goal: parsed.goal,
      steps: parsed.steps,
      acceptance: parsed.acceptance,
      allowedPaths: parsed.allowedPaths,
      dependsOn: parsed.dependsOn,
    },
    revision.task,
    '发布 JSON 的任务原文必须与持久化冻结任务一致',
  );
  return parsed;
}

function assertFrozenInput(
  github: PersistentDispatchGithub,
  input: WorkerInput,
  revision: DispatchRevision,
): void {
  assert.equal(input.reqId, revision.reqId);
  assert.equal(input.issueNumber, revision.issueNumber);
  assert.equal(input.spec.hash, revision.specHash);
  assert.equal(input.sourceMainSha, revision.sourceMainSha);
  assert.deepEqual(
    input.dispatchRevision,
    revision,
    'WorkerInput 必须携带完整冻结记录，不能只带版本号或临时任务',
  );
  const persisted = JSON.parse(JSON.stringify(revision)) as DispatchRevision;
  assert.deepEqual(persisted, revision, '发布 JSON 必须是稳定、可持久化的任务快照');
  const published = publishedTask(github, revision);
  assert.deepEqual(
    {
      goal: published.goal,
      steps: published.steps,
      acceptance: published.acceptance,
      allowedPaths: published.allowedPaths,
      dependsOn: published.dependsOn,
    },
    frozenTask(input),
    '发布 JSON、持久化任务与 WorkerInput 必须使用同一份冻结任务',
  );
  assert.deepEqual(frozenTask(input), persisted.task, 'WorkerInput 必须携带发布时的冻结任务');
  assert.ok(revision.task.goal.trim().length > 0);
  assert.ok(revision.task.steps.length > 0);
  assert.ok(revision.task.allowedPaths.length > 0);
  assert.ok(Array.isArray(revision.task.dependsOn));

  const visible = normalizedText(github.visibleIssueText(revision.issueNumber));
  const taskTexts = [
    revision.task.goal,
    ...revision.task.steps.map((step) => step.text),
    ...Object.values(revision.task.acceptance),
    ...revision.task.allowedPaths,
  ];
  for (const text of taskTexts) {
    assert.ok(
      visible.includes(normalizedText(text)),
      `Issue 可见任务原文缺少冻结内容: ${text}`,
    );
  }
}

function latestLabel(revision: DispatchRevision): string {
  return `可开工/r${revision.revision}`;
}

test('真实 Git/runOnce：待排期不放行，白名单精确许可后并发/重复/重启只派一次', async () => {
  const fixture = await createFlowFixture();
  try {
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, '基线轮询不得派工');
    assert.equal(fixture.github.createPRCalls, 0);

    const r1Doc = counterDoc(
      '新增“翻倍”操作，当前计数乘以 2，步长保持不变。',
      '当前值为 3、步长为 2 时翻倍显示 6，随后增加显示 8。',
    );
    const r1Sha = fixture.mergeDoc(r1Doc, 'docs/counter-r1', 'merge counter dispatch r1');

    await runOnce(fixture.core);
    await runOnce(fixture.core);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, '合并后无开工标签必须连续三轮零派工');
    assert.equal(fixture.github.createPRCalls, 0);
    const number = issueNumber(fixture.core);
    assert.equal(issueNumber(fixture.core), number, '同一需求必须复用同一张主 Issue');
    assert.match(fixture.github.visibleIssueText(number), /待排期/);

    const revision1 = latestRevision(fixture.core);
    assert.equal(revision1.revision, 1);
    assert.equal(revision1.reqId, REQ_ID);
    assert.equal(revision1.issueNumber, number);
    assert.equal(revision1.specHash, fixture.specHash(r1Doc));
    assert.equal(revision1.sourceMainSha, r1Sha);
    assert.equal(typeof revision1.publishedAt, 'string');
    assert.equal(fixture.github.ensuredLabels.has(latestLabel(revision1)), true);
    publishedTask(fixture.github, revision1);

    fixture.github.addLabelByUser(number, latestLabel(revision1), '99');
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, '非白名单用户的合法版本标签不得派工');
    fixture.github.removeLabelByUser(number, latestLabel(revision1), '99');

    fixture.github.addLabelByUser(number, '可开工/r99', ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, '非当前版本的标签不得派工');
    fixture.github.removeLabelByUser(number, '可开工/r99', ALLOWED_USER_ID);

    fixture.github.addLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    fixture.github.removeLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, '领取前撤标必须失效');

    fixture.github.addLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    fixture.github.addLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    const unrelatedSha = fixture.commitUnrelated('unrelated main commit after license');
    assert.notEqual(unrelatedSha, r1Sha);

    await Promise.all([runOnce(fixture.core), runOnce(fixture.core)]);
    assert.equal(fixture.workerInputs.length, 1, '重复标签与并发轮询只能产生一次 Worker');
    assert.equal(fixture.github.createPRCalls, 1, '重复标签与并发轮询只能产生一个 PR');
    assertFrozenInput(fixture.github, fixture.workerInputs[0]!, revision1);
    assert.equal(fixture.workerInputs[0]!.sourceMainSha, r1Sha, '无关主线提交不得改写冻结来源');

    await runOnce(fixture.core);
    fixture.github.addLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    fixture.github.removeLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    fixture.github.addLabelByUser(number, latestLabel(revision1), ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1);
    assert.equal(fixture.github.createPRCalls, 1);

    fixture.core = fixture.createCore();
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1, '重启后不得重复派发已领取作业');
    assert.equal(fixture.github.createPRCalls, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('新版发布后旧标签和迟到事件为零，当前版本标签仍使用 r2 冻结输入', async () => {
  const fixture = await createFlowFixture();
  try {
    await runOnce(fixture.core);
    const r1Doc = counterDoc(
      '新增翻倍操作。',
      '当前值为 3 时翻倍显示 6。',
    );
    fixture.mergeDoc(r1Doc, 'docs/counter-r1-versioned', 'merge counter dispatch r1');
    await runOnce(fixture.core);
    const number = issueNumber(fixture.core);
    const r1 = latestRevision(fixture.core);

    const r2Doc = counterDoc(
      '新增翻倍操作，并保留原步长用于后续加减。',
      '当前值为 3、步长为 2 时翻倍显示 6，随后增加显示 8。',
    );
    const r2Sha = fixture.mergeDoc(r2Doc, 'docs/counter-r2-versioned', 'merge counter dispatch r2');
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.deepEqual(revisions(fixture.core).map((revision) => revision.revision), [1, 2]);
    const r2 = latestRevision(fixture.core);
    assert.equal(r2.sourceMainSha, r2Sha);
    assert.match(fixture.github.visibleIssueText(number), /r2/);
    assert.match(fixture.github.visibleIssueText(number), /待排期/);
    for (const revision of revisions(fixture.core)) publishedTask(fixture.github, revision);

    fixture.github.addLabelByUser(number, latestLabel(r1), ALLOWED_USER_ID);
    fixture.github.appendLateLabelEvent(number, latestLabel(r1), ALLOWED_USER_ID, 'labeled');
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, 'r2 生效后迟到的 r1 标签不得派工');

    fixture.github.addLabelByUser(number, latestLabel(r2), ALLOWED_USER_ID);
    fixture.github.appendLateLabelEvent(number, latestLabel(r1), ALLOWED_USER_ID, 'labeled');
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1);
    assert.equal(fixture.github.createPRCalls, 1);
    assertFrozenInput(fixture.github, fixture.workerInputs[0]!, r2);

    fixture.github.appendLateLabelEvent(number, latestLabel(r1), ALLOWED_USER_ID, 'labeled');
    fixture.github.removeLabelByUser(number, latestLabel(r2), ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1, 'r1 迟到事件和领取后撤标不得新增派工');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('离线 A→B→A 必须发布更高版本，无关提交不失效，原 r1 许可不复用', async () => {
  const fixture = await createFlowFixture();
  try {
    await runOnce(fixture.core);
    const docA = counterDoc(
      '新增按固定比例翻倍的操作。',
      '当前值为 3 时翻倍显示 6。',
    );
    const shaA = fixture.mergeDoc(docA, 'docs/counter-a', 'merge counter dispatch A');
    await runOnce(fixture.core);
    const number = issueNumber(fixture.core);
    const r1 = latestRevision(fixture.core);
    assert.equal(r1.sourceMainSha, shaA);

    fixture.github.addLabelByUser(number, latestLabel(r1), ALLOWED_USER_ID);
    const revisionsBeforeOffline = revisions(fixture.core);

    const docB = counterDoc(
      '新增按固定比例翻倍，并把重置值改为 1。',
      '当前值为 3 时翻倍显示 6，重置显示 1。',
    );
    fixture.mergeDoc(docB, 'docs/counter-b', 'merge counter dispatch B');
    const shaAFinal = fixture.mergeDoc(docA, 'docs/counter-a-return', 'merge counter dispatch A again');
    assert.notEqual(shaAFinal, shaA);

    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0, '离线期间内容回到 A 也必须重新排期');
    const revisionsAfterOffline = revisions(fixture.core);
    assert.ok(
      revisionsAfterOffline.length > revisionsBeforeOffline.length,
      '离线期间的版本必须永久登记',
    );
    assert.deepEqual(
      revisionsAfterOffline.map((revision) => revision.revision),
      Array.from(
        { length: revisionsAfterOffline.length },
        (_value, index) => index + 1,
      ),
      '版本号必须从 r1 开始严格单调连续递增',
    );
    const reissued = latestRevision(fixture.core);
    assert.ok(reissued.revision > r1.revision, 'A→B→A 返回 A 时必须分配新版本号');
    assert.equal(
      reissued.revision,
      revisionsAfterOffline.at(-1)!.revision,
      '当前待排期项必须是最高版本',
    );
    assert.equal(reissued.specHash, r1.specHash);
    assert.equal(reissued.sourceMainSha, shaAFinal);
    assert.notEqual(reissued.sourceMainSha, r1.sourceMainSha);
    for (const revision of revisionsAfterOffline) publishedTask(fixture.github, revision);
    assert.match(
      fixture.github.visibleIssueText(number),
      new RegExp(`r${reissued.revision}(?!\\d)`),
    );
    assert.match(fixture.github.visibleIssueText(number), /待排期/);

    fixture.github.addLabelByUser(number, latestLabel(reissued), ALLOWED_USER_ID);
    const unrelatedSha = fixture.commitUnrelated('unrelated commit after current version publication');
    assert.notEqual(unrelatedSha, shaAFinal);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1, '有效当前版许可应可跨无关提交派工');
    assert.equal(fixture.github.createPRCalls, 1);
    assertFrozenInput(fixture.github, fixture.workerInputs[0]!, reissued);
    assert.equal(fixture.workerInputs[0]!.sourceMainSha, shaAFinal);

    fixture.github.appendLateLabelEvent(number, latestLabel(r1), ALLOWED_USER_ID, 'labeled');
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1, '旧 r1 迟到事件不得复用');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
