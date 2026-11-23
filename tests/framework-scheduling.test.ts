import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Config } from '../orchestrator/config.ts';
import {
  COUNTER_REQ_ID,
  COUNTER_SPEC_PATH,
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
  type PanelBinding,
} from '../orchestrator/delivery-profile.ts';
import {
  evaluateDispatchObservation,
} from '../orchestrator/dispatch-task.ts';
import type { GithubClient } from '../orchestrator/github.ts';
import { GitClient, type GitRunner } from '../orchestrator/git.ts';
import type { Logger } from '../orchestrator/log.ts';
import type { MergeService } from '../orchestrator/merge.ts';
import { createCore, runOnce, type Core } from '../orchestrator/runtime.ts';
import { StateStore } from '../orchestrator/state.ts';
import {
  emptyState,
  type DispatchRevision,
  type OrchestratorState,
  type Spec,
} from '../orchestrator/types.ts';

const REPO = 'example/spec-loop';
const REPO_ID = 'github-repository-id:123456';
const ISSUE = 18;
const SOURCE_SHA = '1'.repeat(40);
const PUBLISHED_AT = '2026-11-23T00:00:00.000Z';

function panelBinding(patch: Partial<PanelBinding> = {}): PanelBinding {
  return {
    repo: REPO,
    mainBranch: 'main',
    repositoryId: REPO_ID,
    issueNumber: ISSUE,
    confirmedMainSha: SOURCE_SHA,
    specHash: 'a'.repeat(64),
    ...patch,
  };
}

function validRevision(patch: Partial<DispatchRevision> = {}): DispatchRevision {
  return {
    reqId: COUNTER_REQ_ID,
    repoId: REPO_ID,
    revision: 1,
    issueNumber: ISSUE,
    specHash: 'b'.repeat(64),
    specPath: COUNTER_SPEC_PATH,
    sourceMainSha: SOURCE_SHA,
    task: {
      goal: '验证计数器',
      steps: [{ text: '实现并验证', acceptanceRefs: ['A1'] }],
      acceptance: { A1: '计数正确' },
      allowedPaths: ['src/**'],
      dependsOn: [],
    },
    publishedAt: PUBLISHED_AT,
    publicationCommentId: 101,
    ...patch,
  };
}

function treeRecord(mode: string, type: string, sha: string, path: string): string {
  return `${mode} ${type} ${sha}\t${path}\0`;
}

test('GitClient 默认只读 docs/specs 直属 Markdown，不递归 pending', async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'ls-tree') {
      return {
        stdout:
          treeRecord('100644', 'blob', 'a'.repeat(40), 'docs/specs/counter.md')
          + treeRecord('100644', 'blob', 'b'.repeat(40), PANEL_SPEC_PATH),
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'show' && args[1] === `origin/main:${COUNTER_SPEC_PATH}`) {
      return { stdout: 'counter', stderr: '', code: 0 };
    }
    throw new Error(`未预期的 Git 调用: ${args.join(' ')}`);
  };

  const files = await new GitClient(runner).readSpecSnapshot('/tmp/repo', 'origin/main');
  assert.deepEqual(files, { [COUNTER_SPEC_PATH]: 'counter' });
  const trees = calls.filter((args) => args[0] === 'ls-tree');
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.includes('-r'), false);
  assert.equal(trees[0]?.at(-1), 'docs/specs/');
});

test('GitClient 在合法面板绑定时按精确路径读取 pending/panel.md', async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'ls-tree' && args.at(-1) === 'docs/specs/') {
      return {
        stdout: treeRecord('100644', 'blob', 'a'.repeat(40), COUNTER_SPEC_PATH),
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'ls-tree' && args.at(-1) === PANEL_SPEC_PATH) {
      return {
        stdout: treeRecord('100644', 'blob', 'b'.repeat(40), PANEL_SPEC_PATH),
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'show') {
      const path = args[1]!.slice(args[1]!.indexOf(':') + 1);
      return {
        stdout: path === COUNTER_SPEC_PATH ? 'counter' : 'panel',
        stderr: '',
        code: 0,
      };
    }
    throw new Error(`未预期的 Git 调用: ${args.join(' ')}`);
  };

  const files = await new GitClient(runner, panelBinding()).readSpecSnapshot(
    '/tmp/repo',
    'origin/main',
  );
  assert.deepEqual(files, {
    [COUNTER_SPEC_PATH]: 'counter',
    [PANEL_SPEC_PATH]: 'panel',
  });
  const panelTree = calls.find(
    (args) => args[0] === 'ls-tree' && args.at(-1) === PANEL_SPEC_PATH,
  );
  assert.ok(panelTree);
  assert.equal(panelTree.includes('-r'), false);
  assert.equal(panelTree.includes('--full-tree'), true);
});

