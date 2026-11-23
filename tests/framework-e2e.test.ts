import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  parseE2eContract,
  resolveBrowserCacheDir,
  runBrowserGate,
  verifyCounterContract,
  verifyPanelAcceptanceCoverage,
  type BrowserGateRunner,
} from '../orchestrator/browser-gate.ts';
import { loadConfig, type Config } from '../orchestrator/config.ts';
import {
  deliveryProfile,
  type PanelBinding,
} from '../orchestrator/delivery-profile.ts';
import type { DispatchLabelEvent } from '../orchestrator/dispatch-grant.ts';
import {
  encodeMetaBlock,
  extractMeta,
  type GithubClient,
} from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { createCore, runOnce, type Core } from '../orchestrator/runtime.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import type {
  DispatchRevision,
  ManagedIssue,
  ManagedPR,
  OrchestratorState,
} from '../orchestrator/types.ts';
import { emptyState } from '../orchestrator/types.ts';
import type { WorkerInput, WorkerOutcome } from '../orchestrator/worker.ts';
import { PANEL_CASE_IDS } from './e2e/panel-case-ids.ts';

const REPO = 'sunpcm/spec-loop';
const REPOSITORY_ID = 'github-repository-id:9001';
const PANEL_REQ_ID = 'REQ-PANEL-01';
const PANEL_SPEC_PATH = 'docs/specs/pending/panel.md';
const ALLOWED_USER_ID = '42';
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTROLLED_SMOKE_CASE_IDS = ['PANEL-DEMO-001'] as const;
const CONTROLLED_ACCEPTANCE_CASES = {
  A1: ['PANEL-ACCEPTANCE-A1'],
  A2: ['PANEL-ACCEPTANCE-A2'],
  A3: ['PANEL-ACCEPTANCE-A3'],
  A4: ['PANEL-ACCEPTANCE-A4'],
  A5: ['PANEL-ACCEPTANCE-A5'],
  // 一个真实浏览器场景可以同时覆盖多条验收；各 A 映射之间不要求 caseId 互斥。
  A6: ['PANEL-ACCEPTANCE-A6-A8'],
  A7: ['PANEL-ACCEPTANCE-A7'],
  A8: ['PANEL-ACCEPTANCE-A6-A8'],
} as const;
const CONTROLLED_PANEL_SPEC = `# 受控面板框架测试

### [REQ-PANEL-01] 受控面板框架集成

#### 功能

- 本段只用于验证契约、来源绑定和业务门禁，不代表 #19 的产品界面实现。

#### 验收

- A1 受控规格的首条验收必须由映射后的真实 caseId 覆盖。
- A2 受控规格的第二条验收必须由映射后的真实 caseId 覆盖。
- A3 受控规格的第三条验收必须由映射后的真实 caseId 覆盖。
- A4 受控规格的第四条验收必须由映射后的真实 caseId 覆盖。
- A5 受控规格的第五条验收必须由映射后的真实 caseId 覆盖。
- A6 受控规格的第六条验收必须由映射后的真实 caseId 覆盖。
- A7 受控规格的第七条验收必须由映射后的真实 caseId 覆盖。
- A8 受控规格的第八条验收必须由映射后的真实 caseId 覆盖。
`;
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
  labelEventReadFailures = 0;
  private nextPRNumber = 40;
  private nextEventId = 500;
  private nextCommentId = 900;
  private clock = Date.now();

  getDispatchRepositoryId(): string {
    return REPOSITORY_ID;
  }

  async getDispatchIssue(number: number): Promise<ManagedIssue> {
    return structuredClone(this.requireIssue(number));
  }

  async listDispatchLabelEvents(number: number): Promise<DispatchLabelEvent[]> {
    if (this.labelEventReadFailures > 0) {
      this.labelEventReadFailures -= 1;
      throw new Error('模拟 GitHub 标签事件读取失败');
    }
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
    const existing = comments.find(
      (comment) => comment.marker === marker || comment.body.includes(marker),
    );
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

  seedIssue(
    number: number,
    reqId: string,
    specPath: string,
    specHash: string,
    sourceMainSha: string,
    labels: string[] = [],
  ): void {
    const meta = {
      schema: 1,
      system: 'spec-loop',
      kind: 'requirement',
      reqId,
      specPath,
      specHash,
      sourceMainSha,
      operationKey: `${specHash}:${sourceMainSha}:requirement`,
    };
    const body = [
      `需求来源：\`${specPath}\``,
      `受信来源：\`${REPO}@${sourceMainSha}\``,
      `规格哈希：\`${specHash}\``,
      '',
      encodeMetaBlock(meta),
    ].join('\n');
    this.issues.set(number, {
      number,
      title: `[${reqId}] 已确认需求`,
      body,
      state: 'open',
      labels: [...labels],
      meta: extractMeta(body),
      url: `https://github.com/${REPO}/issues/${number}`,
    });
  }

  addLabelByUser(number: number, name: string, actorId: string): void {
    const issue = this.requireIssue(number);
    if (!issue.labels.includes(name)) issue.labels.push(name);
    this.appendLabelEvent(number, name, actorId, 'labeled');
  }

  removeLabelByUser(number: number, name: string, actorId: string): void {
    const issue = this.requireIssue(number);
    issue.labels = issue.labels.filter((label) => label !== name);
    this.appendLabelEvent(number, name, actorId, 'unlabeled');
  }

  appendEarlyLabelEvent(number: number, name: string, actorId: string): void {
    const events = this.labelEvents.get(number) ?? [];
    events.push({
      id: this.nextEventId++,
      actorId,
      name,
      event: 'labeled',
      createdAt: new Date(this.clock - 60_000).toISOString(),
    });
    this.labelEvents.set(number, events);
  }

  async listIssues(): Promise<ManagedIssue[]> {
    return [...this.issues.values()].map((issue) => structuredClone(issue));
  }

  async listPRs(): Promise<ManagedPR[]> {
    return [...this.prs.values()].map((pr) => structuredClone(pr));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const number = Math.max(2000, ...this.issues.keys()) + 1;
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
      userId: REPOSITORY_ID,
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
    return [
      issue.body,
      ...(this.comments.get(number) ?? []).map((comment) => comment.body),
    ].join('\n');
  }

  private requireIssue(number: number): ManagedIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`未知 Issue #${number}`);
    return issue;
  }

  private appendLabelEvent(
    number: number,
    name: string,
    actorId: string,
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

interface GitFlowFixture {
  root: string;
  remote: string;
  seed: string;
  controller: string;
  mainSha: string;
  sourceTreeSha: string;
  panelSpec: string;
  panelSpecHash: string;
  github: PersistentDispatchGithub;
  workerInputs: WorkerInput[];
  logs: string[];
  core: Core;
  newCore(): Core;
  restart(): void;
  cleanup(): void;
}

function git(args: string[], cwd: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Spec Loop Test',
    GIT_AUTHOR_EMAIL: 'spec-loop-test@example.invalid',
    GIT_COMMITTER_NAME: 'Spec Loop Test',
    GIT_COMMITTER_EMAIL: 'spec-loop-test@example.invalid',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
  }).trim();
}

