import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../orchestrator/config.ts';
import {
  currentDispatchGrant,
  type DispatchLabelEvent,
} from '../orchestrator/dispatch-grant.ts';
import {
  GithubClient,
  type GhResult,
  type GhRunner,
} from '../orchestrator/github.ts';

const LABEL = '可开工/r1';
const PUBLISHED_AT = '2026-11-21T00:00:00Z';

function labelEvent(
  id: number,
  event: 'labeled' | 'unlabeled',
  createdAt: string,
  actorId: string | null = '42',
  name = LABEL,
): DispatchLabelEvent {
  return { id, actorId, name, event, createdAt };
}

test('开工许可只接受发布时间后、白名单用户对本版标签的最新添加', () => {
  const approved = labelEvent(3, 'labeled', '2026-11-21T00:02:00Z');
  const events = [
    labelEvent(1, 'labeled', '2026-11-20T23:59:00Z'),
    labelEvent(2, 'unlabeled', '2026-11-21T00:01:00Z'),
    approved,
  ];
  assert.deepEqual(
    currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']),
    approved,
  );
});

test('撤标后当前标签仍在但最新事件是撤标时拒绝', () => {
  const events = [
    labelEvent(1, 'labeled', '2026-11-21T00:01:00Z'),
    labelEvent(2, 'unlabeled', '2026-11-21T00:02:00Z'),
  ];
  assert.equal(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), null);
});

test('撤标和重贴可从乱序事件恢复，并返回最新可信添加', () => {
  const relabel = labelEvent(3, 'labeled', '2026-11-21T00:03:00Z');
  const events = [
    relabel,
    labelEvent(1, 'labeled', '2026-11-21T00:01:00Z'),
    labelEvent(2, 'unlabeled', '2026-11-21T00:02:00Z'),
  ];
  assert.deepEqual(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), relabel);
});

test('当前标签、版本和白名单必须同时精确匹配', () => {
  const events = [labelEvent(1, 'labeled', '2026-11-21T00:01:00Z')];
  assert.equal(currentDispatchGrant(events, [], 1, PUBLISHED_AT, ['42']), null);
  assert.equal(currentDispatchGrant(events, [LABEL], 2, PUBLISHED_AT, ['42']), null);
  assert.equal(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['7']), null);
  assert.equal(
    currentDispatchGrant([labelEvent(1, 'labeled', '2026-11-21T00:01:00Z', null)], [LABEL], 1, PUBLISHED_AT, ['42']),
    null,
  );
});

test('发布时间前的历史标签即使当前仍存在也不能授权本版', () => {
  assert.equal(
    currentDispatchGrant(
      [labelEvent(1, 'labeled', '2026-11-20T23:59:59Z')],
      [LABEL],
      1,
      PUBLISHED_AT,
      ['42'],
    ),
    null,
  );
  assert.equal(
    currentDispatchGrant(
      [labelEvent(2, 'labeled', PUBLISHED_AT)],
      [LABEL],
      1,
      PUBLISHED_AT,
      ['42'],
    ),
    null,
    '与发布同一时刻无法证明发生在发布之后',
  );
});

test('最新添加来自非白名单用户时拒绝', () => {
  const events = [
    labelEvent(1, 'labeled', '2026-11-21T00:01:00Z'),
    labelEvent(2, 'labeled', '2026-11-21T00:02:00Z', '99'),
  ];
  assert.equal(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), null);
});

test('相同事件 ID 且记录一致时去重，不制造同秒歧义', () => {
  const approved = labelEvent(1, 'labeled', '2026-11-21T00:01:00Z');
  assert.deepEqual(
    currentDispatchGrant([approved, { ...approved }], [LABEL], 1, PUBLISHED_AT, ['42']),
    approved,
  );
});

test('相同事件 ID 内容矛盾时视为事件流不可信并拒绝', () => {
  const events = [
    labelEvent(1, 'labeled', '2026-11-21T00:01:00Z'),
    labelEvent(1, 'labeled', '2026-11-21T00:02:00Z'),
  ];
  assert.equal(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), null);
});

