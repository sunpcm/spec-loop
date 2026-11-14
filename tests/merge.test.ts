import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { FeishuActorContext } from '../orchestrator/feishu-contract.ts';
import { GitClient } from '../orchestrator/git.ts';
import {
  encodeMetaBlock,
  GithubClient,
  type GhRunner,
} from '../orchestrator/github.ts';
import type { Logger } from '../orchestrator/log.ts';
import { MergeService } from '../orchestrator/merge.ts';
import { parseSpecs } from '../orchestrator/specs.ts';
import { StateStore } from '../orchestrator/state.ts';
import {
  emptyState,
  type MergeRequestStage,
  type OrchestratorState,
  type Spec,
} from '../orchestrator/types.ts';
import { buildWorkerBranchName } from '../orchestrator/worker.ts';

const REPO = 'owner/repo';
const PR_NUMBER = 8;
const MERGE_SHA = 'c'.repeat(40);
const OTHER_SHA = 'd'.repeat(40);
const FIXED_CODE = 'a1b2c3d4';

const actor: FeishuActorContext = {
  messageId: 'om_preflight_1',
  actorId: 'ou_allowed',
  chatId: 'oc_bound',
  senderType: 'user',
};

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Spec Loop Test',
      GIT_AUTHOR_EMAIL: 'spec-loop-test@example.invalid',
      GIT_COMMITTER_NAME: 'Spec Loop Test',
      GIT_COMMITTER_EMAIL: 'spec-loop-test@example.invalid',
    },
  }).trim();
}

interface GitFixture {
  root: string;
  repoDir: string;
  baseSHA: string;
  headSHA: string;
  branch: string;
  filePath: string;
  fileStatus: 'added' | 'modified';
  headContent: string;
  baseSpecHash: string;
  docContent?: string;
  executable: boolean;
}

function createGitFixture(
  type: 'docs' | 'code',
  options: { executable?: boolean } = {},
): GitFixture {
  const root = mkdtempSync(join(tmpdir(), `spec-loop-merge-${type}-`));
  const remoteDir = join(root, 'remote.git');
  const repoDir = join(root, 'repo');
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  git(['init', '--bare', '--initial-branch=main'], remoteDir);
  git(['init', '--initial-branch=main'], repoDir);
  git(['config', 'user.name', 'Spec Loop Test'], repoDir);
  git(['config', 'user.email', 'spec-loop-test@example.invalid'], repoDir);
  mkdirSync(join(repoDir, 'docs', 'specs'), { recursive: true });
  mkdirSync(join(repoDir, 'src'), { recursive: true });

  const baseDoc = readFileSync(
    join(import.meta.dirname, '..', 'docs', 'specs', 'counter.md'),
    'utf8',
  );
  writeFileSync(join(repoDir, 'docs', 'specs', 'counter.md'), baseDoc, 'utf8');
  writeFileSync(
    join(repoDir, 'src', 'counter.ts'),
    "export const fixtureCounter = 0;\n",
    'utf8',
  );
  git(['add', '--', 'docs/specs/counter.md', 'src/counter.ts'], repoDir);
  git(['commit', '-m', 'base'], repoDir);
  const baseSHA = git(['rev-parse', 'HEAD'], repoDir);
  git(['remote', 'add', 'origin', remoteDir], repoDir);
  git(['push', '-u', 'origin', 'main'], repoDir);

  const parsed = parseSpecs({ 'docs/specs/counter.md': baseDoc });
  const baseSpecHash = parsed.specs.find((spec) => spec.id === 'REQ-CNT-01')?.hash ?? '';
  assert.ok(baseSpecHash);

  const branch =
    type === 'docs'
      ? 'pi/spec-abcdef123456'
      : buildWorkerBranchName('REQ-CNT-01', 12, baseSpecHash, baseSHA, 1);
  git(['checkout', '-b', branch], repoDir);
  const filePath = type === 'docs' ? 'docs/specs/counter.md' : 'src/counter.ts';
  const headContent =
    type === 'docs'
      ? baseDoc.replace(
          '- 初始显示 0；步长 2 时点击一次显示 2。',
          '- 初始显示 0；步长 2 时点击一次显示 2。\n- 合并夹具验证文档更新。',
        )
      : "export const fixtureCounter = 1;\nexport const mergeFixture = true;\n";
  assert.notEqual(headContent, type === 'docs' ? baseDoc : "export const fixtureCounter = 0;\n");
  writeFileSync(join(repoDir, filePath), headContent, 'utf8');
  if (options.executable) chmodSync(join(repoDir, filePath), 0o755);
  git(['add', '--', filePath], repoDir);
  if (options.executable) git(['update-index', '--chmod=+x', filePath], repoDir);
  git(['commit', '-m', `${type} change`], repoDir);
  const headSHA = git(['rev-parse', 'HEAD'], repoDir);
  git(['checkout', 'main'], repoDir);

  return {
    root,
    repoDir,
    baseSHA,
    headSHA,
    branch,
    filePath,
    fileStatus: type === 'docs' ? 'modified' : 'modified',
    headContent,
    baseSpecHash,
    docContent: type === 'docs' ? headContent : undefined,
    executable: options.executable ?? false,
  };
}

interface RawPull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string };
  };
  base: {
    ref: string;
    sha: string;
    repo: { full_name: string };
  };
  merge_commit_sha?: string;
  html_url: string;
  changed_files: number;
}