test('受信规格只接受普通 blob，符号链接、目录和子模块均 fail closed', async () => {
  const cases = [
    treeRecord('120000', 'blob', 'a'.repeat(40), PANEL_SPEC_PATH),
    treeRecord('040000', 'tree', 'b'.repeat(40), PANEL_SPEC_PATH),
    treeRecord('160000', 'commit', 'c'.repeat(40), PANEL_SPEC_PATH),
  ];
  for (const record of cases) {
    const runner: GitRunner = async (args) => {
      if (args[0] === 'ls-tree' && args.at(-1) === 'docs/specs/') {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[0] === 'ls-tree' && args.at(-1) === PANEL_SPEC_PATH) {
        return { stdout: record, stderr: '', code: 0 };
      }
      throw new Error(`未预期的 Git 调用: ${args.join(' ')}`);
    };
    await assert.rejects(
      new GitClient(runner, panelBinding()).readSpecSnapshot('/tmp/repo', 'origin/main'),
      /受信规格不是普通文件/,
    );
  }
});

function legacyStateWithoutRequirements(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repo: REPO,
    cursorMainSha: null,
    jobs: {},
    deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
    specRequests: {},
    opLog: [],
  };
}

function loadStateText(value: unknown, prefix: string): OrchestratorState {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const file = join(root, 'state.json');
  writeFileSync(file, JSON.stringify(value), 'utf8');
  try {
    return new StateStore(file).load();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('旧 schemaVersion=1 状态缺失 requirements 时补空容器，显式畸形容器仍拒绝', () => {
  const old = loadStateText(legacyStateWithoutRequirements(), 'spec-loop-state-old-');
  assert.deepEqual(old.requirements, {});

  for (const requirements of [null, [], 'bad']) {
    assert.throws(
      () => loadStateText(
        { ...legacyStateWithoutRequirements(), requirements },
        'spec-loop-state-invalid-container-',
      ),
      /requirements 必须是对象容器/,
    );
  }
});

test('状态加载拒绝未登记 pending 子路径和面板需求错配', () => {
  const requirement = {
    issueNumber: ISSUE,
    specHash: 'b'.repeat(64),
    specPath: 'docs/specs/pending/other.md',
    sourceMainSha: SOURCE_SHA,
  };
  assert.throws(
    () => loadStateText(
      {
        ...legacyStateWithoutRequirements(),
        requirements: { 'REQ-OTHER-01': requirement },
      },
      'spec-loop-state-other-pending-',
    ),
    /规格路径未登记/,
  );

  const nested = {
    ...requirement,
    specPath: 'docs/specs/pending/deeper/other.md',
  };
  assert.throws(
    () => loadStateText(
      {
        ...legacyStateWithoutRequirements(),
        requirements: { 'REQ-OTHER-01': nested },
      },
      'spec-loop-state-deep-pending-',
    ),
    /规格路径未登记/,
  );

  assert.throws(
    () => loadStateText(
      {
        ...legacyStateWithoutRequirements(),
        requirements: {
          'REQ-OTHER-01': { ...requirement, specPath: PANEL_SPEC_PATH },
        },
      },
      'spec-loop-state-panel-mismatch-',
    ),
    /规格路径未登记/,
  );
});

test('状态加载拒绝非法 observation 状态、时间和早于发布时间', () => {
  const revisions = [
    validRevision({
      observation: { state: 'pending', observedAt: '2026-11-23T00:00:01.000Z' } as never,
    }),
    validRevision({
      observation: { state: 'authorized', observedAt: 'not-an-iso-time' },
    }),
    validRevision({
      observation: { state: 'unverified', observedAt: '2026-11-22T23:59:59.999Z' },
    }),
  ];
  for (const revision of revisions) {
    assert.throws(
      () => loadStateText(
        {
          ...legacyStateWithoutRequirements(),
          dispatchRevisions: { [COUNTER_REQ_ID]: [revision] },
        },
        'spec-loop-state-observation-',
      ),
      /dispatchRevisions 记录畸形/,
    );
  }
});

test('observation 区分无许可、撤标、事件冲突和白名单授权', () => {
  const revision = validRevision();
  const label = '可开工/r1';
  const context = {
    repoId: REPO_ID,
    issueNumber: ISSUE,
    allowedActorIds: ['user-1'],
  };

  assert.equal(
    evaluateDispatchObservation(revision, { ...context, labels: [], events: [] }).state,
    'awaiting-label',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [],
      events: [{
        id: 1,
        actorId: 'user-1',
        name: label,
        event: 'labeled',
        createdAt: '2026-11-23T00:01:00.000Z',
      }],
    }).state,
    'unverified',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [],
      events: [
        {
          id: 2,
          actorId: 'user-1',
          name: label,
          event: 'labeled',
          createdAt: '2026-11-23T00:01:00.000Z',
        },
        {
          id: 3,
          actorId: 'user-1',
          name: label,
          event: 'unlabeled',
          createdAt: '2026-11-23T00:02:00.000Z',
        },
      ],
    }).state,
    'awaiting-label',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [label],
      events: [{
        id: 4,
        actorId: 'user-1',
        name: label,
        event: 'unlabeled',
        createdAt: '2026-11-23T00:02:00.000Z',
      }],
    }).state,
    'unverified',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [label],
      events: [
        {
          id: 5,
          actorId: 'user-1',
          name: label,
          event: 'labeled',
          createdAt: '2026-11-23T00:01:00.000Z',
        },
        {
          id: 5,
          actorId: 'user-2',
          name: label,
          event: 'unlabeled',
          createdAt: '2026-11-23T00:02:00.000Z',
        },
      ],
    }).state,
    'unverified',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [label],
      events: [{
        id: 6,
        actorId: 'user-1',
        name: label,
        event: 'labeled',
        createdAt: '2026-11-23T00:03:00.000Z',
      }],
    }).state,
    'authorized',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [label],
      events: [{
        id: 7,
        actorId: 'outsider',
        name: label,
        event: 'labeled',
        createdAt: '2026-11-23T00:03:00.000Z',
      }],
    }).state,
    'awaiting-label',
  );
  assert.equal(
    evaluateDispatchObservation(revision, {
      ...context,
      labels: [label],
      events: [{
        id: 8,
        actorId: 'user-1',
        name: label,
        event: 'labeled',
        createdAt: '2026-11-22T23:59:00.000Z',
      }],
    }).state,
    'awaiting-label',
  );
});