test('本版最新相关事件同秒无法定序时拒绝', () => {
  const events = [
    labelEvent(1, 'labeled', '2026-11-21T00:01:00Z'),
    labelEvent(2, 'unlabeled', '2026-11-21T00:01:00Z'),
  ];
  assert.equal(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), null);
});

test('历史同秒歧义不阻断之后明确更新的合法授权', () => {
  const relabel = labelEvent(3, 'labeled', '2026-11-21T00:02:00Z');
  const events = [
    labelEvent(1, 'labeled', '2026-11-21T00:01:00Z'),
    labelEvent(2, 'unlabeled', '2026-11-21T00:01:00Z'),
    relabel,
  ];
  assert.deepEqual(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), relabel);
});

test('当前标签存在但没有发布时间后的完整添加事件时按缺页拒绝', () => {
  const events = [
    labelEvent(1, 'unlabeled', '2026-11-21T00:01:00Z'),
    labelEvent(2, 'labeled', '2026-11-21T00:02:00Z', '42', '可开工/r2'),
  ];
  assert.equal(currentDispatchGrant(events, [LABEL], 1, PUBLISHED_AT, ['42']), null);
});

test('非法版本、发布时间和事件字段均 fail closed', () => {
  const approved = labelEvent(1, 'labeled', '2026-11-21T00:01:00Z');
  assert.equal(currentDispatchGrant([approved], [LABEL], 0, PUBLISHED_AT, ['42']), null);
  assert.equal(currentDispatchGrant([approved], [LABEL], 1, 'not-a-time', ['42']), null);
  assert.equal(
    currentDispatchGrant([labelEvent(0, 'labeled', '2026-11-21T00:01:00Z')], [LABEL], 1, PUBLISHED_AT, ['42']),
    null,
  );
  assert.equal(
    currentDispatchGrant([labelEvent(1, 'labeled', 'not-a-time')], [LABEL], 1, PUBLISHED_AT, ['42']),
    null,
  );
});

test('配置默认拒绝所有派工，并从环境变量读取去空白后的逗号列表', () => {
  const previousAllowed = process.env.SPEC_LOOP_DISPATCH_ALLOWED_USER_IDS;
  const previousEnvFile = process.env.SPEC_LOOP_ENV_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'spec-loop-dispatch-config-'));
  try {
    delete process.env.SPEC_LOOP_DISPATCH_ALLOWED_USER_IDS;
    process.env.SPEC_LOOP_ENV_FILE = '';
    assert.deepEqual(loadConfig(dir).dispatchAllowedUserIds, []);

    process.env.SPEC_LOOP_DISPATCH_ALLOWED_USER_IDS = ' 42, ,43 ';
    assert.deepEqual(loadConfig(dir).dispatchAllowedUserIds, ['42', '43']);
  } finally {
    if (previousAllowed === undefined) delete process.env.SPEC_LOOP_DISPATCH_ALLOWED_USER_IDS;
    else process.env.SPEC_LOOP_DISPATCH_ALLOWED_USER_IDS = previousAllowed;
    if (previousEnvFile === undefined) delete process.env.SPEC_LOOP_ENV_FILE;
    else process.env.SPEC_LOOP_ENV_FILE = previousEnvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GithubClient 读取仓库 ID、单张 Issue，并拒绝把 PR 当作 Issue', async () => {
  const runner: GhRunner = async (args) => {
    const path = args[1] ?? '';
    if (path === 'repos/o/r') {
      return { stdout: JSON.stringify({ id: 7001 }), stderr: '', code: 0 };
    }
    if (path === 'repos/o/r/issues/7') {
      return {
        stdout: JSON.stringify({
          number: 7,
          title: '受管 Issue',
          body: '<!-- spec-loop:meta\n{"reqId":"REQ-1"}\n-->',
          state: 'open',
          labels: [{ name: LABEL }],
          html_url: 'https://github.test/o/r/issues/7',
        }),
        stderr: '',
        code: 0,
      };
    }
    if (path === 'repos/o/r/issues/8') {
      return {
        stdout: JSON.stringify({
          number: 8,
          title: 'PR',
          state: 'open',
          pull_request: {},
        }),
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '', stderr: 'unexpected', code: 1 };
  };

  const github = new GithubClient('o/r', runner);
  assert.equal(await github.getDispatchRepositoryId(), '7001');
  const issue = await github.getDispatchIssue(7);
  assert.equal(issue.number, 7);
  assert.deepEqual(issue.labels, [LABEL]);
  assert.equal(issue.meta?.reqId, 'REQ-1');
  await assert.rejects(() => github.getDispatchIssue(8), /是 PR/);
});