interface FilePageEntry {
  filename: string;
  status: string;
  previous_filename?: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

type PutMode =
  | 'merge-success'
  | 'merge-then-timeout'
  | 'open-timeout'
  | 'open-success'
  | 'reject-403'
  | 'reject-405'
  | 'reject-409'
  | 'reject-422'
  | 'reject-json-422'
  | 'network-error'
  | 'server-error';

type StoreFactory = (file: string, initialState: OrchestratorState) => StateStore;

interface MergeHarness {
  root: string;
  fixture: GitFixture;
  state: StateStore;
  service: MergeService;
  makeService: (codeFactory?: () => string) => MergeService;
  rawPull: RawPull;
  filePages: FilePageEntry[][];
  tree: TreeEntry[];
  checkRunPages: Array<Record<string, unknown>>;
  statusPages: Array<Record<string, unknown>>;
  mergeSha: string;
  putMode: PutMode;
  putCount: number;
  putCalls: string[][];
  checkRunCalls: number;
  statusCalls: number;
  getPullCalls: number;
  failPull: boolean;
  failPullAfterPut: boolean;
  notifications: string[];
  logs: string[];
  nowMs: number;
  requestId: string;
  jobId: string;
}

function initialState(fixture: GitFixture, type: 'docs' | 'code'): OrchestratorState {
  const state = emptyState();
  state.repo = REPO;
  state.cursorMainSha = fixture.baseSHA;
  if (type === 'docs') {
    state.specRequests.abcdef123456 = {
      requestId: 'abcdef123456',
      messageId: 'om_require',
      description: '更新计数器说明',
      targetReqId: 'REQ-CNT-01',
      baseSHA: fixture.baseSHA,
      branch: fixture.branch,
      stage: 'pr-open',
      hasValidDoc: true,
      docContent: fixture.docContent,
      commitSHA: fixture.headSHA,
      prNumber: PR_NUMBER,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      labelsSynced: true,
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:01:00.000Z',
    };
  } else {
    state.requirements['REQ-CNT-01'] = {
      issueNumber: 12,
      specHash: fixture.baseSpecHash,
      specPath: 'docs/specs/counter.md',
      sourceMainSha: fixture.baseSHA,
    };
    state.jobs['job-code-1'] = {
      jobId: 'job-code-1',
      reqId: 'REQ-CNT-01',
      issueNumber: 12,
      specHash: fixture.baseSpecHash,
      sourceMainSha: fixture.baseSHA,
      attempt: 1,
      status: 'in-review',
      prNumber: PR_NUMBER,
      headSHA: fixture.headSHA,
      startedAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:01:00.000Z',
    };
  }
  return state;
}

function prBody(fixture: GitFixture, type: 'docs' | 'code'): string {
  const meta =
    type === 'docs'
      ? {
          schema: 1,
          system: 'spec-loop',
          kind: 'spec-request',
          requestId: 'abcdef123456',
          specPath: 'docs/specs/counter.md',
          sourceMainSha: fixture.baseSHA,
          operationKey: 'docs-fixture',
        }
      : {
          schema: 1,
          system: 'spec-loop',
          kind: 'code-pr',
          reqId: 'REQ-CNT-01',
          specPath: 'docs/specs/counter.md',
          specHash: fixture.baseSpecHash,
          sourceMainSha: fixture.baseSHA,
          jobId: 'job-code-1',
          attempt: 1,
          operationKey: 'code-fixture',
        };
  return `fixture\n\n${encodeMetaBlock(meta)}`;
}

function makeHarness(
  type: 'docs' | 'code',
  options: { executable?: boolean; storeFactory?: StoreFactory } = {},
): MergeHarness {
  const fixture = createGitFixture(type, { executable: options.executable });
  const initial = initialState(fixture, type);
  const stateFile = join(fixture.root, 'state.json');
  const state = (options.storeFactory ?? ((file, value) => new StateStore(file, value)))(
    stateFile,
    initial,
  );
  const rawPull: RawPull = {
    number: PR_NUMBER,
    title: type === 'docs' ? 'docs: 更新计数器说明' : 'feat: 更新计数器',
    body: prBody(fixture, type),
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: {
      ref: fixture.branch,
      sha: fixture.headSHA,
      repo: { full_name: REPO },
    },
    base: {
      ref: 'main',
      sha: fixture.baseSHA,
      repo: { full_name: REPO },
    },
    html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    changed_files: 1,
  };
  const tree: TreeEntry[] = [
    {
      path: fixture.filePath,
      mode: fixture.executable ? '100755' : '100644',
      type: 'blob',
      sha: `blob-${fixture.headSHA}`,
    },
  ];
  const harness = {
    root: fixture.root,
    fixture,
    state,
    service: null as unknown as MergeService,
    makeService: (_codeFactory?: () => string) => null as unknown as MergeService,
    rawPull,
    filePages: [[{ filename: fixture.filePath, status: 'modified' }]],
    tree,
    checkRunPages: [
      {
        total_count: 1,
        check_runs: [
          {
            id: 101,
            head_sha: fixture.headSHA,
            status: 'completed',
            conclusion: 'success',
            name: 'Vercel Preview Comments',
          },
        ],
      },
    ],
    statusPages: [
      {
        sha: fixture.headSHA,
        total_count: 1,
        state: 'success',
        statuses: [
          {
            id: 201,
            context: 'Vercel',
            state: 'success',
          },
        ],
      },
    ],
    mergeSha: MERGE_SHA,
    putMode: 'merge-success' as PutMode,
    putCount: 0,
    putCalls: [] as string[][],
    checkRunCalls: 0,
    statusCalls: 0,
    getPullCalls: 0,
    failPull: false,
    failPullAfterPut: false,
    notifications: [] as string[],
    logs: [] as string[],
    nowMs: Date.parse('2026-11-14T01:00:00.000Z'),
    requestId: type === 'docs' ? 'abcdef123456' : 'job-code-1',
    jobId: 'job-code-1',
  };
  const logger: Logger = {
    info: (message) => harness.logs.push(message),
    warn: (message) => harness.logs.push(message),
    error: (message) => harness.logs.push(message),
    debug: () => {},
  };
  const runner: GhRunner = async (args) => {
    const path = args.includes('--slurp') ? args[3] ?? '' : args[1] ?? '';
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PUT') {
      harness.putCount += 1;
      harness.putCalls.push([...args]);
      if (harness.putMode.startsWith('reject-') && harness.putMode !== 'reject-json-422') {
        const status = harness.putMode.slice('reject-'.length);
        return {
          stdout: '',
          stderr: `gh: merge rejected (HTTP ${status})`,
          code: 1,
        };
      }
      if (harness.putMode === 'reject-json-422') {
        return {
          stdout: JSON.stringify({
            merged: false,
            status: '422',
            message: 'Validation Failed',
          }),
          stderr: '',
          code: 1,
        };
      }
      if (harness.putMode === 'network-error') {
        return {
          stdout: '',
          stderr: 'Post "https://api.github.com": dial tcp: i/o timeout',
          code: 1,
        };
      }
      if (harness.putMode === 'server-error') {
        return {
          stdout: '',
          stderr: 'gh: Server Error (HTTP 502)',
          code: 1,
        };
      }
      if (harness.putMode === 'open-timeout') {
        return { stdout: '', stderr: 'request timed out', code: 124 };
      }
      if (harness.putMode === 'open-success') {
        return {
          stdout: JSON.stringify({ merged: true, sha: harness.mergeSha }),
          stderr: '',
          code: 0,
        };
      }
      harness.rawPull.state = 'closed';
      harness.rawPull.merged = true;
      harness.rawPull.merge_commit_sha = harness.mergeSha;
      if (harness.putMode === 'merge-then-timeout') {
        return { stdout: '', stderr: 'request timed out', code: 124 };
      }
      return {
        stdout: JSON.stringify({ merged: true, sha: harness.mergeSha }),
        stderr: '',
        code: 0,
      };
    }
    if (harness.failPull || (harness.failPullAfterPut && harness.putCount > 0)) {
      return { stdout: '', stderr: 'fake pull network failure', code: 1 };
    }
    if (path === `repos/${REPO}/pulls/${PR_NUMBER}`) {
      harness.getPullCalls += 1;
      return { stdout: JSON.stringify(harness.rawPull), stderr: '', code: 0 };
    }
    if (path === `repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`) {
      return { stdout: JSON.stringify(harness.filePages), stderr: '', code: 0 };
    }
    if (path === `repos/${REPO}/commits/${harness.rawPull.head.sha}/check-runs?per_page=100`) {
      harness.checkRunCalls += 1;
      return { stdout: JSON.stringify(harness.checkRunPages), stderr: '', code: 0 };
    }
    if (path === `repos/${REPO}/commits/${harness.rawPull.head.sha}/status?per_page=100`) {
      harness.statusCalls += 1;
      return { stdout: JSON.stringify(harness.statusPages), stderr: '', code: 0 };
    }
    if (path === `repos/${REPO}/git/trees/${harness.rawPull.head.sha}?recursive=1`) {
      return {
        stdout: JSON.stringify({ sha: harness.rawPull.head.sha, truncated: false, tree: harness.tree }),
        stderr: '',
        code: 0,
      };
    }
    if (path === `repos/${REPO}/git/blobs/blob-${harness.rawPull.head.sha}`) {
      return {
        stdout: JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(fixture.docContent ?? fixture.headContent, 'utf8').toString('base64'),
        }),
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '', stderr: `unexpected fake gh path: ${path}`, code: 1 };
  };
  const gitClient = new GitClient();
  const githubClient = new GithubClient(REPO, runner);
  harness.makeService = (codeFactory = () => FIXED_CODE) =>
    new MergeService({
      repo: REPO,
      repoDir: fixture.repoDir,
      state,
      git: gitClient,
      github: githubClient,
      logger,
      notify: async (text) => {
        harness.notifications.push(text);
      },
      now: () => harness.nowMs,
      confirmationCodeFactory: codeFactory,
    });
  harness.service = harness.makeService();
  return harness;
}

