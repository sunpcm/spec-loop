import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  COUNTER_REQ_ID,
  COUNTER_SPEC_PATH,
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
  type PanelBinding,
} from '../orchestrator/delivery-profile.ts';
import { extractMeta, type GithubClient } from '../orchestrator/github.ts';
import { GitClient } from '../orchestrator/git.ts';
import type { Logger } from '../orchestrator/log.ts';
import { validateRegisteredPanelIssue } from '../orchestrator/panel-registration.ts';
import {
  reconcileWithDispatch,
  type DispatchReconcileDeps,
  type ReconcileContext,
  type ReconcileSummary,
} from '../orchestrator/scheduler.ts';
import { pickWorkerTargets } from '../orchestrator/runtime.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { StateStore } from '../orchestrator/state.ts';
import type {
  DispatchRevision,
  ManagedIssue,
  ManagedPR,
  OrchestratorState,
} from '../orchestrator/types.ts';
import { emptyState } from '../orchestrator/types.ts';

const REPO = 'sunpcm/spec-loop';
const REPO_ID = 'github-repository-id:7001';
const PANEL_ISSUE = 19;
const FRAMEWORK_ISSUE = 18;
const SILENT_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function counterDoc(change: string, acceptance: string): string {
  return `# 计数器

### [${COUNTER_REQ_ID}] 计数器

#### 功能
- 保留现有加减和重置。
- ${change}

#### 验收
- ${acceptance}
`;
}

function panelDoc(change: string, acceptance: string): string {
  return `# 流程面板

### [${PANEL_REQ_ID}] 查看需求等待原因

#### 功能
- 面板说明谁负责下一步以及等待原因。
- ${change}

#### 验收
- ${acceptance}
`;
}

function specHash(path: string, content: string): string {
  const parsed = parseSpecs({ [path]: content });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.specs.length, 1);
  return parsed.specs[0]!.hash;
}

function ordinaryPanelBody(binding: Pick<PanelBinding, 'repo' | 'confirmedMainSha' | 'specHash'>): string {
  return [
    '## 人工交接',
    '',
    '先保留本卡，不给旧调度器登记可领取状态。',
    '',
    `需求来源为 \`${binding.repo}@${binding.confirmedMainSha}\` 的 \`docs/specs/pending/panel.md\`，需求块哈希为 \`${binding.specHash}\``,
    '',
    '- [ ] 框架就绪后再公布 rN',
  ].join('\n');
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

interface DispatchComment {
  id: number;
  body: string;
  createdAt: string;
}

class FakeGithub {
  readonly issues = new Map<number, ManagedIssue>();
  readonly comments = new Map<number, DispatchComment[]>();
  readonly created: Array<{ number: number; title: string; body: string }> = [];
  readonly updated = new Map<number, number>();
  readonly removedLabels: Array<{ number: number; labels: string[] }> = [];
  private nextIssue = 100;
  private nextComment = 900;
  private clock = Date.now();

  constructor(binding: PanelBinding) {
    this.issues.set(FRAMEWORK_ISSUE, {
      number: FRAMEWORK_ISSUE,
      title: '[框架 #18] 面板派发能力',
      body: '本框架任务会在正文里提到 docs/specs/pending/panel.md 和“面板”，但它不是 REQ-PANEL 普通卡。',
      state: 'open',
      labels: ['待排期'],
      meta: null,
    });
    this.issues.set(PANEL_ISSUE, {
      number: PANEL_ISSUE,
      title: `[${PANEL_REQ_ID}] 查看一条需求在等谁、为什么`,
      body: ordinaryPanelBody(binding),
      state: 'open',
      labels: ['待排期'],
      meta: null,
    });
  }

  async listIssues(): Promise<ManagedIssue[]> {
    return structuredClone([...this.issues.values()]);
  }

  async listPRs(): Promise<ManagedPR[]> {
    return [];
  }

  async getDispatchRepositoryId(): Promise<string> {
    return REPO_ID;
  }

  async getDispatchIssue(number: number): Promise<ManagedIssue> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`未知 Issue #${number}`);
    return structuredClone(issue);
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const number = this.nextIssue++;
    const issue: ManagedIssue = {
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      meta: extractMeta(body),
    };
    this.issues.set(number, issue);
    this.created.push({ number, title, body });
    return number;
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    const issue = this.requireIssue(number);
    issue.body = body;
    issue.meta = extractMeta(body);
    this.updated.set(number, (this.updated.get(number) ?? 0) + 1);
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
    this.removedLabels.push({ number, labels: [...labels] });
  }

  async closeIssue(number: number): Promise<void> {
    this.requireIssue(number).state = 'closed';
  }

  async comment(number: number, body: string): Promise<void> {
    this.requireIssue(number);
    const comments = this.comments.get(number) ?? [];
    comments.push({ id: this.nextComment++, body, createdAt: this.tick() });
    this.comments.set(number, comments);
  }

  async closePR(): Promise<void> {}

  async ensureDispatchLabel(): Promise<void> {}

  async ensureDispatchComment(
    number: number,
    _marker: string,
    body: string,
  ): Promise<{ id: number; createdAt: string }> {
    const comments = this.comments.get(number) ?? [];
    const marker = body.split(/\r?\n/, 1)[0]!;
    const existing = comments.find((comment) => comment.body.split(/\r?\n/, 1)[0] === marker);
    if (existing) return { id: existing.id, createdAt: existing.createdAt };
    const comment = { id: this.nextComment++, body, createdAt: this.tick() };
    comments.push(comment);
    this.comments.set(number, comments);
    return { id: comment.id, createdAt: comment.createdAt };
  }

  async listTrustedDispatchComments(
    number: number,
  ): Promise<Array<{ id: number; body: string; createdAt: string }>> {
    return structuredClone(this.comments.get(number) ?? []);
  }

  addLabelByUser(number: number, label: string): void {
    const issue = this.requireIssue(number);
    if (!issue.labels.includes(label)) issue.labels.push(label);
  }

  private requireIssue(number: number): ManagedIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`未知 Issue #${number}`);
    return issue;
  }

  private tick(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }
}