test('GithubClient 完整展开标签事件分页并保留未知操作者', async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async (args): Promise<GhResult> => {
    calls.push(args);
    return {
      stdout: JSON.stringify([
        [{
          id: 11,
          event: 'labeled',
          actor: { id: 42 },
          label: { name: LABEL },
          created_at: '2026-11-21T00:01:00Z',
        }],
        [
          {
            id: 12,
            event: 'unlabeled',
            actor: null,
            label: { name: LABEL },
            created_at: '2026-11-21T00:02:00Z',
          },
          {
            id: 13,
            event: 'closed',
            actor: { id: 42 },
            created_at: '2026-11-21T00:03:00Z',
          },
        ],
      ]),
      stderr: '',
      code: 0,
    };
  };

  const github = new GithubClient('o/r', runner);
  const events = await github.listDispatchLabelEvents(7);
  assert.deepEqual(events, [
    {
      id: 11,
      actorId: '42',
      name: LABEL,
      event: 'labeled',
      createdAt: '2026-11-21T00:01:00Z',
    },
    {
      id: 12,
      actorId: null,
      name: LABEL,
      event: 'unlabeled',
      createdAt: '2026-11-21T00:02:00Z',
    },
  ]);
  assert.ok(calls[0]?.includes('--paginate'));
  assert.ok(calls[0]?.includes('--slurp'));
});

test('GithubClient 遇到标签事件分页或字段残缺时拒绝返回部分结果', async () => {
  const brokenPage: GhRunner = async () => ({
    stdout: JSON.stringify([[], {}]),
    stderr: '',
    code: 0,
  });
  await assert.rejects(
    () => new GithubClient('o/r', brokenPage).listDispatchLabelEvents(7),
    /分页|事件/,
  );

  const missingLabel: GhRunner = async () => ({
    stdout: JSON.stringify([[
      {
        id: 11,
        event: 'labeled',
        actor: { id: 42 },
        created_at: '2026-11-21T00:01:00Z',
      },
    ]]),
    stderr: '',
    code: 0,
  });
  await assert.rejects(
    () => new GithubClient('o/r', missingLabel).listDispatchLabelEvents(7),
    /字段残缺/,
  );
});

test('ensureDispatchLabel 对已存在定义只读确认，不调用创建也不打标', async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1]?.includes('/labels/')) {
      return { stdout: JSON.stringify({ name: LABEL }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  await new GithubClient('o/r', runner).ensureDispatchLabel(LABEL);
  assert.deepEqual(calls, [[
    'api',
    `repos/o/r/labels/${encodeURIComponent(LABEL)}`,
  ]]);
  assert.equal(calls[0]?.some((arg) => arg === '--force'), false);
  assert.equal(calls[0]?.some((arg) => arg === '--add-label'), false);
});

test('ensureDispatchLabel 在定义缺失时创建不带 --force，并处理并发已存在', async () => {
  const calls: string[][] = [];
  let definitionExists = false;
  let createCalls = 0;
  const runner: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1]?.includes('/labels/')) {
      return definitionExists
        ? { stdout: JSON.stringify({ name: LABEL }), stderr: '', code: 0 }
        : { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
    }
    if (args[0] === 'label' && args[1] === 'create') {
      createCalls += 1;
      definitionExists = true;
      return { stdout: '', stderr: 'already exists', code: 1 };
    }
    return { stdout: '', stderr: 'unexpected', code: 1 };
  };

  await new GithubClient('o/r', runner).ensureDispatchLabel(LABEL);
  assert.equal(createCalls, 1);
  const createArgs = calls.find((args) => args[0] === 'label' && args[1] === 'create');
  assert.deepEqual(createArgs, ['label', 'create', LABEL, '--repo', 'o/r']);
  assert.equal(calls.some((args) => args.includes('--force')), false);
});