function context(messageId = 'om_confirm_1', actorId = actor.actorId): FeishuActorContext {
  return {
    ...actor,
    messageId,
    actorId,
  };
}

function confirmationCode(message: string): string {
  const match = /确认合并 #\d+ ([0-9a-f]{8})/.exec(message);
  assert.ok(match, `预检结果缺少确认码: ${message}`);
  return match[1]!;
}

test('文档 PR 成功路径同时核对 check-runs 与 combined status 后，以 REST PUT 指定 head 合并', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));

  const preview = await h.service.preflight(PR_NUMBER, actor);
  const code = confirmationCode(preview);
  assert.match(preview, /类型: 文档 PR/);
  assert.match(preview, /1 项 check-run、1 项 commit status，全部通过/);
  assert.match(preview, new RegExp(h.fixture.headSHA));
  const pending = h.state.snapshot().mergeRequests?.[Object.keys(h.state.snapshot().mergeRequests ?? {})[0]!];
  assert.equal(pending?.stage, 'confirmable');
  assert.equal(pending?.headSHA, h.fixture.headSHA);
  assert.equal(pending?.operatorId, actor.actorId);
  assert.equal(pending?.chatId, actor.chatId);

  const result = await h.service.confirm(PR_NUMBER, code, context());
  assert.equal(result, '已合并，后续编码/部署处理中');
  assert.equal(h.putCount, 1);
  assert.deepEqual(h.putCalls[0], [
    'api',
    '--method',
    'PUT',
    `repos/${REPO}/pulls/${PR_NUMBER}/merge`,
    '-f',
    `sha=${h.fixture.headSHA}`,
    '-f',
    'merge_method=merge',
  ]);
  assert.equal(h.putCalls[0]?.includes('--admin'), false);
  assert.equal(h.putCalls[0]?.includes('--auto'), false);
  assert.equal(h.checkRunCalls, 3);
  assert.equal(h.statusCalls, 3);
  const record = Object.values(h.state.snapshot().mergeRequests ?? {})[0];
  assert.equal(record?.stage, 'merged');
  assert.equal(record?.mergeCommitSha, MERGE_SHA);
  assert.equal(h.notifications.length, 1);
});