function makeConfig(root: string): Config {
  return {
    repo: REPO,
    repoDir: root,
    runDir: join(root, '.orchestrator'),
    stateFile: join(root, '.orchestrator-state.json'),
    mainBranch: 'main',
    httpPort: 4000,
    previewPort: 5173,
    devPort: 5174,
    publicUrl: '',
    pollIntervalMs: 5000,
    piTimeoutMs: 300000,
    piGraceMs: 5000,
    buildTimeoutMs: 180000,
    verifyTimeoutMs: 300000,
    piAttempts: 2,
    piProvider: '',
    piModel: '',
    piAgentDir: join(root, '.orchestrator', 'agent'),
    errorDedupWindowMs: 600000,
    revisionBudget: 2,
    logRetentionDays: 7,
    reportToken: '',
    feishu: { enabled: false, allowedUserIds: [] },
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('createCore 向 Git、Reconcile、Worker、Retry、Merge 透传同一面板绑定', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-core-binding-'));
  try {
    git(['init', '--initial-branch=main'], root);
    mkdirSync(join(root, 'docs', 'specs', 'pending'), { recursive: true });
    writeFileSync(join(root, COUNTER_SPEC_PATH), 'counter', 'utf8');
    writeFileSync(join(root, PANEL_SPEC_PATH), 'panel', 'utf8');
    git(['add', 'docs/specs'], root);
    git([
      '-c',
      'user.name=Spec Loop Test',
      '-c',
      'user.email=spec-loop-test@example.invalid',
      'commit',
      '-m',
      'fixture',
    ], root);

    const binding = panelBinding();
    const config = { ...makeConfig(root), panelBinding: binding };
    writeFileSync(config.stateFile, JSON.stringify(emptyState()), 'utf8');
    const core = createCore(config, REPO);
    const files = await core.git.readSpecSnapshot(root, 'HEAD');
    assert.deepEqual(files, {
      [COUNTER_SPEC_PATH]: 'counter',
      [PANEL_SPEC_PATH]: 'panel',
    });
    assert.deepEqual(core.reconcileContext.panelBinding, binding);
    assert.deepEqual(core.workerDeps.panelBinding, binding);
    assert.deepEqual(core.retryBaselineDeps?.panelBinding, binding);
    assert.deepEqual(
      (core.mergeService as unknown as { panelBinding?: PanelBinding }).panelBinding,
      binding,
    );
    assert.equal(
      (core.mergeService as unknown as { trustedE2eRoot?: string }).trustedE2eRoot,
      root,
      '面板合并必须读取控制器默认可信验收根，不能依赖候选规格导出目录',
    );
    assert.equal(core.reconcileContext.dispatch?.isGated(PANEL_REQ_ID), true);
    assert.equal(core.reconcileContext.dispatch?.isGated(COUNTER_REQ_ID), true);
    const panelSpec: Spec = {
      id: PANEL_REQ_ID,
      title: '面板',
      path: PANEL_SPEC_PATH,
      body: '正文',
      hash: 'a'.repeat(64),
    };
    assert.deepEqual(
      core.reconcileContext.dispatch?.allowedPaths(panelSpec),
      ['panel/src/**'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未绑定面板时 REQ-PANEL-01 不进入门禁，计数器门禁保持', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-core-no-panel-'));
  try {
    const config = makeConfig(root);
    writeFileSync(config.stateFile, JSON.stringify(emptyState()), 'utf8');
    const core = createCore(config, null);
    assert.equal(core.reconcileContext.panelBinding, undefined);
    assert.equal(core.workerDeps.panelBinding, undefined);
    assert.equal(core.retryBaselineDeps?.panelBinding, undefined);
    assert.equal(core.reconcileContext.dispatch?.isGated(PANEL_REQ_ID), false);
    assert.equal(core.reconcileContext.dispatch?.isGated(COUNTER_REQ_ID), true);
    const panelSpec: Spec = {
      id: PANEL_REQ_ID,
      title: '面板',
      path: PANEL_SPEC_PATH,
      body: '正文',
      hash: 'a'.repeat(64),
    };
    assert.deepEqual(core.reconcileContext.dispatch?.allowedPaths(panelSpec), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runOnce 按受管 stateFile 串行，换 Core 后重读前一轮落盘状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-loop-run-once-state-file-'));
  try {
    const config = makeConfig(root);
    writeFileSync(
      config.stateFile,
      JSON.stringify({ ...emptyState(), repo: REPO }),
      'utf8',
    );
    const makeCore = (): Core => {
      const state = new StateStore(config.stateFile);
      state.load();
      const logger = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as unknown as Logger;
      const github = {
        listIssues: async () => [],
        listPRs: async () => [],
      } as unknown as GithubClient;
      const git = {
        fetch: async () => undefined,
        revParse: async () => SOURCE_SHA,
        readSpecSnapshot: async () => ({
          [COUNTER_SPEC_PATH]: '### [INVALID] 故意制造解析失败，跳过本轮对账\n',
        }),
      } as unknown as GitClient;
      const mergeService = {
        reconcilePending: async () => {
          const before = state.snapshot().opLog.length;
          // 拉开两个轮次的重叠窗口；第二个 Core 若沿用旧内存快照会仍看到 0。
          await new Promise((resolve) => setTimeout(resolve, 10));
          await state.update((current) => {
            current.opLog.push({
              ts: new Date().toISOString(),
              stage: 'state-file-test',
              operationKey: `observed-${before}`,
              detail: `本轮开始前已有 ${before} 条记录`,
            });
            return undefined;
          });
        },
      } as unknown as MergeService;
      return {
        config,
        logger,
        state,
        git,
        github,
        notifier: {} as Core['notifier'],
        commands: {} as Core['commands'],
        mergeService,
        workerDeps: {} as Core['workerDeps'],
        deployDeps: {
          repoDir: config.repoDir,
          runDir: config.runDir,
          git,
          github,
          state,
          logger,
        } as Core['deployDeps'],
        reconcileContext: {
          repoDir: config.repoDir,
          git,
          github,
          state,
          logger,
          mainBranch: config.mainBranch,
        },
        specIntakeDeps: {
          repoDir: config.repoDir,
          runDir: config.runDir,
          git,
          github,
          state,
          logger,
        },
        planner: null,
        repo: REPO,
      };
    };

    const first = makeCore();
    const second = makeCore();
    await Promise.all([runOnce(first), runOnce(second)]);

    const persisted = new StateStore(config.stateFile).load();
    assert.deepEqual(
      persisted.opLog.map((entry) => entry.operationKey),
      ['observed-0', 'observed-1'],
      '第二个 Core 必须在前一轮完成后重读 stateFile，而不是用构造时的旧快照写回',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