interface FakeComment {
  id: number;
  body: string;
  userId: number | null;
  createdAt: string;
}

function commentApi(comments: FakeComment[], options: {
  createCode?: number;
  loseCreateResponse?: boolean;
  malformedCreateResponse?: boolean;
  onPost?: () => void;
} = {}): { runner: GhRunner; posts: string[] } {
  const posts: string[] = [];
  let nextId = 100;
  const runner: GhRunner = async (args, opts) => {
    const path = args.find((arg) => arg.startsWith('repos/o/r/')) ?? '';
    if (args[0] === 'api' && args[1] === 'user') {
      return { stdout: JSON.stringify({ id: 42 }), stderr: '', code: 0 };
    }
    if (args.includes('--paginate') && path.includes('/comments')) {
      return {
        stdout: JSON.stringify([comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: comment.userId === null ? null : { id: comment.userId },
          created_at: comment.createdAt,
        }))]),
        stderr: '',
        code: 0,
      };
    }
    if (args.includes('--method') && path.includes('/comments')) {
      const payload = JSON.parse(opts?.input ?? '{}') as { body?: string };
      posts.push(payload.body ?? '');
      options.onPost?.();
      const created: FakeComment = {
        id: nextId++,
        body: payload.body ?? '',
        userId: 42,
        createdAt: '2026-11-21T00:05:00Z',
      };
      comments.push(created);
      if (options.loseCreateResponse) {
        return { stdout: '', stderr: 'timeout', code: 124 };
      }
      if (options.malformedCreateResponse) {
        return { stdout: '{}', stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({
          id: created.id,
          body: created.body,
          user: { id: created.userId },
          created_at: created.createdAt,
        }),
        stderr: '',
        code: options.createCode ?? 0,
      };
    }
    return { stdout: '', stderr: 'unexpected', code: 1 };
  };
  return { runner, posts };
}

test('ensureDispatchComment 复用唯一可信精确 marker，忽略伪造与子串', async () => {
  const marker = '<!-- dispatch:r1 -->';
  const body = `${marker}\n状态：可开工`;
  const comments: FakeComment[] = [
    {
      id: 1,
      body: `伪造 ${marker} 子串`,
      userId: 42,
      createdAt: '2026-11-21T00:01:00Z',
    },
    {
      id: 2,
      body: `${marker}\n其他用户伪造`,
      userId: 99,
      createdAt: '2026-11-21T00:02:00Z',
    },
    {
      id: 3,
      body,
      userId: 42,
      createdAt: '2026-11-21T00:03:00Z',
    },
  ];
  const fake = commentApi(comments);
  const result = await new GithubClient('o/r', fake.runner)
    .ensureDispatchComment(7, marker, body);
  assert.deepEqual(result, { id: 3, createdAt: '2026-11-21T00:03:00Z' });
  assert.equal(fake.posts.length, 0);
});

test('ensureDispatchComment 仅在无可信评论时创建，并验证认证作者', async () => {
  const marker = '<!-- dispatch:r1 -->';
  const body = `${marker}\n状态：可开工`;
  const comments: FakeComment[] = [
    {
      id: 2,
      body,
      userId: 99,
      createdAt: '2026-11-21T00:02:00Z',
    },
  ];
  const fake = commentApi(comments);
  const result = await new GithubClient('o/r', fake.runner)
    .ensureDispatchComment(7, marker, body);
  assert.equal(result.id, 100);
  assert.equal(fake.posts.length, 1);
});