test('代码 PR 成功路径保持 job=in-review，不提前设置 done 或关闭任务', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));

  const preview = await h.service.preflight(PR_NUMBER, actor);
  assert.match(preview, /类型: 代码 PR/);
  assert.match(preview, /job job-code-1 处于 in-review/);
  const code = confirmationCode(preview);
  const result = await h.service.confirm(PR_NUMBER, code, context());

  assert.equal(result, '已合并，后续编码/部署处理中');
  assert.equal(h.putCount, 1);
  assert.equal(h.state.snapshot().jobs['job-code-1']?.status, 'in-review');
  assert.equal(h.state.snapshot().jobs['job-code-1']?.prNumber, PR_NUMBER);
});

test('真实本仓检查 API 形态被逐项解析：check-runs 与 status 都必须覆盖', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.checkRunPages = [
    {
      total_count: 1,
      check_runs: [
        {
          id: 11,
          head_sha: h.fixture.headSHA,
          status: 'completed',
          conclusion: 'success',
          name: 'Vercel Preview Comments',
        },
      ],
    },
  ];
  h.statusPages = [
    {
      sha: h.fixture.headSHA,
      total_count: 1,
      state: 'success',
      statuses: [{ id: 12, context: 'Vercel', state: 'success' }],
    },
  ];
  const text = await h.service.preflight(PR_NUMBER, actor);
  assert.match(text, /check-run/);
  assert.match(text, /commit status/);
  assert.equal(h.checkRunCalls, 1);
  assert.equal(h.statusCalls, 1);
});

test('零远端检查时明确显示并依赖本地可信验证记录', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.checkRunPages = [{ total_count: 0, check_runs: [] }];
  h.statusPages = [{ sha: h.fixture.headSHA, total_count: 0, state: 'pending', statuses: [] }];

  const text = await h.service.preflight(PR_NUMBER, actor);
  assert.match(text, /无远端检查（依赖本地可信验证记录）/);
  assert.match(text, /本地验证: job job-code-1/);
  assert.equal(Object.keys(h.state.snapshot().mergeRequests ?? {}).length, 1);
});

for (const scenario of [
  {
    name: '非受管 PR',
    patch: (h: MergeHarness) => {
      h.rawPull.head.ref = 'feature/unmanaged';
    },
    expected: /受管/,
  },
  {
    name: 'fork PR',
    patch: (h: MergeHarness) => {
      h.rawPull.head.repo.full_name = 'fork/repo';
    },
    expected: /fork|跨仓/,
  },
  {
    name: 'draft PR',
    patch: (h: MergeHarness) => {
      h.rawPull.draft = true;
    },
    expected: /draft/,
  },
  {
    name: '错误 base',
    patch: (h: MergeHarness) => {
      h.rawPull.base.ref = 'develop';
    },
    expected: /base 必须是 main/,
  },
  {
    name: 'blocked PR',
    patch: (h: MergeHarness) => {
      h.rawPull.mergeable_state = 'blocked';
    },
    expected: /blocked/,
  },
  {
    name: 'dirty PR',
    patch: (h: MergeHarness) => {
      h.rawPull.mergeable_state = 'dirty';
    },
    expected: /dirty/,
  },
  {
    name: 'unstable PR',
    patch: (h: MergeHarness) => {
      h.rawPull.mergeable_state = 'unstable';
    },
    expected: /unstable/,
  },
  {
    name: 'behind PR',
    patch: (h: MergeHarness) => {
      h.rawPull.mergeable_state = 'behind';
    },
    expected: /behind/,
  },
  {
    name: '未知 mergeable',
    patch: (h: MergeHarness) => {
      h.rawPull.mergeable = null;
    },
    expected: /mergeable/,
  },
] as Array<{
  name: string;
  patch: (h: MergeHarness) => void;
  expected: RegExp;
}>) {
  test(`${scenario.name} 预检拒绝且不生成确认码`, async (t) => {
    const h = makeHarness('code');
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    scenario.patch(h);
    const text = await h.service.preflight(PR_NUMBER, actor);
    assert.match(text, /拒绝合并/);
    assert.match(text, scenario.expected);
    assert.equal(Object.keys(h.state.snapshot().mergeRequests ?? {}).length, 0);
    assert.equal(h.putCount, 0);
  });
}

test('check-run pending/failed/cancelled 与其他 head 均 fail closed', async (t) => {
  const cases = [
    {
      run: { id: 1, head_sha: 'HEAD', status: 'in_progress', conclusion: null, name: 'pending' },
      expected: /conclusion|pending/,
    },
    {
      run: { id: 2, head_sha: 'HEAD', status: 'completed', conclusion: 'failure', name: 'failed' },
      expected: /failed|failure/,
    },
    {
      run: { id: 3, head_sha: 'HEAD', status: 'completed', conclusion: 'cancelled', name: 'cancelled' },
      expected: /cancelled/,
    },
    {
      run: { id: 4, head_sha: OTHER_SHA, status: 'completed', conclusion: 'success', name: 'wrong-head' },
      expected: /其他 head/,
    },
  ];
  for (const entry of cases) {
    const h = makeHarness('docs');
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    entry.run.head_sha = entry.run.head_sha === 'HEAD' ? h.fixture.headSHA : entry.run.head_sha;
    h.checkRunPages = [{ total_count: 1, check_runs: [entry.run] }];
    const text = await h.service.preflight(PR_NUMBER, actor);
    assert.match(text, /拒绝合并/);
    assert.match(text, entry.expected);
  }
});