function readAuthoritativePanelSpec(): string | null {
  const path = join(REPO_ROOT, PANEL_SPEC_PATH);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function panelSpecIdentity(content: string): { specHash: string; specBody: string } {
  const parsed = parseSpecs({ [PANEL_SPEC_PATH]: content });
  assert.deepEqual(parsed.errors, []);
  const spec = parsed.specs.find((candidate) => candidate.id === PANEL_REQ_ID);
  assert.ok(spec);
  return { specHash: spec.hash, specBody: spec.body };
}

function writeControlledPanelE2eRoot(root: string, contract: Record<string, unknown>): void {
  mkdirSync(join(root, 'tests', 'e2e', 'contracts'), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(
    join(root, 'playwright.config.ts'),
    readFileSync(join(REPO_ROOT, 'playwright.config.ts'), 'utf8'),
    'utf8',
  );
  const caseIds = Array.isArray(contract.caseIds)
    ? contract.caseIds.filter((caseId): caseId is string => typeof caseId === 'string')
    : [];
  const suite = [
    "import { expect, test } from '@playwright/test';",
    ...caseIds.map((caseId) => [
      `test(${JSON.stringify(`${caseId} fixture`)}, async ({ page }) => {`,
      "  const response = await page.goto('./');",
      "  expect(response?.status()).toBe(200);",
      "  await expect(page).toHaveTitle('panel candidate');",
      '});',
    ].join('\n')),
  ].join('\n');
  writeFileSync(
    join(root, 'tests', 'e2e', 'panel.spec.ts'),
    `${suite}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'tests', 'e2e', 'contracts', 'panel.json'),
    `${JSON.stringify(contract, null, 2)}\n`,
    'utf8',
  );
}

function makePanelBinding(
  confirmedMainSha: string,
  specHash: string,
  issueNumber: number,
): PanelBinding {
  return {
    repo: REPO,
    mainBranch: 'main',
    repositoryId: REPOSITORY_ID,
    issueNumber,
    confirmedMainSha,
    specHash,
  };
}

function installGithub(
  core: Core,
  github: PersistentDispatchGithub,
  logger: Logger = SILENT_LOGGER,
): void {
  const client = github as unknown as GithubClient;
  core.github = client;
  core.workerDeps.github = client;
  core.deployDeps.github = client;
  core.reconcileContext.github = client;
  core.specIntakeDeps.github = client;
  if (core.retryBaselineDeps) core.retryBaselineDeps.github = client;

  core.logger = logger;
  core.workerDeps.logger = logger;
  core.deployDeps.logger = logger;
  core.reconcileContext.logger = logger;
  core.specIntakeDeps.logger = logger;
  if (core.retryBaselineDeps) core.retryBaselineDeps.logger = logger;
}

async function createGitFlowFixture(): Promise<GitFlowFixture> {
  const panelSpec = CONTROLLED_PANEL_SPEC;
  const { specHash: panelSpecHash } = panelSpecIdentity(panelSpec);
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-framework-e2e-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const controller = join(root, 'controller');
  git(['init', '--bare', '--initial-branch=main', remote], root);
  git(['clone', remote, seed], root);
  git(['config', 'user.name', 'Spec Loop Test'], seed);
  git(['config', 'user.email', 'spec-loop-test@example.invalid'], seed);
  mkdirSync(join(seed, 'docs', 'specs', 'pending'), { recursive: true });
  writeFileSync(join(seed, PANEL_SPEC_PATH), panelSpec, 'utf8');
  git(['add', PANEL_SPEC_PATH], seed);
  git(['commit', '-m', 'seed confirmed panel requirement'], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['clone', remote, controller], root);
  const mainSha = git(['rev-parse', 'main'], seed);
  const sourceTreeSha = git(['rev-parse', `${mainSha}^{tree}`], seed);

  const github = new PersistentDispatchGithub();
  const issueNumber = 1901;
  github.seedIssue(
    issueNumber,
    PANEL_REQ_ID,
    PANEL_SPEC_PATH,
    panelSpecHash,
    mainSha,
    ['可开工/r1'],
  );
  github.appendEarlyLabelEvent(issueNumber, '可开工/r1', ALLOWED_USER_ID);
  const unrelatedIssueNumber = 1902;
  github.seedIssue(
    unrelatedIssueNumber,
    'REQ-OTHER-01',
    PANEL_SPEC_PATH,
    panelSpecHash,
    mainSha,
  );
  github.addLabelByUser(unrelatedIssueNumber, '可开工/r1', ALLOWED_USER_ID);

  const config = loadConfig(controller);
  Object.assign(config, {
    repo: REPO,
    repoDir: controller,
    dispatchAllowedUserIds: [ALLOWED_USER_ID],
    panelBinding: makePanelBinding(mainSha, panelSpecHash, issueNumber),
    piProvider: '',
    piModel: '',
    pollIntervalMs: 0,
  } satisfies Partial<Config>);
  writeFileSync(
    config.stateFile,
    JSON.stringify({
      ...emptyState(),
      repo: REPO,
      cursorMainSha: mainSha,
    }, null, 2),
    'utf8',
  );

  const workerInputs: WorkerInput[] = [];
  const logs: string[] = [];
  const fixtureLogger: Logger = {
    info(message) {
      logs.push(`INFO ${message}`);
    },
    warn(message) {
      logs.push(`WARN ${message}`);
    },
    error(message) {
      logs.push(`ERROR ${message}`);
    },
    debug(message) {
      logs.push(`DEBUG ${message}`);
    },
  };
  const makeCore = (): Core => {
    const core = createCore(config, REPO);
    installGithub(core, github, fixtureLogger);
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

  const fixture: GitFlowFixture = {
    root,
    remote,
    seed,
    controller,
    mainSha,
    sourceTreeSha,
    panelSpec,
    panelSpecHash,
    github,
    workerInputs,
    logs,
    core: makeCore(),
    newCore: makeCore,
    restart() {
      fixture.core = makeCore();
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

function panelRevisions(state: OrchestratorState): DispatchRevision[] {
  return state.dispatchRevisions?.[PANEL_REQ_ID] ?? [];
}

function playwrightReport(caseIds: readonly string[]): unknown {
  return {
    suites: [
      {
        title: 'panel',
        specs: caseIds.map((caseId) => ({
          title: `${caseId} fixture`,
          tests: [
            {
              projectName: 'panel',
              status: 'expected',
              expectedStatus: 'passed',
              results: [
                {
                  status: 'passed',
                  retry: 0,
                  duration: 1,
                  attachments: [],
                },
              ],
            },
          ],
        })),
        suites: [],
      },
    ],
    errors: [],
  };
}

function fakeBrowserRunner(caseIds: readonly string[], expectedBody?: string): BrowserGateRunner {
  return async (opts) => {
    const baseResponse = await fetch(opts.env.SPEC_LOOP_E2E_BASE_URL!);
    if (baseResponse.status !== 200) {
      return {
        code: 1,
        stdout: '',
        stderr: `候选产物返回 ${baseResponse.status}`,
        timedOut: false,
      };
    }
    if (expectedBody !== undefined) {
      const body = await baseResponse.text();
      if (!body.includes(expectedBody)) {
        return {
          code: 1,
          stdout: '',
          stderr: `候选产物未包含预期内容：${expectedBody}`,
          timedOut: false,
        };
      }
    }
    const reportDir = opts.env.SPEC_LOOP_E2E_REPORT_DIR!;
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'results.json'),
      JSON.stringify(playwrightReport(caseIds)),
      'utf8',
    );
    return { code: 0, stdout: 'fixture pass\n', stderr: '', timedOut: false };
  };
}

test('deliveryProfile 精确选择内置计数器或显式面板，未知需求不猜测', () => {
  const binding = makePanelBinding(
    '4'.repeat(40),
    '1'.repeat(64),
    1901,
  );
  assert.deepEqual(deliveryProfile('REQ-CNT-01', binding), {
    reqId: 'REQ-CNT-01',
    specPath: 'docs/specs/counter.md',
    sourceDir: 'src',
    project: 'counter',
    buildScript: 'build',
  });
  assert.deepEqual(deliveryProfile(PANEL_REQ_ID, binding), {
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    sourceDir: 'panel/src',
    project: 'panel',
    buildScript: 'build:panel',
  });
  assert.equal(deliveryProfile(PANEL_REQ_ID), undefined);
  assert.equal(deliveryProfile('REQ-UNKNOWN-01', binding), undefined);
});

test('面板受信配置只接受有效的 github-repository-id 数字绑定', () => {
  const binding = makePanelBinding(
    '4'.repeat(40),
    '1'.repeat(64),
    1901,
  );
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-panel-binding-'));
  const previousBinding = process.env.SPEC_LOOP_PANEL_BINDING;
  const previousEnvFile = process.env.SPEC_LOOP_ENV_FILE;
  try {
    delete process.env.SPEC_LOOP_ENV_FILE;
    process.env.SPEC_LOOP_PANEL_BINDING = JSON.stringify(binding);
    assert.deepEqual(loadConfig(root).panelBinding, binding);

    process.env.SPEC_LOOP_PANEL_BINDING = JSON.stringify({
      ...binding,
      repositoryId: 'github-repository-id:not-a-number',
    });
    assert.throws(
      () => loadConfig(root),
      /SPEC_LOOP_PANEL_BINDING.*字段非法/,
    );
  } finally {
    if (previousBinding === undefined) {
      delete process.env.SPEC_LOOP_PANEL_BINDING;
    } else {
      process.env.SPEC_LOOP_PANEL_BINDING = previousBinding;
    }
    if (previousEnvFile === undefined) {
      delete process.env.SPEC_LOOP_ENV_FILE;
    } else {
      process.env.SPEC_LOOP_ENV_FILE = previousEnvFile;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('panel 契约由单一哈希维护，权威文档存在时独立复算，缺失时仍运行受控正负例', () => {
  const rawContract = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tests/e2e/contracts/panel.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(rawContract.reqId, PANEL_REQ_ID);
  assert.equal(rawContract.specPath, PANEL_SPEC_PATH);
  assert.match(String(rawContract.specHash), /^[0-9a-f]{64}$/);
  assert.deepEqual(rawContract.caseIds, [...PANEL_CASE_IDS]);
  assert.equal(
    rawContract.acceptanceCases,
    undefined,
    '真实冒烟契约不得伪造尚不存在的 #19 A1～A8 映射',
  );

  const contract = parseE2eContract(rawContract, 'panel');
  assert.equal(contract.reqId, PANEL_REQ_ID);
  assert.equal(contract.specPath, PANEL_SPEC_PATH);
  assert.deepEqual(contract.caseIds, [...PANEL_CASE_IDS]);

  const authoritative = readAuthoritativePanelSpec();
  if (authoritative !== null) {
    const confirmed = panelSpecIdentity(authoritative);
    assert.equal(contract.specHash, confirmed.specHash);
    assert.equal(
      verifyCounterContract(contract, { [PANEL_SPEC_PATH]: authoritative }, PANEL_REQ_ID).ok,
      true,
    );
  }

  const controlled = panelSpecIdentity(CONTROLLED_PANEL_SPEC);
  const controlledContract = {
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash: controlled.specHash,
    caseIds: [
      ...CONTROLLED_SMOKE_CASE_IDS,
      ...new Set(Object.values(CONTROLLED_ACCEPTANCE_CASES).flat()),
    ],
    acceptanceCases: CONTROLLED_ACCEPTANCE_CASES,
  };
  const parsedControlled = parseE2eContract(controlledContract, 'panel') as typeof contract & {
    acceptanceCases?: Record<string, string[]>;
  };
  assert.deepEqual(parsedControlled.acceptanceCases, CONTROLLED_ACCEPTANCE_CASES);
  assert.equal(
    parsedControlled.acceptanceCases?.A6?.[0],
    parsedControlled.acceptanceCases?.A8?.[0],
  );
  assert.throws(
    () => parseE2eContract({
      ...controlledContract,
      acceptanceCases: { A1: [], A2: ['PANEL-ACCEPTANCE-A2'], A3: ['PANEL-ACCEPTANCE-A3'] },
    }, 'panel'),
    /acceptanceCases|A1|非空/,
  );
  assert.throws(
    () => parseE2eContract({
      ...controlledContract,
      acceptanceCases: {
        ...CONTROLLED_ACCEPTANCE_CASES,
        A8: ['PANEL-ACCEPTANCE-NOT-IN-CASE-IDS'],
      },
    }, 'panel'),
    /acceptanceCases|caseIds|不在|未声明/,
  );
  assert.throws(
    () => parseE2eContract({
      ...controlledContract,
      acceptanceCases: {
        ...CONTROLLED_ACCEPTANCE_CASES,
        A8: [CONTROLLED_ACCEPTANCE_CASES.A8[0], CONTROLLED_ACCEPTANCE_CASES.A8[0]],
      },
    }, 'panel'),
    /acceptanceCases.*重复|重复.*caseId/,
  );

  const controlledFiles = { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC };
  assert.equal(
    verifyPanelAcceptanceCoverage(parsedControlled, controlledFiles, PANEL_REQ_ID).ok,
    true,
    '不同 A 复用同一真实 caseId 不应被当作互斥冲突',
  );
  assert.equal(
    verifyPanelAcceptanceCoverage({
      ...parsedControlled,
      caseIds: [...parsedControlled.caseIds, 'PANEL-ACCEPTANCE-A9'],
      acceptanceCases: {
        ...Object.fromEntries(
          Object.entries(CONTROLLED_ACCEPTANCE_CASES).map(([acceptanceId, caseIds]) => [
            acceptanceId,
            [...caseIds],
          ]),
        ),
        A9: ['PANEL-ACCEPTANCE-A9'],
      },
    }, controlledFiles, PANEL_REQ_ID).ok,
    false,
    '所选规格只含 A1..A8 时，额外 A9 必须 fail closed',
  );
  assert.equal(
    verifyCounterContract(parsedControlled, controlledFiles, PANEL_REQ_ID).ok,
    true,
  );
  assert.equal(
    verifyCounterContract({ ...parsedControlled, reqId: 'REQ-CNT-01' }, controlledFiles, 'REQ-CNT-01').ok,
    false,
  );
  assert.equal(
    verifyCounterContract(
      { ...parsedControlled, specPath: 'docs/specs/pending/other.md' },
      controlledFiles,
    ).ok,
    false,
  );
  assert.equal(
    verifyCounterContract(
      { ...parsedControlled, specHash: '0'.repeat(64) },
      controlledFiles,
      PANEL_REQ_ID,
    ).ok,
    false,
  );
  assert.equal(
    verifyCounterContract(parsedControlled, {
      [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC.replace('A3 受控规格', 'A3 错版规格'),
    }, PANEL_REQ_ID).ok,
    false,
  );
});

test('panel 生产业务门禁以 A1..An 覆盖 fail closed，手动冒烟保持可用（SPEC_LOOP_VERIFY 门控）', async (t) => {
  if (process.env.SPEC_LOOP_VERIFY !== '1') {
    t.skip('真实浏览器门禁集成仅在 SPEC_LOOP_VERIFY=1 主验收执行，避免 Worker verifier 尝试 listen');
    return;
  }

  const controlled = panelSpecIdentity(CONTROLLED_PANEL_SPEC);
  const acceptanceCaseIds = [...new Set(Object.values(CONTROLLED_ACCEPTANCE_CASES).flat())];
  const allBusinessCaseIds = [...CONTROLLED_SMOKE_CASE_IDS, ...acceptanceCaseIds];
  const businessContract = {
    reqId: PANEL_REQ_ID,
    specPath: PANEL_SPEC_PATH,
    specHash: controlled.specHash,
    caseIds: allBusinessCaseIds,
    acceptanceCases: CONTROLLED_ACCEPTANCE_CASES,
  };
  const temp = mkdtempSync(join(tmpdir(), 'spec-loop-panel-gate-'));
  const browserCacheDir = join(temp, 'browsers');
  try {
    mkdirSync(browserCacheDir, { recursive: true });
    const gateRepo = join(temp, 'gate-repo');
    mkdirSync(gateRepo, { recursive: true });
    git(['init', '--initial-branch=main', '.'], gateRepo);
    mkdirSync(join(gateRepo, 'dist'), { recursive: true });
    writeFileSync(join(gateRepo, 'dist', 'index.html'), '<!doctype html><title>panel source</title>', 'utf8');
    git(['add', 'dist/index.html'], gateRepo);
    git(['commit', '-m', 'source main'], gateRepo);
    const sourceMainSha = git(['rev-parse', 'HEAD'], gateRepo);
    const sourceTreeSha = git(['rev-parse', 'HEAD^{tree}'], gateRepo);

    mkdirSync(join(gateRepo, 'panel', 'src'), { recursive: true });
    writeFileSync(join(gateRepo, 'panel', 'src', 'candidate.ts'), 'export const candidate = true;\n', 'utf8');
    writeFileSync(join(gateRepo, 'dist', 'index.html'), '<!doctype html><title>panel candidate</title>', 'utf8');
    git(['add', 'dist/index.html', 'panel/src/candidate.ts'], gateRepo);
    git(['commit', '-m', 'candidate'], gateRepo);
    const candidateCommitSha = git(['rev-parse', 'HEAD'], gateRepo);
    const candidateTreeSha = git(['rev-parse', 'HEAD^{tree}'], gateRepo);
    const artifactDir = join(gateRepo, 'dist');

    const businessE2eRoot = join(temp, 'e2e-business');
    writeControlledPanelE2eRoot(businessE2eRoot, businessContract);
    const result = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: businessE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-fixture',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC },
      jobTmp: join(temp, 'job'),
      browserCacheDir,
      testRunsRoot: join(temp, 'test-runs'),
      evidenceStage: 'worker',
      jobId: 'panel-fixture',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(allBusinessCaseIds, 'panel candidate'),
    });

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.contract?.reqId, PANEL_REQ_ID);
    assert.equal(result.contract?.specPath, PANEL_SPEC_PATH);
    assert.equal(result.specHash, result.contract?.specHash);
    assert.deepEqual(result.executedCaseIds, allBusinessCaseIds);
    assert.deepEqual(
      (result.contract as typeof result.contract & {
        acceptanceCases?: Record<string, string[]>;
      })?.acceptanceCases,
      CONTROLLED_ACCEPTANCE_CASES,
    );
    assert.equal(result.testRunRecord?.reqId, PANEL_REQ_ID);
    assert.equal(result.testRunRecord?.specHash, result.contract?.specHash);
    assert.equal(result.testRunRecord?.sourceMainSha, sourceMainSha);
    assert.equal(result.testRunRecord?.candidateTreeSha, candidateTreeSha);
    assert.notEqual(sourceTreeSha, candidateTreeSha);
    assert.match(git(['show', '--format=', '--name-only', sourceMainSha], gateRepo), /dist\/index\.html/);
    assert.match(git(['show', '--format=', '--name-only', candidateCommitSha], gateRepo), /panel\/src\/candidate\.ts/);
    assert.equal(result.testRunRecord?.stage, 'worker');

    const buildResult = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: businessE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-fixture-build',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC },
      jobTmp: join(temp, 'job-build'),
      browserCacheDir,
      testRunsRoot: join(temp, 'test-runs-build'),
      evidenceStage: 'build',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(allBusinessCaseIds, 'panel candidate'),
    });
    assert.equal(buildResult.ok, true, buildResult.detail);
    assert.equal(buildResult.testRunRecord?.stage, 'build');
    assert.deepEqual(buildResult.executedCaseIds, allBusinessCaseIds);

    const actualBrowserResult = await runBrowserGate({
      // 受控套件通过链接复用当前受信 node_modules；真实 Node 解析会落到链接目标，
      // 因此隔离根必须包含该目标，不能只允许临时 e2eRoot/node_modules 别名。
      repoDir: REPO_ROOT,
      e2eRoot: businessE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-fixture-real-browser',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC },
      jobTmp: join(temp, 'job-real-browser'),
      browserCacheDir: resolveBrowserCacheDir(),
      testRunsRoot: join(temp, 'test-runs-real-browser'),
      evidenceStage: 'worker',
      jobId: 'panel-real-browser',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
    });
    assert.equal(actualBrowserResult.ok, true, actualBrowserResult.detail);
    assert.deepEqual(actualBrowserResult.executedCaseIds, allBusinessCaseIds);

    const wrongVersion = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: businessE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-fixture-wrong',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: {
        [PANEL_SPEC_PATH]: `${CONTROLLED_PANEL_SPEC}\n- A4 错版新增验收\n`,
      },
      jobTmp: join(temp, 'job-wrong'),
      browserCacheDir,
      testRunsRoot: join(temp, 'test-runs-wrong'),
      evidenceStage: 'worker',
      jobId: 'panel-fixture-wrong',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(allBusinessCaseIds),
    });
    assert.equal(wrongVersion.ok, false);
    assert.match(wrongVersion.detail, /specHash|验收基线|候选/);

    const authoritative = readAuthoritativePanelSpec();
    const realSmokeContract = authoritative === null
      ? {
          reqId: PANEL_REQ_ID,
          specPath: PANEL_SPEC_PATH,
          specHash: controlled.specHash,
          caseIds: [...CONTROLLED_SMOKE_CASE_IDS],
        }
      : JSON.parse(
          readFileSync(join(REPO_ROOT, 'tests/e2e/contracts/panel.json'), 'utf8'),
        ) as Record<string, unknown>;
    const realSmokeSpecFiles = {
      [PANEL_SPEC_PATH]: authoritative ?? CONTROLLED_PANEL_SPEC,
    };
    const smokeE2eRoot = join(temp, 'e2e-smoke');
    writeControlledPanelE2eRoot(smokeE2eRoot, realSmokeContract);
    const smokeCaseIds = Array.isArray(realSmokeContract.caseIds)
      ? realSmokeContract.caseIds as string[]
      : [];

    const manualSmoke = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: smokeE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-smoke',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: realSmokeSpecFiles,
      jobTmp: join(temp, 'job-smoke-manual'),
      browserCacheDir,
      evidenceStage: 'manual',
      unboundProductSmoke: true,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(smokeCaseIds, 'panel candidate'),
    });
    assert.equal(manualSmoke.ok, true, manualSmoke.detail);

    const businessRejectsSmoke = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: smokeE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-smoke-worker',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: realSmokeSpecFiles,
      jobTmp: join(temp, 'job-smoke-worker'),
      browserCacheDir,
      evidenceStage: 'worker',
      jobId: 'panel-smoke-worker',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(smokeCaseIds),
    });
    assert.equal(businessRejectsSmoke.ok, false);
    assert.match(businessRejectsSmoke.detail, /acceptanceCases|验收|A1/);

    const businessRejectsSmokeBuild = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: smokeE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-smoke-build',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: realSmokeSpecFiles,
      jobTmp: join(temp, 'job-smoke-build'),
      browserCacheDir,
      evidenceStage: 'build',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(smokeCaseIds),
    });
    assert.equal(businessRejectsSmokeBuild.ok, false);
    assert.match(businessRejectsSmokeBuild.detail, /acceptanceCases|验收|A1/);

    const partialAcceptanceCases = Object.fromEntries(
      Object.entries(CONTROLLED_ACCEPTANCE_CASES).filter(([key]) => key !== 'A8'),
    ) as unknown as Record<string, string[]>;
    const partialCaseIds: string[] = [
      ...CONTROLLED_SMOKE_CASE_IDS,
      ...Object.values(partialAcceptanceCases).flat(),
    ];
    const partialContract = {
      reqId: PANEL_REQ_ID,
      specPath: PANEL_SPEC_PATH,
      specHash: controlled.specHash,
      caseIds: partialCaseIds,
      acceptanceCases: partialAcceptanceCases,
    };
    const partialE2eRoot = join(temp, 'e2e-partial');
    writeControlledPanelE2eRoot(partialE2eRoot, partialContract);
    const partialMapping = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: partialE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-partial-acceptance',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC },
      jobTmp: join(temp, 'job-partial'),
      browserCacheDir,
      evidenceStage: 'worker',
      jobId: 'panel-partial-acceptance',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(partialCaseIds),
    });
    assert.equal(partialMapping.ok, false);
    assert.match(partialMapping.detail, /acceptanceCases|验收|A8/);

    const extraAcceptanceCases = {
      ...CONTROLLED_ACCEPTANCE_CASES,
      A9: ['PANEL-ACCEPTANCE-A9'],
    };
    const extraCaseIds = [...allBusinessCaseIds, 'PANEL-ACCEPTANCE-A9'];
    const extraMappingContract = {
      ...businessContract,
      caseIds: extraCaseIds,
      acceptanceCases: extraAcceptanceCases,
    };
    const extraE2eRoot = join(temp, 'e2e-extra');
    writeControlledPanelE2eRoot(extraE2eRoot, extraMappingContract);
    const extraMapping = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: extraE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-extra-acceptance',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC },
      jobTmp: join(temp, 'job-extra'),
      browserCacheDir,
      evidenceStage: 'worker',
      jobId: 'panel-extra-acceptance',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(extraCaseIds),
    });
    assert.equal(extraMapping.ok, false);
    assert.match(extraMapping.detail, /acceptanceCases|验收|A9/);

    const missingExecutionE2eRoot = join(temp, 'e2e-missing-execution');
    writeControlledPanelE2eRoot(missingExecutionE2eRoot, businessContract);
    const sharedA6A8CaseId = CONTROLLED_ACCEPTANCE_CASES.A6[0];
    const missingExecution = await runBrowserGate({
      repoDir: gateRepo,
      e2eRoot: missingExecutionE2eRoot,
      artifactDir,
      mountPath: '/',
      version: 'panel-missing-execution',
      project: 'panel',
      reqId: PANEL_REQ_ID,
      specFiles: { [PANEL_SPEC_PATH]: CONTROLLED_PANEL_SPEC },
      jobTmp: join(temp, 'job-missing-execution'),
      browserCacheDir,
      evidenceStage: 'worker',
      jobId: 'panel-missing-execution',
      sourceMainSha,
      candidateTreeSha,
      logger: SILENT_LOGGER,
      runner: fakeBrowserRunner(
        allBusinessCaseIds.filter((caseId) => caseId !== sharedA6A8CaseId),
      ),
    });
    assert.equal(missingExecution.ok, false);
    assert.match(missingExecution.detail, /用例|A6|A8|未执行|覆盖/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('临时真实 Git：普通面板 Issue 绑定、提前/撤标/旧版、并发领取与重启只派一次', async () => {
  const fixture = await createGitFlowFixture();
  const issueNumber = 1901;
  try {
    const first = await runOnce(fixture.core);
    assert.equal(first.workers.length, 0);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(fixture.github.createPRCalls, 0);
    const revisions = panelRevisions(fixture.core.state.snapshot());
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.revision, 1);
    assert.equal(revisions[0]?.reqId, PANEL_REQ_ID);
    assert.equal(revisions[0]?.specPath, PANEL_SPEC_PATH);
    assert.equal(revisions[0]?.specHash, fixture.panelSpecHash);
    assert.equal(revisions[0]?.sourceMainSha, fixture.mainSha);
    assert.deepEqual(revisions[0]?.task.allowedPaths, ['panel/src/**']);
    assert.ok(revisions[0]?.publishedAt);
    assert.equal(revisions[0]?.observation?.state, 'awaiting-label');
    assert.ok(
      Date.parse(revisions[0]!.observation!.observedAt)
        >= Date.parse(revisions[0]!.publishedAt!),
      '发布后观察时间不得早于发布完成时间',
    );
    assert.match(fixture.github.visibleIssueText(issueNumber), /待排期/);
    assert.match(fixture.github.visibleIssueText(issueNumber), /可开工\/r1/);

    // 同一 reqId 的另一张普通登记 Issue 即使被白名单用户打标，也不能替换受信绑定卡片。
    const rogueIssueNumber = 1903;
    fixture.github.seedIssue(
      rogueIssueNumber,
      PANEL_REQ_ID,
      PANEL_SPEC_PATH,
      fixture.panelSpecHash,
      fixture.mainSha,
    );
    fixture.github.addLabelByUser(rogueIssueNumber, '可开工/r1', ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(
      fixture.core.state.snapshot().requirements[PANEL_REQ_ID]?.issueNumber,
      issueNumber,
    );
    assert.equal(panelRevisions(fixture.core.state.snapshot())[0]?.issueNumber, issueNumber);
    fixture.github.removeLabelByUser(rogueIssueNumber, '可开工/r1', ALLOWED_USER_ID);
    fixture.github.issues.delete(rogueIssueNumber);
    fixture.github.labelEvents.delete(rogueIssueNumber);

    // 初始 r1 事件发生在发布时间之前，撤下后不会反推为已授权。
    fixture.github.removeLabelByUser(issueNumber, '可开工/r1', ALLOWED_USER_ID);
    fixture.github.labelEventReadFailures = 1;
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(
      panelRevisions(fixture.core.state.snapshot())[0]?.observation?.state,
      'unverified',
    );
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(
      panelRevisions(fixture.core.state.snapshot())[0]?.observation?.state,
      'awaiting-label',
    );

    fixture.github.addLabelByUser(issueNumber, '可开工/r99', ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(
      panelRevisions(fixture.core.state.snapshot())[0]?.observation?.state,
      'awaiting-label',
    );
    fixture.github.removeLabelByUser(issueNumber, '可开工/r99', ALLOWED_USER_ID);

    fixture.github.addLabelByUser(issueNumber, '可开工/r1', ALLOWED_USER_ID);
    fixture.github.removeLabelByUser(issueNumber, '可开工/r1', ALLOWED_USER_ID);
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(
      panelRevisions(fixture.core.state.snapshot())[0]?.observation?.state,
      'awaiting-label',
    );

    fixture.github.addLabelByUser(issueNumber, '可开工/r1', '99');
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 0);
    assert.equal(
      panelRevisions(fixture.core.state.snapshot())[0]?.observation?.state,
      'awaiting-label',
    );
    fixture.github.removeLabelByUser(issueNumber, '可开工/r1', '99');

    fixture.github.addLabelByUser(issueNumber, '可开工/r1', ALLOWED_USER_ID);
    fixture.github.addLabelByUser(issueNumber, '可开工/r1', ALLOWED_USER_ID);
    await Promise.all([runOnce(fixture.newCore()), runOnce(fixture.newCore())]);
    const claimedState = fixture.newCore().state.snapshot();
    assert.equal(
      fixture.workerInputs.length,
      1,
      JSON.stringify({
        logs: fixture.logs,
        revision: panelRevisions(claimedState)[0],
        jobs: claimedState.jobs,
      }, null, 2),
    );
    assert.equal(
      Object.keys(claimedState.jobs).length,
      1,
      '同一 stateFile 的两个 Core 并发领取后只能留下一条作业',
    );
    assert.equal(fixture.github.createPRCalls, 1);
    const worker = fixture.workerInputs[0]!;
    assert.equal(worker.reqId, PANEL_REQ_ID);
    assert.equal(worker.spec.hash, fixture.panelSpecHash);
    assert.equal(worker.sourceMainSha, fixture.mainSha);
    assert.deepEqual(worker.dispatchRevision?.task.allowedPaths, ['panel/src/**']);
    assert.equal(
      panelRevisions(fixture.newCore().state.snapshot())[0]?.observation?.state,
      'authorized',
    );

    fixture.github.addLabelByUser(issueNumber, '可开工/r1', ALLOWED_USER_ID);
    fixture.restart();
    await runOnce(fixture.core);
    assert.equal(fixture.workerInputs.length, 1);
    assert.equal(Object.keys(fixture.core.state.snapshot().jobs).length, 1);
    assert.equal(fixture.github.createPRCalls, 1);
    assert.equal(
      panelRevisions(fixture.core.state.snapshot())[0]?.observation?.state,
      'authorized',
    );
  } finally {
    fixture.cleanup();
  }
});