test('ensureDispatchComment 对同 marker 不同冻结依据拒绝，不创建也不复用', async () => {
  const marker = '<!-- dispatch:r1 -->';
  const expectedBody = `${marker}\n规格：new-spec\n来源：new-source`;
  const staleBody = `${marker}\n规格：old-spec\n来源：old-source`;
  const fake = commentApi([
    {
      id: 1,
      body: staleBody,
      userId: 42,
      createdAt: '2026-11-21T00:01:00Z',
    },
  ]);
  await assert.rejects(
    () => new GithubClient('o/r', fake.runner)
      .ensureDispatchComment(7, marker, expectedBody),
    /冻结依据不一致/,
  );
  assert.equal(fake.posts.length, 0);
});

test('ensureDispatchComment 对重复可信 marker 或未知作者拒绝继续', async () => {
  const marker = '<!-- dispatch:r1 -->';
  const body = `${marker}\n状态：可开工`;
  const duplicate = commentApi([
    { id: 1, body, userId: 42, createdAt: '2026-11-21T00:01:00Z' },
    { id: 2, body, userId: 42, createdAt: '2026-11-21T00:02:00Z' },
  ]);
  await assert.rejects(
    () => new GithubClient('o/r', duplicate.runner).ensureDispatchComment(7, marker, body),
    /重复/,
  );
  assert.equal(duplicate.posts.length, 0);

  const unknown = commentApi([
    { id: 1, body, userId: null, createdAt: '2026-11-21T00:01:00Z' },
  ]);
  await assert.rejects(
    () => new GithubClient('o/r', unknown.runner).ensureDispatchComment(7, marker, body),
    /无法确认作者/,
  );
  assert.equal(unknown.posts.length, 0);
});

test('ensureDispatchComment 创建响应丢失或残缺时回读唯一可信结果', async () => {
  const marker = '<!-- dispatch:r1 -->';
  const body = `${marker}\n状态：可开工`;
  for (const options of [
    { loseCreateResponse: true },
    { malformedCreateResponse: true },
  ]) {
    const fake = commentApi([], options);
    const result = await new GithubClient('o/r', fake.runner)
      .ensureDispatchComment(7, marker, body);
    assert.equal(result.id, 100);
    assert.equal(fake.posts.length, 1);
  }
});

test('ensureDispatchComment 对 marker 格式和正文精确行做本地校验', async () => {
  const github = new GithubClient('o/r', async () => {
    throw new Error('不应访问 gh');
  });
  await assert.rejects(
    () => github.ensureDispatchComment(7, ' marker ', 'marker'),
    /marker/,
  );
  await assert.rejects(
    () => github.ensureDispatchComment(7, 'marker', 'prefix marker suffix'),
    /独占一行/,
  );
});

test('listTrustedDispatchComments 只返回认证控制器评论，普通用户伪造 marker 不计入', async () => {
  const markerFor = (revision: number): string => `spec-loop:dispatch:REQ-CNT-01:r${revision}`;
  const fake = commentApi([
    {
      id: 1,
      body: `${markerFor(1)}\n状态：待排期`,
      userId: 42,
      createdAt: '2026-11-21T00:01:00Z',
    },
    {
      id: 2,
      body: `${markerFor(Number.MAX_SAFE_INTEGER)}\n普通用户伪造高水位`,
      userId: 99,
      createdAt: '2026-11-21T00:02:00Z',
    },
  ]);

  const trustComments = await new GithubClient('o/r', fake.runner)
    .listTrustedDispatchComments(7);
  assert.deepEqual(trustComments, [{
    id: 1,
    body: `${markerFor(1)}\n状态：待排期`,
    createdAt: '2026-11-21T00:01:00Z',
  }]);
});