test('combined status 非 success、其他 head 或分页数量不完整均拒绝', async (t) => {
  const scenarios = [
    {
      pages: (h: MergeHarness) => [
        {
          sha: h.fixture.headSHA,
          total_count: 1,
          state: 'failure',
          statuses: [{ id: 1, context: 'Vercel', state: 'failure' }],
        },
      ],
      expected: /combined commit status=failure/,
    },
    {
      pages: () => [
        {
          sha: OTHER_SHA,
          total_count: 1,
          state: 'success',
          statuses: [{ id: 1, context: 'Vercel', state: 'success' }],
        },
      ],
      expected: /其他 head/,
    },
    {
      pages: (h: MergeHarness) => [
        {
          sha: h.fixture.headSHA,
          total_count: 2,
          state: 'success',
          statuses: [{ id: 1, context: 'Vercel', state: 'success' }],
        },
      ],
      expected: /total_count=2，实际=1/,
    },
  ];
  for (const entry of scenarios) {
    const h = makeHarness('docs');
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    h.statusPages = entry.pages(h);
    const text = await h.service.preflight(PR_NUMBER, actor);
    assert.match(text, /拒绝合并/);
    assert.match(text, entry.expected);
  }
});

test('changed_files、文件分页结构、raw git 路径与数量必须逐项一致', async (t) => {
  const scenarios = [
    {
      setup: (h: MergeHarness) => {
        h.rawPull.changed_files = 2;
      },
      expected: /changed_files=2，分页文件数=1/,
    },
    {
      setup: (h: MergeHarness) => {
        h.filePages = [];
      },
      expected: /分页结构不完整/,
    },
    {
      setup: (h: MergeHarness) => {
        h.filePages = [[{ filename: 'src/other.ts', status: 'modified' }]];
      },
      expected: /REST 文件清单与 raw git diff 路径不一致/,
    },
  ];
  for (const entry of scenarios) {
    const h = makeHarness('code');
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    entry.setup(h);
    const text = await h.service.preflight(PR_NUMBER, actor);
    assert.match(text, /拒绝合并/);
    assert.match(text, entry.expected);
  }
});

test('rename 的 previous_filename、symlink 与非 100644 mode 都拒绝', async (t) => {
  const rename = makeHarness('code');
  t.after(() => rmSync(rename.root, { recursive: true, force: true }));
  rename.filePages = [[{
    filename: rename.fixture.filePath,
    status: 'renamed',
    previous_filename: 'src/old-counter.ts',
  }]];
  const renameText = await rename.service.preflight(PR_NUMBER, actor);
  assert.match(renameText, /previous_filename|rename|越权/);

  const symlink = makeHarness('code');
  t.after(() => rmSync(symlink.root, { recursive: true, force: true }));
  symlink.tree[0]!.mode = '120000';
  symlink.tree[0]!.type = 'blob';
  const symlinkText = await symlink.service.preflight(PR_NUMBER, actor);
  assert.match(symlinkText, /100644.*blob|非 100644/);

  const executable = makeHarness('code', { executable: true });
  t.after(() => rmSync(executable.root, { recursive: true, force: true }));
  const executableText = await executable.service.preflight(PR_NUMBER, actor);
  assert.match(executableText, /mode|100755|100644/);
});

test('文档 head blob 必须与 state 已校验 docContent 完全相同', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  await h.state.update((state) => {
    state.specRequests.abcdef123456!.docContent = `${h.fixture.docContent}\n未授权尾注`;
  });
  const text = await h.service.preflight(PR_NUMBER, actor);
  assert.match(text, /文档内容与 state 已验证 docContent 不一致/);
});

test('文档与代码 PR 的 state/meta/head/base/hash 绑定不一致均拒绝', async (t) => {
  const docs = makeHarness('docs');
  t.after(() => rmSync(docs.root, { recursive: true, force: true }));
  await docs.state.update((state) => {
    state.specRequests.abcdef123456!.commitSHA = OTHER_SHA;
  });
  assert.match(
    await docs.service.preflight(PR_NUMBER, actor),
    /PR head\/base 与 state 文档请求不一致/,
  );

  const code = makeHarness('code');
  t.after(() => rmSync(code.root, { recursive: true, force: true }));
  await code.state.update((state) => {
    state.jobs['job-code-1']!.attempt = 2;
  });
  assert.match(
    await code.service.preflight(PR_NUMBER, actor),
    /job\/requirement\/specHash 绑定不一致/,
  );

  const staleHash = makeHarness('code');
  t.after(() => rmSync(staleHash.root, { recursive: true, force: true }));
  await staleHash.state.update((state) => {
    state.requirements['REQ-CNT-01']!.specHash = 'f'.repeat(64);
  });
  assert.match(
    await staleHash.service.preflight(PR_NUMBER, actor),
    /job\/requirement\/specHash 绑定不一致|需求哈希|revision 绑定不一致/,
  );

  const sourceDrift = makeHarness('code');
  t.after(() => rmSync(sourceDrift.root, { recursive: true, force: true }));
  await sourceDrift.state.update((state) => {
    state.requirements['REQ-CNT-01']!.sourceMainSha = OTHER_SHA;
  });
  assert.match(
    await sourceDrift.service.preflight(PR_NUMBER, actor),
    /revision 绑定不一致|sourceMainSha/,
  );
});