interface Fixture {
  root: string;
  seed: string;
  controller: string;
  stateFile: string;
  initialMain: string;
  panelBinding: PanelBinding;
  github: FakeGithub;
  run(options?: {
    panelBinding?: PanelBinding | false;
  }): Promise<ReconcileSummary | null>;
  commitFiles(files: Record<string, string>, message: string): string;
  deleteFiles(paths: string[], message: string): string;
  cleanup(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-registration-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const controller = join(root, 'controller');
  const stateFile = join(root, 'state.json');
  git(['init', '--bare', '--initial-branch=main', remote], root);
  git(['clone', remote, seed], root);
  git(['config', 'user.name', 'Spec Loop Test'], seed);
  git(['config', 'user.email', 'spec-loop-test@example.invalid'], seed);
  mkdirSync(join(seed, 'docs', 'specs', 'pending'), { recursive: true });
  writeFileSync(join(seed, COUNTER_SPEC_PATH), counterDoc('初始功能。', '初始验收。'), 'utf8');
  writeFileSync(join(seed, PANEL_SPEC_PATH), panelDoc('初始面板说明。', '初始面板验收。'), 'utf8');
  git(['add', 'docs/specs'], seed);
  git(['commit', '-m', 'seed counter and panel requirements'], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['clone', remote, controller], root);

  const initialMain = git(['rev-parse', 'main'], seed);
  const initialPanel = panelDoc('初始面板说明。', '初始面板验收。');
  const panelBinding: PanelBinding = {
    repo: REPO,
    mainBranch: 'main',
    repositoryId: REPO_ID,
    issueNumber: PANEL_ISSUE,
    confirmedMainSha: initialMain,
    specHash: specHash(PANEL_SPEC_PATH, initialPanel),
  };
  const github = new FakeGithub(panelBinding);
  const gitClient = new GitClient(undefined, panelBinding);
  const initialState: OrchestratorState = {
    ...emptyState(),
    repo: REPO,
    cursorMainSha: initialMain,
  };
  writeFileSync(stateFile, JSON.stringify(initialState, null, 2), 'utf8');

  const dispatch: DispatchReconcileDeps = {
    isGated: (reqId) => reqId === COUNTER_REQ_ID || reqId === PANEL_REQ_ID,
    allowedPaths: (spec) => spec.id === PANEL_REQ_ID ? ['panel/src/**'] : ['src/**'],
    dependsOn: () => [],
  };

  return {
    root,
    seed,
    controller,
    stateFile,
    initialMain,
    panelBinding,
    github,
    async run(options = {}) {
      const state = new StateStore(stateFile);
      state.load();
      const binding = options.panelBinding === false
        ? undefined
        : options.panelBinding ?? panelBinding;
      const context: ReconcileContext = {
        repoDir: controller,
        git: gitClient,
        github: github as unknown as GithubClient,
        state,
        logger: SILENT_LOGGER,
        mainBranch: 'main',
        dispatch,
        ...(binding ? { panelBinding: binding } : {}),
      };
      return reconcileWithDispatch(context, dispatch);
    },
    commitFiles(files, message) {
      git(['checkout', 'main'], seed);
      git(['pull', '--ff-only', 'origin', 'main'], seed);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(seed, path)), { recursive: true });
        writeFileSync(join(seed, path), content, 'utf8');
      }
      git(['add', '--', ...Object.keys(files)], seed);
      git(['commit', '-m', message], seed);
      git(['push', 'origin', 'main'], seed);
      return git(['rev-parse', 'main'], seed);
    },
    deleteFiles(paths, message) {
      git(['checkout', 'main'], seed);
      git(['pull', '--ff-only', 'origin', 'main'], seed);
      git(['rm', '--', ...paths], seed);
      git(['commit', '-m', message], seed);
      git(['push', 'origin', 'main'], seed);
      return git(['rev-parse', 'main'], seed);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function stateAt(file: string): OrchestratorState {
  const store = new StateStore(file);
  return store.load();
}

function revisions(state: OrchestratorState, reqId: string): DispatchRevision[] {
  return state.dispatchRevisions?.[reqId] ?? [];
}

test('真实 Git/模拟 GitHub：追平游标也独立首接原卡，重启 replay 不重复发布并保留交接正文', async () => {
  const fixture = createFixture();
  try {
    await fixture.run();
    const first = stateAt(fixture.stateFile);
    assert.equal(first.requirements[PANEL_REQ_ID]?.issueNumber, PANEL_ISSUE);
    assert.deepEqual(revisions(first, PANEL_REQ_ID).map((revision) => revision.revision), [1]);
    assert.equal(fixture.github.created.some((issue) => issue.title.includes(PANEL_REQ_ID)), false);
    assert.equal(fixture.github.updated.get(PANEL_ISSUE), 1);
    const issue = fixture.github.issues.get(PANEL_ISSUE)!;
    const explicitEntry = validateRegisteredPanelIssue({
      binding: fixture.panelBinding,
      issues: [issue],
      state: first,
    });
    assert.equal(explicitEntry.ok, true);
    if (explicitEntry.ok) assert.equal(explicitEntry.registered, true);
    assert.match(issue.body, /先保留本卡，不给旧调度器登记可领取状态。/);
    assert.match(issue.body, /需求来源为 `sunpcm\/spec-loop@[0-9a-f]{40}`/);
    assert.equal(fixture.github.comments.get(PANEL_ISSUE)?.length, 1);

    const updatesBeforeReplay = fixture.github.updated.get(PANEL_ISSUE);
    const commentsBeforeReplay = fixture.github.comments.get(PANEL_ISSUE)?.length;
    await fixture.run();
    const replayed = stateAt(fixture.stateFile);
    assert.deepEqual(revisions(replayed, PANEL_REQ_ID).map((revision) => revision.revision), [1]);
    assert.equal(fixture.github.updated.get(PANEL_ISSUE), updatesBeforeReplay);
    assert.equal(fixture.github.comments.get(PANEL_ISSUE)?.length, commentsBeforeReplay);
  } finally {
    fixture.cleanup();
  }
});

test('面板来源按代码标记字段核对，列表排版和任意连接文案仍可首次接续', async () => {
  const fixture = createFixture();
  try {
    fixture.github.issues.get(PANEL_ISSUE)!.body = [
      '## 交接资料',
      '',
      `- 代码来源 \`${fixture.panelBinding.repo}@${fixture.panelBinding.confirmedMainSha}\``,
      `- 文件位置 \`${PANEL_SPEC_PATH}\``,
      `- 当前哈希 \`${fixture.panelBinding.specHash}\``,
      '',
      '按列表填写，不依赖固定中文句式。',
    ].join('\n');
    await fixture.run();
    const state = stateAt(fixture.stateFile);
    assert.equal(state.requirements[PANEL_REQ_ID]?.issueNumber, PANEL_ISSUE);
    assert.deepEqual(revisions(state, PANEL_REQ_ID).map((revision) => revision.revision), [1]);
  } finally {
    fixture.cleanup();
  }
});

test('未启用 PanelBinding 时面板文件不登记、不回退旧处理，其他需求仍独立对账', async () => {
  const fixture = createFixture();
  try {
    const sha = fixture.commitFiles({
      [COUNTER_SPEC_PATH]: counterDoc('未绑定轮次增加计数器功能。', '未绑定轮次计数器验收。'),
      [PANEL_SPEC_PATH]: panelDoc('未绑定轮次的面板改动。', '未绑定轮次面板验收。'),
    }, 'counter and panel change without panel binding');
    const issueBefore = structuredClone(fixture.github.issues.get(PANEL_ISSUE)!);
    await fixture.run({ panelBinding: false });
    const state = stateAt(fixture.stateFile);
    assert.equal(state.requirements[PANEL_REQ_ID], undefined);
    assert.deepEqual(revisions(state, PANEL_REQ_ID), []);
    assert.deepEqual(fixture.github.issues.get(PANEL_ISSUE), issueBefore);
    assert.equal(fixture.github.created.length, 1);
    assert.match(fixture.github.created[0]!.title, new RegExp(`\\[${COUNTER_REQ_ID}\\]`));
    assert.equal(state.requirements[COUNTER_REQ_ID]?.sourceMainSha, sha);
  } finally {
    fixture.cleanup();
  }
});

test('多卡、错号或错来源只阻断面板，不阻止其他需求写入', async () => {
  {
    const fixture = createFixture();
    try {
      fixture.commitFiles({
        [COUNTER_SPEC_PATH]: counterDoc('多卡场景的计数器改动。', '多卡场景计数器验收。'),
        [PANEL_SPEC_PATH]: panelDoc('多卡场景的面板改动。', '多卡场景面板验收。'),
      }, 'counter and panel with ambiguous cards');
      fixture.github.issues.set(20, {
        number: 20,
        title: `[${PANEL_REQ_ID}] 另一张面板卡`,
        body: '另一张卡',
        state: 'open',
        labels: [],
        meta: null,
      });
      const issueBefore = structuredClone(fixture.github.issues.get(PANEL_ISSUE)!);
      await fixture.run();
      const state = stateAt(fixture.stateFile);
      assert.equal(state.requirements[PANEL_REQ_ID], undefined);
      assert.deepEqual(fixture.github.issues.get(PANEL_ISSUE), issueBefore);
      assert.equal(fixture.github.created.length, 1);
      assert.match(fixture.github.created[0]!.title, new RegExp(`\\[${COUNTER_REQ_ID}\\]`));
    } finally {
      fixture.cleanup();
    }
  }

  {
    const fixture = createFixture();
    try {
      fixture.commitFiles({
        [COUNTER_SPEC_PATH]: counterDoc('错来源场景的计数器改动。', '错来源场景计数器验收。'),
      }, 'counter with wrong panel source');
      const wrong = fixture.github.issues.get(PANEL_ISSUE)!;
      wrong.body = wrong.body.replace(
        new RegExp(fixture.panelBinding.confirmedMainSha),
        '0'.repeat(40),
      );
      const issueBefore = structuredClone(wrong);
      await fixture.run();
      const state = stateAt(fixture.stateFile);
      assert.equal(state.requirements[PANEL_REQ_ID], undefined);
      assert.deepEqual(fixture.github.issues.get(PANEL_ISSUE), issueBefore);
      assert.equal(fixture.github.created.length, 1);
    } finally {
      fixture.cleanup();
    }
  }

  {
    const fixture = createFixture();
    try {
      fixture.commitFiles({
        [COUNTER_SPEC_PATH]: counterDoc('错号场景的计数器改动。', '错号场景计数器验收。'),
      }, 'counter with wrong panel issue number');
      fixture.github.issues.delete(PANEL_ISSUE);
      fixture.github.issues.set(20, {
        number: 20,
        title: `[${PANEL_REQ_ID}] 编号不匹配的面板卡`,
        body: ordinaryPanelBody(fixture.panelBinding),
        state: 'open',
        labels: [],
        meta: null,
      });
      const issueBefore = structuredClone(fixture.github.issues.get(20)!);
      await fixture.run();
      const state = stateAt(fixture.stateFile);
      assert.equal(state.requirements[PANEL_REQ_ID], undefined);
      assert.deepEqual(fixture.github.issues.get(20), issueBefore);
      assert.equal(fixture.github.created.length, 1);
      assert.match(fixture.github.created[0]!.title, new RegExp(`\\[${COUNTER_REQ_ID}\\]`));
    } finally {
      fixture.cleanup();
    }
  }
});

test('首次接续不能只凭可编辑 meta.reqId 跳过正文来源锚点', async () => {
  const fixture = createFixture();
  try {
    const issue = fixture.github.issues.get(PANEL_ISSUE)!;
    issue.body = '这张卡只有可伪造的受管元数据，没有首次接续来源句。';
    issue.meta = {
      schema: 1,
      system: 'spec-loop',
      kind: 'requirement',
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash: fixture.panelBinding.specHash,
    };
    const issueBefore = structuredClone(issue);
    await fixture.run();
    const state = stateAt(fixture.stateFile);
    assert.equal(state.requirements[PANEL_REQ_ID], undefined);
    assert.deepEqual(revisions(state, PANEL_REQ_ID), []);
    assert.deepEqual(fixture.github.issues.get(PANEL_ISSUE), issueBefore);
    const explicitEntry = validateRegisteredPanelIssue({
      binding: fixture.panelBinding,
      issues: [issueBefore],
      state,
    });
    assert.equal(explicitEntry.ok, false);
  } finally {
    fixture.cleanup();
  }
});

test('首次接续的来源字段出现冲突值时 fail closed，不登记也不更新原卡', async () => {
  const fixture = createFixture();
  try {
    const issue = fixture.github.issues.get(PANEL_ISSUE)!;
    const conflictingHash = fixture.panelBinding.specHash === 'f'.repeat(64)
      ? 'e'.repeat(64)
      : 'f'.repeat(64);
    issue.body = `${issue.body}\n\n- 失效哈希 \`${conflictingHash}\``;
    const issueBefore = structuredClone(issue);
    await fixture.run();
    const state = stateAt(fixture.stateFile);
    assert.equal(state.requirements[PANEL_REQ_ID], undefined);
    assert.deepEqual(revisions(state, PANEL_REQ_ID), []);
    assert.deepEqual(fixture.github.issues.get(PANEL_ISSUE), issueBefore);
  } finally {
    fixture.cleanup();
  }
});

test('其他需求卡引用同一来源句不能被当作面板卡或阻断正确原卡', async () => {
  const fixture = createFixture();
  try {
    fixture.github.issues.set(20, {
      number: 20,
      title: `[${COUNTER_REQ_ID}] 碰巧引用面板来源的计数器卡`,
      body: ordinaryPanelBody(fixture.panelBinding),
      state: 'open',
      labels: [],
      meta: { reqId: COUNTER_REQ_ID },
    });
    await fixture.run();
    const state = stateAt(fixture.stateFile);
    assert.equal(state.requirements[PANEL_REQ_ID]?.issueNumber, PANEL_ISSUE);
    assert.deepEqual(revisions(state, PANEL_REQ_ID).map((revision) => revision.revision), [1]);
  } finally {
    fixture.cleanup();
  }
});

test('旧面板 r1 已冻结后出现多卡，面板从本轮 Worker 候选中剔除且零派发', async () => {
  const fixture = createFixture();
  try {
    await fixture.run();
    const store = new StateStore(fixture.stateFile);
    store.load();
    await store.update((state) => {
      state.dispatchRevisions![PANEL_REQ_ID]![0]!.grant = {
        eventId: 701,
        actorId: '42',
        grantedAt: new Date().toISOString(),
      };
      return undefined;
    });
    fixture.github.issues.set(20, {
      number: 20,
      title: `[${PANEL_REQ_ID}] 重复面板卡`,
      body: ordinaryPanelBody(fixture.panelBinding),
      state: 'open',
      labels: [],
      meta: null,
    });
    const updatesBefore = fixture.github.updated.get(PANEL_ISSUE);
    const commentsBefore = fixture.github.comments.get(PANEL_ISSUE)?.length;
    fixture.commitFiles({
      [PANEL_SPEC_PATH]: panelDoc('歧义出现后的 r2。', '歧义场景 r2 验收。'),
    }, 'panel r2 with ambiguous card');

    const summary = await fixture.run();
    assert.ok(summary);
    assert.equal(summary.specs.some((spec) => spec.id === PANEL_REQ_ID), false);
    const state = stateAt(fixture.stateFile);
    const panelTargets = pickWorkerTargets(state, summary.specs)
      .filter((target) => target.reqId === PANEL_REQ_ID);
    assert.deepEqual(panelTargets, []);
    assert.equal(fixture.github.updated.get(PANEL_ISSUE), updatesBefore);
    assert.equal(fixture.github.comments.get(PANEL_ISSUE)?.length, commentsBefore);
  } finally {
    fixture.cleanup();
  }
});

test('r2 同卡改版和离线 A→B→A 升版，旧标签与旧许可均不沿用', async () => {
  const fixture = createFixture();
  try {
    await fixture.run();
    fixture.github.addLabelByUser(PANEL_ISSUE, '可开工/r1');
    const store = new StateStore(fixture.stateFile);
    store.load();
    await store.update((state) => {
      state.dispatchRevisions![PANEL_REQ_ID]![0]!.grant = {
        eventId: 501,
        actorId: '42',
        grantedAt: new Date().toISOString(),
      };
      return undefined;
    });

    const r2Doc = panelDoc('r2 增加等待证据。', 'r2 面板验收。');
    fixture.commitFiles({ [PANEL_SPEC_PATH]: r2Doc }, 'panel r2');
    await fixture.run();
    let state = stateAt(fixture.stateFile);
    assert.deepEqual(revisions(state, PANEL_REQ_ID).map((revision) => revision.revision), [1, 2]);
    assert.equal(revisions(state, PANEL_REQ_ID)[0]!.grant, undefined);
    assert.equal(revisions(state, PANEL_REQ_ID)[1]!.grant, undefined);
    assert.equal(fixture.github.issues.get(PANEL_ISSUE)!.labels.includes('可开工/r1'), false);
    assert.equal(fixture.github.issues.get(PANEL_ISSUE)!.labels.includes('可开工/r2'), false);

    fixture.github.addLabelByUser(PANEL_ISSUE, '可开工/r2');
    const currentStore = new StateStore(fixture.stateFile);
    currentStore.load();
    await currentStore.update((current) => {
      current.dispatchRevisions![PANEL_REQ_ID]![1]!.grant = {
        eventId: 502,
        actorId: '42',
        grantedAt: new Date().toISOString(),
      };
      return undefined;
    });
    fixture.commitFiles({
      [PANEL_SPEC_PATH]: panelDoc('离线中间版本 B。', '中间版本 B 验收。'),
    }, 'panel offline B');
    const finalSha = fixture.commitFiles(
      { [PANEL_SPEC_PATH]: r2Doc },
      'panel offline A again',
    );
    await fixture.run();
    state = stateAt(fixture.stateFile);
    assert.deepEqual(
      revisions(state, PANEL_REQ_ID).map((revision) => revision.revision),
      [1, 2, 3],
    );
    assert.equal(revisions(state, PANEL_REQ_ID)[1]!.grant, undefined);
    assert.equal(revisions(state, PANEL_REQ_ID)[2]!.sourceMainSha, finalSha);
    assert.equal(fixture.github.issues.get(PANEL_ISSUE)!.labels.includes('可开工/r2'), false);
    assert.equal(fixture.github.issues.get(PANEL_ISSUE)!.labels.includes('可开工/r3'), false);
  } finally {
    fixture.cleanup();
  }
});

test('r1 后整文件删除再原样恢复不得领取旧许可，并发布来源正确的新版本', async () => {
  const fixture = createFixture();
  try {
    const originalPanel = panelDoc('初始面板说明。', '初始面板验收。');
    await fixture.run();
    fixture.github.addLabelByUser(PANEL_ISSUE, '可开工/r1');
    const store = new StateStore(fixture.stateFile);
    store.load();
    await store.update((state) => {
      state.dispatchRevisions![PANEL_REQ_ID]![0]!.grant = {
        eventId: 801,
        actorId: '42',
        grantedAt: new Date().toISOString(),
      };
      return undefined;
    });

    const deletedSha = fixture.deleteFiles([PANEL_SPEC_PATH], 'delete panel spec after r1');
    const deletionSummary = await fixture.run();
    assert.ok(deletionSummary);
    assert.equal(deletionSummary.specs.some((spec) => spec.id === PANEL_REQ_ID), false);
    let state = stateAt(fixture.stateFile);
    assert.equal(state.cursorMainSha, deletedSha);
    assert.deepEqual(revisions(state, PANEL_REQ_ID).map((revision) => revision.revision), [1]);
    assert.deepEqual(
      pickWorkerTargets(state, deletionSummary.specs)
        .filter((target) => target.reqId === PANEL_REQ_ID),
      [],
    );

    const restoredSha = fixture.commitFiles(
      { [PANEL_SPEC_PATH]: originalPanel },
      'restore byte-identical panel spec',
    );
    await fixture.run();
    state = stateAt(fixture.stateFile);
    const panelRevisions = revisions(state, PANEL_REQ_ID);
    assert.deepEqual(panelRevisions.map((revision) => revision.revision), [1, 2]);
    assert.equal(panelRevisions[0]!.grant, undefined);
    assert.equal(panelRevisions[1]!.grant, undefined);
    assert.equal(panelRevisions[1]!.specHash, panelRevisions[0]!.specHash);
    assert.equal(panelRevisions[1]!.sourceMainSha, restoredSha);
    assert.equal(state.requirements[PANEL_REQ_ID]?.sourceMainSha, restoredSha);
    assert.equal(fixture.github.issues.get(PANEL_ISSUE)!.labels.includes('可开工/r1'), false);
    assert.equal(fixture.github.issues.get(PANEL_ISSUE)!.labels.includes('可开工/r2'), false);
  } finally {
    fixture.cleanup();
  }
});

test('计数器与面板在同一主线轮次分别发布，版本和 Issue 相互独立', async () => {
  const fixture = createFixture();
  try {
    fixture.commitFiles({
      [COUNTER_SPEC_PATH]: counterDoc('两个需求同时改动。', '计数器独立验收。'),
      [PANEL_SPEC_PATH]: panelDoc('两个需求同时改动的面板版本。', '面板独立验收。'),
    }, 'counter and panel versions together');
    await fixture.run();
    const state = stateAt(fixture.stateFile);
    assert.deepEqual(revisions(state, COUNTER_REQ_ID).map((revision) => revision.revision), [1]);
    assert.deepEqual(revisions(state, PANEL_REQ_ID).map((revision) => revision.revision), [1]);
    assert.notEqual(
      state.requirements[COUNTER_REQ_ID]?.issueNumber,
      state.requirements[PANEL_REQ_ID]?.issueNumber,
    );
    assert.equal(state.requirements[PANEL_REQ_ID]?.issueNumber, PANEL_ISSUE);
    assert.equal(fixture.github.created.length, 1);
    assert.match(fixture.github.created[0]!.title, new RegExp(`\\[${COUNTER_REQ_ID}\\]`));
  } finally {
    fixture.cleanup();
  }
});