test('代码 PR 必须绑定 state 持久 headSHA、受控本地分支与 PR 实际 head', async (t) => {
  const missing = makeHarness('code');
  t.after(() => rmSync(missing.root, { recursive: true, force: true }));
  await missing.state.update((state) => {
    delete state.jobs['job-code-1']!.headSHA;
  });
  assert.match(
    await missing.service.preflight(PR_NUMBER, actor),
    /缺少持久验证的完整 headSHA/,
  );
  assert.equal(missing.putCount, 0);

  const stateHeadMismatch = makeHarness('code');
  t.after(() => rmSync(stateHeadMismatch.root, { recursive: true, force: true }));
  await stateHeadMismatch.state.update((state) => {
    state.jobs['job-code-1']!.headSHA = OTHER_SHA;
  });
  assert.match(
    await stateHeadMismatch.service.preflight(PR_NUMBER, actor),
    /PR head SHA.*持久验证 headSHA 不一致/,
  );

  const remoteHeadTamper = makeHarness('code');
  t.after(() => rmSync(remoteHeadTamper.root, { recursive: true, force: true }));
  remoteHeadTamper.rawPull.head.sha = OTHER_SHA;
  assert.match(
    await remoteHeadTamper.service.preflight(PR_NUMBER, actor),
    /PR head SHA.*持久验证 headSHA 不一致/,
  );
  assert.equal(remoteHeadTamper.putCount, 0);

  const localBranchTamper = makeHarness('code');
  t.after(() => rmSync(localBranchTamper.root, { recursive: true, force: true }));
  git(
    ['update-ref', `refs/heads/${localBranchTamper.fixture.branch}`, localBranchTamper.fixture.baseSHA],
    localBranchTamper.fixture.repoDir,
  );
  assert.match(
    await localBranchTamper.service.preflight(PR_NUMBER, actor),
    /本地分支 SHA.*持久 headSHA 不一致/,
  );

  for (const harness of [missing, stateHeadMismatch, remoteHeadTamper, localBranchTamper]) {
    assert.equal(Object.keys(harness.state.snapshot().mergeRequests ?? {}).length, 0);
  }
});

test('PR head/base 在确认码生成后漂移会作废确认码', async (t) => {
  const headDrift = makeHarness('code');
  t.after(() => rmSync(headDrift.root, { recursive: true, force: true }));
  const headPreview = await headDrift.service.preflight(PR_NUMBER, actor);
  const headCode = confirmationCode(headPreview);
  headDrift.rawPull.head.sha = OTHER_SHA;
  const headResult = await headDrift.service.confirm(PR_NUMBER, headCode, context());
  assert.match(headResult, /head 已.*漂移/);
  assert.equal(headDrift.putCount, 0);
  assert.equal(
    Object.values(headDrift.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'invalidated',
  );

  const baseDrift = makeHarness('docs');
  t.after(() => rmSync(baseDrift.root, { recursive: true, force: true }));
  const basePreview = await baseDrift.service.preflight(PR_NUMBER, actor);
  const baseCode = confirmationCode(basePreview);
  baseDrift.rawPull.base.sha = OTHER_SHA;
  const baseResult = await baseDrift.service.confirm(PR_NUMBER, baseCode, context());
  assert.match(baseResult, /base 已.*漂移/);
  assert.equal(baseDrift.putCount, 0);
  assert.equal(
    Object.values(baseDrift.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'invalidated',
  );
});

test('确认前 origin/main 前进同样废弃尚未发起的确认码', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const preview = await h.service.preflight(PR_NUMBER, actor);
  const code = confirmationCode(preview);
  git(['push', 'origin', `${h.fixture.headSHA}:refs/heads/main`], h.fixture.repoDir);

  const result = await h.service.confirm(PR_NUMBER, code, context());
  assert.match(result, /main\/base 已.*漂移/);
  assert.equal(h.putCount, 0);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'invalidated',
  );
});

test('确认码过期、错误码、跨操作者/会话均不触发 PUT', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const preview = await h.service.preflight(PR_NUMBER, actor);
  const code = confirmationCode(preview);

  assert.match(await h.service.confirm(PR_NUMBER, '00000000', context()), /确认码无效/);
  assert.match(
    await h.service.confirm(PR_NUMBER, code, context('om_other_person', 'ou_other')),
    /其他操作者或会话/,
  );
  assert.match(
    await h.service.confirm(
      PR_NUMBER,
      code,
      { ...context('om_other_chat'), chatId: 'oc_other' },
    ),
    /其他操作者或会话/,
  );
  h.nowMs += 10 * 60 * 1000;
  assert.match(await h.service.confirm(PR_NUMBER, code, context()), /确认码已过期/);
  assert.equal(h.putCount, 0);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'expired',
  );
});

test('缺少可信上下文、非 user 身份在服务层直接拒绝', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  assert.match(await h.service.preflight(PR_NUMBER), /缺少可信飞书事件上下文/);
  assert.match(
    await h.service.preflight(PR_NUMBER, {
      ...actor,
      senderType: 'bot' as 'user',
    }),
    /不是真实 user/,
  );
  assert.equal(Object.keys(h.state.snapshot().mergeRequests ?? {}).length, 0);
});

test('同一 messageId 跨服务重启重放返回原确认码且不生成新许可', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const first = await h.service.preflight(PR_NUMBER, actor);
  const reloaded = new StateStore(join(h.root, 'state.json'));
  reloaded.load();
  // makeService 仍使用内存 store；重启去重由 load 后的 state 证明旧记录完整存在。
  assert.equal(Object.keys(reloaded.snapshot().mergeRequests ?? {}).length, 1);
  const second = await h.makeService(() => 'ffffffff').preflight(PR_NUMBER, actor);
  assert.equal(second, first);
  assert.equal(Object.keys(h.state.snapshot().mergeRequests ?? {}).length, 1);
  assert.equal(confirmationCode(second), FIXED_CODE);
});

test('同码并发确认由状态落盘串行化，只发送一个 PUT', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  const [first, second] = await Promise.all([
    h.service.confirm(PR_NUMBER, code, context('om_confirm_a')),
    h.service.confirm(PR_NUMBER, code, context('om_confirm_b')),
  ]);
  const responses = [first, second];
  assert.equal(
    responses.filter((response) => response === '已合并，后续编码/部署处理中').length,
    1,
  );
  assert.equal(responses.filter((response) => /不再是 confirmable|拒绝合并/.test(response)).length, 1);
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );
});

class FailOnceStageStore extends StateStore {
  readonly targetStage: MergeRequestStage;
  failed = false;

  constructor(file: string, initialState: OrchestratorState, targetStage: MergeRequestStage) {
    super(file, initialState);
    this.targetStage = targetStage;
  }

  protected override persist(state: OrchestratorState): void {
    if (
      !this.failed &&
      Object.values(state.mergeRequests ?? {}).some((record) => record.stage === this.targetStage)
    ) {
      this.failed = true;
      throw new Error(`fixture persist failure at ${this.targetStage}`);
    }
    super.persist(state);
  }
}

test('attempted 状态落盘失败时绝不发送 PUT', async (t) => {
  const h = makeHarness('docs', {
    storeFactory: (file, initial) => new FailOnceStageStore(file, initial, 'attempted'),
  });
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  const result = await h.service.confirm(PR_NUMBER, code, context());
  assert.match(result, /尝试状态落盘失败，未调用 GitHub/);
  assert.equal(h.putCount, 0);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'confirmable',
  );
});

test('远端已合并但 success state 落盘失败时仍按远端真值成功，重放只读恢复且不重复 PUT', async (t) => {
  const h = makeHarness('code', {
    storeFactory: (file, initial) => new FailOnceStageStore(file, initial, 'merged'),
  });
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  assert.equal(
    await h.service.confirm(PR_NUMBER, code, context('om_confirm_persist')),
    '已合并，后续编码/部署处理中',
  );
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'attempted',
  );

  h.nowMs += 60 * 60 * 1000;
  assert.equal(
    await h.service.confirm(PR_NUMBER, code, context('om_confirm_recover')),
    '已合并，后续编码/部署处理中',
  );
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );
});

test('PUT 响应丢失且 PR 仍 open：持久 unknown，TTL 过后仅只读对账且不重发', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.putMode = 'open-timeout';
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  const first = await h.service.confirm(PR_NUMBER, code, context('om_confirm_timeout'));
  assert.match(first, /合并结果未确定.*不会重发/);
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'unknown',
  );
  const opLogCount = h.state.snapshot().opLog.filter(
    (entry) => entry.stage === 'merge-unknown',
  ).length;
  assert.equal(opLogCount, 1);

  h.nowMs += 24 * 60 * 60 * 1000;
  await h.service.confirm(PR_NUMBER, code, context('om_confirm_after_ttl'));
  await h.service.reconcilePending();
  await h.service.reconcilePending();
  assert.equal(h.putCount, 1);
  assert.equal(
    h.state.snapshot().opLog.filter((entry) => entry.stage === 'merge-unknown').length,
    1,
  );
});

test('PUT 成功响应丢失但远端已经合并：回读恢复 merged，不重复 PUT', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.putMode = 'merge-then-timeout';
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  assert.equal(
    await h.service.confirm(PR_NUMBER, code, context()),
    '已合并，后续编码/部署处理中',
  );
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );
});

test('merge API 声称 merged=true 但回读 open 时记 unknown，后续不重发 PUT', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.putMode = 'open-success';
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  const first = await h.service.confirm(PR_NUMBER, code, context());
  assert.match(first, /返回 merged=true，但 PR 回读仍为 open/);
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'unknown',
  );
  h.nowMs += 60 * 60 * 1000;
  await h.service.confirm(PR_NUMBER, code, context('om_confirm_retry'));
  assert.equal(h.putCount, 1);
});

test('PUT 后回读失败只保留 attempted/unknown，恢复后按远端对账', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.putMode = 'open-timeout';
  h.failPullAfterPut = true;
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  const result = await h.service.confirm(PR_NUMBER, code, context());
  assert.match(result, /attempted，但 GitHub 结果回读失败/);
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'unknown',
  );

  h.failPullAfterPut = false;
  h.rawPull.state = 'closed';
  h.rawPull.merged = true;
  h.rawPull.merge_commit_sha = h.mergeSha;
  await h.service.reconcilePending();
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );
});

test('明确 409 拒绝记为 failed，不能原码重试且不重复 PUT', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.putMode = 'reject-409';
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));

  const first = await h.service.confirm(PR_NUMBER, code, context());
  assert.match(first, /HTTP 409|明确拒绝|Head branch/);
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'failed',
  );
  const second = await h.service.confirm(PR_NUMBER, code, context('om_confirm_again'));
  assert.match(second, /已失效|拒绝/);
  assert.equal(h.putCount, 1);
});

test('明确 HTTP 403/405/409/422 与错误 JSON 均为 failed，并允许新消息重新预检', async (t) => {
  const modes: PutMode[] = [
    'reject-403',
    'reject-405',
    'reject-409',
    'reject-422',
    'reject-json-422',
  ];
  for (const [index, mode] of modes.entries()) {
    const h = makeHarness('docs');
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    h.putMode = mode;
    const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));
    const result = await h.service.confirm(PR_NUMBER, code, context(`om_confirm_${mode}`));
    assert.match(result, /HTTP 4(03|05|09|22)|merged=false|Validation Failed/);
    assert.equal(h.putCount, 1);
    assert.equal(
      Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
      'failed',
    );

    const renewedCode = (index + 1).toString(16).padStart(8, '0');
    const renewed = await h
      .makeService(() => renewedCode)
      .preflight(PR_NUMBER, {
        ...actor,
        messageId: `om_renew_${mode}`,
      });
    assert.match(renewed, new RegExp(`确认合并 #${PR_NUMBER} ${renewedCode}`));
    assert.equal(h.putCount, 1);
    assert.equal(
      Object.values(h.state.snapshot().mergeRequests ?? {}).some(
        (record) => record.stage === 'confirmable',
      ),
      true,
    );
  }
});

test('普通网络退出码 1 与 HTTP 5xx 保持 unknown，禁止重发 PUT', async (t) => {
  for (const [index, mode] of (['network-error', 'server-error'] as PutMode[]).entries()) {
    const h = makeHarness('docs');
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    h.putMode = mode;
    const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));
    const result = await h.service.confirm(PR_NUMBER, code, context(`om_unknown_${index}`));
    assert.match(result, /合并结果未确定.*不会重发/);
    assert.equal(h.putCount, 1);
    assert.equal(
      Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
      'unknown',
    );
    h.nowMs += 60 * 60 * 1000;
    await h.service.confirm(PR_NUMBER, code, context(`om_unknown_retry_${index}`));
    await h.service.reconcilePending();
    assert.equal(h.putCount, 1);
  }
});

test('预检读取失败 fail closed，不生成确认码', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.failPull = true;
  const text = await h.service.preflight(PR_NUMBER, actor);
  assert.match(text, /拒绝合并/);
  assert.match(text, /fake pull network failure|GitHub 读取失败/);
  assert.equal(Object.keys(h.state.snapshot().mergeRequests ?? {}).length, 0);
});

test('已合并 PR 早返回仍校验同仓和受管 state/meta，不给非受管 PR 造成功', async (t) => {
  const managed = makeHarness('docs');
  t.after(() => rmSync(managed.root, { recursive: true, force: true }));
  managed.rawPull.state = 'closed';
  managed.rawPull.merged = true;
  managed.rawPull.merge_commit_sha = MERGE_SHA;
  assert.equal(
    await managed.service.preflight(PR_NUMBER, actor),
    '已合并，后续编码/部署处理中',
  );
  assert.equal(managed.putCount, 0);
  assert.equal(
    Object.keys(managed.state.snapshot().mergeRequests ?? {}).length,
    0,
  );

  const unmanaged = makeHarness('docs');
  t.after(() => rmSync(unmanaged.root, { recursive: true, force: true }));
  unmanaged.rawPull.state = 'closed';
  unmanaged.rawPull.merged = true;
  unmanaged.rawPull.merge_commit_sha = MERGE_SHA;
  unmanaged.rawPull.head.ref = 'feature/unmanaged';
  const rejected = await unmanaged.service.preflight(PR_NUMBER, actor);
  assert.match(rejected, /拒绝合并/);
  assert.match(rejected, /受管/);
});

test('已合并早返回允许 main 已前进，但仍复核受管文档绑定与文件证据', async (t) => {
  const h = makeHarness('docs');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  git(['push', 'origin', `${h.fixture.headSHA}:refs/heads/main`], h.fixture.repoDir);
  h.rawPull.base.sha = h.fixture.headSHA;
  h.rawPull.state = 'closed';
  h.rawPull.merged = true;
  h.rawPull.merge_commit_sha = MERGE_SHA;

  assert.equal(
    await h.service.preflight(PR_NUMBER, actor),
    '已合并，后续编码/部署处理中',
  );
  h.filePages = [[{ filename: 'docs/specs/other.md', status: 'modified' }]];
  assert.match(
    await h.service.preflight(PR_NUMBER, actor),
    /拒绝合并|文件|Diff|raw git/i,
  );
});

test('代码已合并后 spec 更新，旧确认码重放仅返回已合并且不 PUT、不重复通知', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));
  assert.equal(
    await h.service.confirm(PR_NUMBER, code, context('om_confirm_original')),
    '已合并，后续编码/部署处理中',
  );
  assert.equal(h.putCount, 1);
  assert.equal(h.notifications.length, 1);

  const counterPath = join(h.fixture.repoDir, 'docs/specs/counter.md');
  writeFileSync(
    counterPath,
    `${readFileSync(counterPath, 'utf8')}\n- 后续需求已更新 spec。\n`,
    'utf8',
  );
  git(['add', '--', 'docs/specs/counter.md'], h.fixture.repoDir);
  git(['commit', '-m', 'later spec update'], h.fixture.repoDir);
  git(['push', 'origin', 'main'], h.fixture.repoDir);
  h.rawPull.base.sha = git(['rev-parse', 'HEAD'], h.fixture.repoDir);

  for (const messageId of ['om_confirm_history_1', 'om_confirm_history_2']) {
    assert.equal(
      await h.service.confirm(PR_NUMBER, code, context(messageId)),
      '已合并，后续编码/部署处理中',
    );
  }
  assert.equal(h.putCount, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );

  h.rawPull.head.sha = OTHER_SHA;
  assert.match(
    await h.service.confirm(PR_NUMBER, code, context('om_confirm_history_bad_head')),
    /head 已.*漂移/,
  );
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );
});

test('unknown 记录在后续 spec 更新后仍可按原 head/job 证据只读恢复 merged', async (t) => {
  const h = makeHarness('code');
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  h.putMode = 'open-timeout';
  const code = confirmationCode(await h.service.preflight(PR_NUMBER, actor));
  assert.match(
    await h.service.confirm(PR_NUMBER, code, context('om_confirm_unknown_before_spec')),
    /合并结果未确定/,
  );
  assert.equal(h.putCount, 1);

  const counterPath = join(h.fixture.repoDir, 'docs/specs/counter.md');
  writeFileSync(
    counterPath,
    `${readFileSync(counterPath, 'utf8')}\n- unknown 恢复期间 spec 已更新。\n`,
    'utf8',
  );
  git(['add', '--', 'docs/specs/counter.md'], h.fixture.repoDir);
  git(['commit', '-m', 'spec update during unknown'], h.fixture.repoDir);
  git(['push', 'origin', 'main'], h.fixture.repoDir);
  h.rawPull.base.sha = git(['rev-parse', 'HEAD'], h.fixture.repoDir);

  h.rawPull.state = 'closed';
  h.rawPull.merged = true;
  h.rawPull.merge_commit_sha = h.mergeSha;
  await h.service.reconcilePending();
  assert.equal(h.putCount, 1);
  assert.equal(
    Object.values(h.state.snapshot().mergeRequests ?? {})[0]?.stage,
    'merged',
  );
});
