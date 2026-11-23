import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPanelView,
  normalizeState,
  type PanelDeliveryGroup,
  type PanelMeta,
  type PanelRequest,
} from '../orchestrator/panel-view.ts';
import { projectPanelWait, type PanelWaitInput } from '../orchestrator/panel-wait.ts';
import { filterTestRunsResponse } from '../orchestrator/panel-server.ts';
import {
  createManualTestRunRecord,
  parseTestRunRecord,
  type TestRunsResponse,
} from '../orchestrator/test-evidence.ts';
import { createNodeTestRunRecord } from '../orchestrator/test-evidence-node.ts';
import { hashSpecBody } from '../orchestrator/specs.ts';

const REQ_ID = 'REQ-PANEL-01';
const OTHER_REQ_ID = 'REQ-PANEL-02';
const REQUEST_ID = 'abcdef123456';
const OTHER_REQUEST_ID = 'fedcba654321';
const SPEC_PATH = 'docs/specs/pending/panel.md';
const REPO_ID = 'github-repository-id:9001';
const HASH_R1 = 'a'.repeat(64);
const HASH_R2 = 'b'.repeat(64);
const SHA_R1 = '1'.repeat(40);
const SHA_R2 = '2'.repeat(40);
const SHA_OTHER = '3'.repeat(40);
const PANEL_SPEC_BODY = [
  '### [REQ-PANEL-01] 面板等待说明',
  '',
  '操作者能看到本版等待角色、依据和下一步。',
].join('\n');
const T_0900 = '2026-11-23T09:00:00.000Z';
const T_0901 = '2026-11-23T09:01:00.000Z';
const T_0902 = '2026-11-23T09:02:00.000Z';
const T_0903 = '2026-11-23T09:03:00.000Z';
const T_0904 = '2026-11-23T09:04:00.000Z';
const T_1000 = '2026-11-23T10:00:00.000Z';

function meta(overrides: Partial<PanelMeta> = {}): PanelMeta {
  return {
    observedAt: T_1000,
    stateUpdatedAt: T_0904,
    stateKind: 'ok',
    controllerOnline: true,
    ...overrides,
  };
}

function requirement(
  reqId = REQ_ID,
  specHash = HASH_R1,
  sourceMainSha = SHA_R1,
  issueNumber = 18,
): Record<string, unknown> {
  return { issueNumber, specHash, specPath: SPEC_PATH, sourceMainSha };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    targetReqId: REQ_ID,
    stage: 'pr-open',
    prNumber: 41,
    summary: '面板等待说明',
    baseSHA: SHA_R1,
    createdAt: T_0900,
    updatedAt: T_0901,
    ...overrides,
  };
}

function revision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reqId: REQ_ID,
    repoId: REPO_ID,
    revision: 1,
    issueNumber: 18,
    specHash: HASH_R1,
    specPath: SPEC_PATH,
    sourceMainSha: SHA_R1,
    task: { goal: '只读投影', steps: [], acceptance: {}, allowedPaths: [], dependsOn: [] },
    publishedAt: T_0902,
    publicationCommentId: 801,
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: 'job-panel-r1-a1',
    reqId: REQ_ID,
    issueNumber: 18,
    specHash: HASH_R1,
    sourceMainSha: SHA_R1,
    attempt: 1,
    status: 'processing',
    dispatchRevision: 1,
    startedAt: T_0903,
    updatedAt: T_0904,
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repo: 'sunpcm/spec-loop',
    cursorMainSha: SHA_R1,
    requirements: { [REQ_ID]: requirement() },
    jobs: {},
    deploy: { activeSha: null, deployedPRs: [], deployFailedPRs: [] },
    specRequests: {},
    mergeRequests: {},
    dispatchRevisions: { [REQ_ID]: [revision()] },
    ...overrides,
  };
}

function viewOf(raw: Record<string, unknown>, panelMeta = meta()) {
  const normalized = normalizeState(raw);
  assert.ok(normalized, '测试状态应为合法 panel 输入');
  return buildPanelView(normalized, panelMeta);
}

function onlyGroup(view: ReturnType<typeof viewOf>): PanelDeliveryGroup {
  assert.equal(view.deliveryGroups.length, 1);
  return view.deliveryGroups[0]!;
}

function onlyRequest(view: ReturnType<typeof viewOf>): PanelRequest {
  assert.equal(view.requests.length, 1);
  return view.requests[0]!;
}

test('文档 PR 打开时只提示操作者确认文档，并给出该 PR 入口', () => {
  const view = viewOf(state({
    requirements: {},
    dispatchRevisions: {},
    specRequests: { [REQUEST_ID]: request() },
  }));
  const item = onlyRequest(view);
  assert.equal(item.waiting.title, '等你确认文档');
  assert.equal(item.waiting.role, 'operator');
  assert.equal(item.waiting.humanActionRequired, true);
  assert.equal(item.version.specPath, SPEC_PATH);
  assert.equal(
    item.evidence.find((entry) => entry.kind === 'document-pr')?.href,
    'https://github.com/sunpcm/spec-loop/pull/41',
  );

  const unknownReq = viewOf(state({
    requirements: {},
    dispatchRevisions: {},
    specRequests: {
      [REQUEST_ID]: request({ targetReqId: 'REQ-PANEL-99' }),
    },
  }));
  assert.equal(onlyRequest(unknownReq).version.specPath, null);

  const counterReq = viewOf(state({
    requirements: {},
    dispatchRevisions: {},
    specRequests: {
      [REQUEST_ID]: request({
        targetReqId: 'REQ-CNT-01',
        docContent: '### [REQ-CNT-01] 计数器\n\n实现一个递增计数器。\n',
      }),
    },
  }));
  assert.equal(onlyRequest(counterReq).version.specPath, 'docs/specs/counter.md');
});

test('无 specRequest 时必须以受信文档合并和任务缺失观察识别待登记，不能由缺记录猜测', () => {
  const noRecord = viewOf(state({
    requirements: {},
    dispatchRevisions: {},
    specRequests: {},
  }));
  assert.equal(noRecord.requests.length, 0);
  assert.equal(noRecord.deliveryGroups.length, 0);

  const view = viewOf(state({
    requirements: {},
    dispatchRevisions: {},
    specRequests: {
      [REQUEST_ID]: request({ stage: 'pr-merged', mergedMainSha: SHA_R1, updatedAt: T_0902 }),
    },
  }));
  const item = onlyRequest(view);
  assert.equal(item.waiting.title, '待核实');
  assert.equal(item.waiting.role, 'unknown');
  assert.ok(item.evidence.some((entry) => (
    entry.kind === 'document-merge'
    && entry.href === `https://github.com/sunpcm/spec-loop/commit/${SHA_R1}`
  )));

  const projectionInput: Omit<PanelWaitInput, 'taskRegistration'> = {
    controllerOnline: true,
    stateObservedAt: T_0904,
    observedAt: T_0904,
    documentStage: 'pr-merged',
    revision: null,
    primaryJob: null,
    activeOtherJob: false,
    nodes: [],
    deploymentReceiptHref: null,
    conflict: false,
    superseded: false,
  };
  const unknown = projectPanelWait({ ...projectionInput, taskRegistration: 'unknown' });
  assert.equal(unknown.title, '待核实');
  assert.match(unknown.evidenceGaps[0] ?? '', /任务登记或明确缺失观察/);

  const observedAbsent = projectPanelWait({ ...projectionInput, taskRegistration: 'absent' });
  assert.equal(observedAbsent.title, '等任务 Agent 发布清单');
  assert.equal(observedAbsent.role, 'task-agent');
  assert.match(observedAbsent.reason, /核对同仓、同需求、同版本任务仍不存在/);
});

test('冻结未发布 revision 经生产视图等待任务 Agent 发布清单，并与已发布、仅有合并、歧义和离线区分', () => {
  const frozen = viewOf(state({
    requirements: {},
    dispatchRevisions: {
      [REQ_ID]: [revision({
        publishedAt: undefined,
        publicationCommentId: undefined,
      })],
    },
  }));
  const frozenGroup = onlyGroup(frozen);
  assert.equal(frozen.requests.length, 0);
  assert.equal(frozenGroup.waiting.title, '等任务 Agent 发布清单');
  assert.equal(frozenGroup.waiting.role, 'task-agent');
  assert.equal(frozenGroup.waiting.humanActionRequired, false);
  assert.deepEqual(
    frozenGroup.waiting.evidenceGaps,
    ['冻结派工记录已存在，但任务清单发布评论尚未回读。'],
  );
  assert.equal(
    frozenGroup.evidence.find((entry) => entry.kind === 'issue')?.href,
    'https://github.com/sunpcm/spec-loop/issues/18',
  );
  const frozenPublication = frozenGroup.evidence.find(
    (entry) => entry.kind === 'dispatch-publication',
  );
  assert.equal(frozenPublication?.href, null);
  assert.equal(frozenPublication?.observedAt, null);
  assert.match(frozenPublication?.label ?? '', /冻结派工版本 r1/);
  assert.equal(frozenGroup.evidence.some((entry) => entry.kind === 'document-merge'), false);
  assert.equal(frozenGroup.evidence.some((entry) => entry.kind === 'code-pr'), false);

  const linkedHash = hashSpecBody(PANEL_SPEC_BODY);
  const linked = viewOf(state({
    requirements: {},
    dispatchRevisions: {
      [REQ_ID]: [revision({
        specHash: linkedHash,
        publishedAt: undefined,
        publicationCommentId: undefined,
      })],
    },
    specRequests: {
      [REQUEST_ID]: request({
        stage: 'pr-merged',
        mergedMainSha: SHA_R1,
        docContent: PANEL_SPEC_BODY,
        updatedAt: T_0902,
      }),
    },
  }));
  const linkedGroup = onlyGroup(linked);
  const linkedRequestItem = onlyRequest(linked);
  assert.equal(linkedRequestItem.waiting.title, '等任务 Agent 发布清单');
  assert.equal(linkedRequestItem.waiting.role, 'task-agent');
  assert.equal(linkedRequestItem.linkedDeliveryIds.length, 1);
  assert.equal(linkedRequestItem.version.specPath, linkedGroup.version.specPath);
  assert.equal(linkedRequestItem.version.specPath, SPEC_PATH);

  const published = viewOf(state({
    requirements: {},
    dispatchRevisions: {
      [REQ_ID]: [revision({
        observation: { state: 'awaiting-label', observedAt: T_0903 },
      })],
    },
  }));
  assert.equal(onlyGroup(published).waiting.title, '等你排期');
  assert.equal(onlyGroup(published).waiting.role, 'operator');

  const mergedOnly = viewOf(state({
    requirements: {},
    dispatchRevisions: {},
    specRequests: {
      [REQUEST_ID]: request({ stage: 'pr-merged', mergedMainSha: SHA_R1, updatedAt: T_0902 }),
    },
  }));
  assert.equal(onlyRequest(mergedOnly).waiting.title, '待核实');
  assert.equal(onlyRequest(mergedOnly).waiting.role, 'unknown');

  const ambiguous = viewOf(state({
    requirements: {},
    jobs: {},
    dispatchRevisions: {
      [REQ_ID]: [
        revision({
          publishedAt: undefined,
          publicationCommentId: undefined,
        }),
        revision({
          revision: 2,
          publishedAt: undefined,
          publicationCommentId: undefined,
        }),
      ],
    },
    specRequests: {
      [REQUEST_ID]: request({ stage: 'pr-merged', mergedMainSha: SHA_R1, updatedAt: T_0902 }),
    },
  }));
  const ambiguousRequest = onlyRequest(ambiguous);
  assert.equal(ambiguousRequest.waiting.title, '待核实');
  assert.equal(ambiguousRequest.waiting.basis, 'conflict');
  assert.equal(ambiguousRequest.linkedDeliveryIds.length, 0);

  const offline = viewOf(state({
    requirements: {},
    dispatchRevisions: {
      [REQ_ID]: [revision({
        publishedAt: undefined,
        publicationCommentId: undefined,
      })],
    },
  }), meta({
    controllerOnline: false,
    stateUpdatedAt: T_0904,
    observedAt: T_1000,
  }));
  const offlineGroup = onlyGroup(offline);
  assert.equal(offlineGroup.waiting.title, '控制器离线');
  assert.equal(offlineGroup.waiting.basis, 'cached');
  assert.equal(offlineGroup.waiting.observedAt, T_0904);
});

test('已发布 rev 缺少 observation 时固定待核实，不能由旧 grant 或缺 grant 猜测角色', () => {
  const raw = state({
    specRequests: { [REQUEST_ID]: request({ stage: 'pr-merged', mergedMainSha: SHA_R1 }) },
    dispatchRevisions: {
      [REQ_ID]: [revision({
        grant: {
          eventId: 77,
          actorId: 'github-user-id:7001',
          grantedAt: T_0900,
        },
      })],
    },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.waiting.title, '待核实');
  assert.equal(group.waiting.role, 'unknown');
  assert.equal(group.waiting.basis, 'unknown');
  assert.match(group.waiting.reason, /缺少发布后的当前许可观察/);
  assert.deepEqual(group.waiting.evidenceGaps, ['缺少发布后的当前许可观察，不能据此判断等待谁。']);
  assert.equal(group.evidence.some((entry) => entry.kind === 'dispatch-grant'), false);
});

test('发布后观察到本版无许可时提示准确批次标签', () => {
  const raw = state({
    specRequests: { [REQUEST_ID]: request({ stage: 'pr-merged', mergedMainSha: SHA_R1 }) },
    dispatchRevisions: {
      [REQ_ID]: [revision({
        observation: { state: 'awaiting-label', observedAt: T_0903 },
      })],
    },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.waiting.title, '等你排期');
  assert.equal(group.waiting.role, 'operator');
  assert.match(group.waiting.nextAction, /可开工\/r1/);
  assert.equal(group.waiting.observedAt, T_0904);
  assert.ok(group.evidence.some((entry) => entry.label === '许可观察 awaiting-label'));
});

test('已授权但唯一作业名额被占用时等待调度器，本版已领取时显示 Code Agent', () => {
  const blocked = state({
    jobs: {
      'job-other': job({
        jobId: 'job-other',
        reqId: OTHER_REQ_ID,
        issueNumber: 19,
        specHash: HASH_R2,
        sourceMainSha: SHA_OTHER,
        dispatchRevision: 1,
        status: 'processing',
      }),
    },
    dispatchRevisions: {
      [REQ_ID]: [revision({
        observation: { state: 'authorized', observedAt: T_0903 },
      })],
    },
  });
  const scheduler = viewOf(blocked).deliveryGroups.find((group) => group.reqId === REQ_ID)!;
  assert.equal(scheduler.waiting.title, '等调度器');
  assert.equal(scheduler.waiting.role, 'scheduler');
  assert.match(scheduler.waiting.reason, /唯一作业名额/);

  const executing = state({
    jobs: { [String(job().jobId)]: job({ status: 'todo' }) },
    dispatchRevisions: {
      [REQ_ID]: [revision({
        observation: { state: 'authorized', observedAt: T_0903 },
      })],
    },
  });
  const codeAgent = onlyGroup(viewOf(executing));
  assert.equal(codeAgent.waiting.title, 'Code Agent 正在执行');
  assert.equal(codeAgent.waiting.role, 'code-agent');
});

test('本版代码 PR 待审时提示人工角色并只提供本版 PR 入口', () => {
  const raw = state({
    jobs: {
      'job-review': job({
        jobId: 'job-review',
        status: 'in-review',
        prNumber: 52,
        headSHA: '4'.repeat(40),
      }),
    },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.waiting.title, '等你审查代码');
  assert.equal(group.waiting.role, 'operator');
  assert.match(group.waiting.reason, /PR #52/);
  assert.equal(
    group.evidence.find((entry) => entry.kind === 'code-pr')?.href,
    'https://github.com/sunpcm/spec-loop/pull/52',
  );
});

test('合并后部署进行中或回执待补时不会提前显示完成', () => {
  const deploying = state({
    jobs: {
      'job-done': job({
        jobId: 'job-done',
        status: 'done',
        prNumber: 53,
        headSHA: '4'.repeat(40),
      }),
    },
    mergeRequests: {
      m1: {
        requestId: 'm1',
        repo: 'sunpcm/spec-loop',
        type: 'code',
        stage: 'merged',
        prNumber: 53,
        headSHA: '4'.repeat(40),
      },
    },
  });
  const running = onlyGroup(viewOf(deploying));
  assert.equal(running.waiting.title, '等控制器完成发布');
  assert.equal(running.waiting.state, 'waiting');

  const receiptPending = state({
    jobs: {
      'job-done': job({
        jobId: 'job-done',
        status: 'done',
        prNumber: 53,
        resumeAction: 'sync-deploy-receipt',
      }),
    },
    deploy: { activeSha: SHA_R1, deployedPRs: [53], deployFailedPRs: [] },
  });
  const pending = onlyGroup(viewOf(receiptPending));
  assert.equal(pending.waiting.title, '等控制器完成发布');
  assert.match(pending.waiting.reason, /回执尚未补齐/);
  assert.equal(pending.nodes.find((node) => node.id === 'health-receipt')?.status, 'waiting');
});

test('受控合并记录已证实本版 PR 时优先等控制器发布，不被滞后的 in-review 抢回人工审查', () => {
  const headSHA = '4'.repeat(40);
  const raw = state({
    jobs: {
      'job-merged': job({
        jobId: 'job-merged',
        status: 'in-review',
        prNumber: 54,
        headSHA,
      }),
    },
    mergeRequests: {
      m1: {
        requestId: 'm1',
        repo: 'sunpcm/spec-loop',
        type: 'code',
        stage: 'merged',
        prNumber: 54,
        headSHA,
      },
    },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.nodes.find((node) => node.id === 'code-confirm')?.status, 'succeeded');
  assert.equal(group.nodes.find((node) => node.id === 'build-deploy')?.status, 'running');
  assert.equal(group.waiting.title, '等控制器完成发布');
  assert.equal(group.waiting.role, 'controller');
  assert.equal(group.waiting.state, 'waiting');
});

test('本版验收失败指向按作业和版本筛选的 test-runs', () => {
  const raw = state({
    jobs: {
      'job-verify-failed': job({
        jobId: 'job-verify-failed',
        status: 'failed',
        failureStage: 'verify',
        prNumber: 61,
      }),
    },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.waiting.title, '等你处理验收失败');
  const evidence = group.evidence.find((entry) => entry.kind === 'test-runs');
  assert.ok(evidence?.href);
  const url = new URL(evidence.href, 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/test-runs');
  assert.equal(url.searchParams.get('jobId'), 'job-verify-failed');
  assert.equal(url.searchParams.get('reqId'), REQ_ID);
  assert.equal(url.searchParams.get('specHash'), HASH_R1);
  assert.equal(url.searchParams.get('specPath'), SPEC_PATH);
  assert.equal(url.searchParams.get('dispatchRevision'), '1');
  assert.equal(url.searchParams.get('sourceMainSha'), SHA_R1);
  assert.match(evidence.label, /r1/);
  assert.match(evidence.label, /docs\/specs\/pending\/panel\.md/);
  assert.match(group.waiting.evidenceGaps[0] ?? '', /未索引本版 test-runs/);
});

test('部署记录缺少真实回执地址时待核实且不以无地址记录冒充完成', () => {
  const raw = state({
    jobs: {
      'job-deployed': job({
        jobId: 'job-deployed',
        status: 'done',
        prNumber: 62,
      }),
    },
    deploy: { activeSha: SHA_R1, deployedPRs: [62], deployFailedPRs: [] },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.waiting.title, '待核实');
  assert.match(group.waiting.reason, /缺少可定位的健康检查与部署回执/);
  assert.match(group.waiting.evidenceGaps[0] ?? '', /不能据 PR 部署结果冒充完整回执/);
  assert.equal(group.evidence.some((entry) => entry.kind === 'deployment'), false);
});

test('真实部署回执严格绑定同一作业和版本后提供 issuecomment 入口', () => {
  const raw = state({
    jobs: {
      'job-receipt': job({
        jobId: 'job-receipt',
        status: 'done',
        prNumber: 62,
        deployReceipt: {
          issueNumber: 18,
          prNumber: 62,
          dispatchRevision: 1,
          mergeSha: SHA_R1,
          commentId: 9001,
          recordedAt: T_0904,
        },
      }),
    },
    deploy: { activeSha: SHA_R1, deployedPRs: [62], deployFailedPRs: [] },
  });
  const group = onlyGroup(viewOf(raw, meta({
    panelActiveSha: SHA_R1,
    panelActiveObservedAt: T_0904,
  })));
  assert.equal(group.waiting.title, '已部署，无需操作');
  assert.equal(
    group.evidence.find((entry) => entry.kind === 'deployment')?.href,
    'https://github.com/sunpcm/spec-loop/issues/18#issuecomment-9001',
  );
});

test('后续版本切换预览后，历史版本仍保留自己的真实部署回执入口', () => {
  const raw = state({
    requirements: {
      [REQ_ID]: requirement(REQ_ID, HASH_R2, SHA_R2),
    },
    jobs: {
      'job-r1-receipt': job({
        jobId: 'job-r1-receipt',
        status: 'done',
        prNumber: 62,
        deployReceipt: {
          issueNumber: 18,
          prNumber: 62,
          dispatchRevision: 1,
          mergeSha: SHA_R1,
          commentId: 9001,
          recordedAt: T_0904,
        },
      }),
    },
    deploy: {
      activeSha: SHA_R2,
      deployedPRs: [62, 72],
      deployFailedPRs: [],
    },
    dispatchRevisions: {
      [REQ_ID]: [
        revision(),
        revision({
          revision: 2,
          specHash: HASH_R2,
          sourceMainSha: SHA_R2,
          publishedAt: T_0904,
          publicationCommentId: 802,
        }),
      ],
    },
  });
  const r1 = viewOf(raw).deliveryGroups.find((group) => group.version.revision === 1)!;
  assert.equal(r1.superseded, true);
  assert.equal(r1.waiting.title, '历史版本');
  assert.equal(
    r1.evidence.find((entry) => entry.kind === 'deployment')?.href,
    'https://github.com/sunpcm/spec-loop/issues/18#issuecomment-9001',
  );
});

test('错 Issue 或错派工版本的部署回执进入待核实且不生成本版入口', () => {
  for (const deployReceipt of [
    {
      issueNumber: 19,
      prNumber: 62,
      dispatchRevision: 1,
      mergeSha: SHA_R1,
      commentId: 9001,
      recordedAt: T_0904,
    },
    {
      issueNumber: 18,
      prNumber: 62,
      dispatchRevision: 2,
      mergeSha: SHA_R1,
      commentId: 9001,
      recordedAt: T_0904,
    },
  ]) {
    const raw = state({
      jobs: {
        'job-receipt': job({
          jobId: 'job-receipt',
          status: 'done',
          prNumber: 62,
          deployReceipt,
        }),
      },
      deploy: { activeSha: SHA_R1, deployedPRs: [62], deployFailedPRs: [] },
    });
    const group = onlyGroup(viewOf(raw));
    assert.equal(group.waiting.title, '待核实');
    assert.equal(group.waiting.basis, 'conflict');
    assert.equal(group.evidence.some((entry) => entry.kind === 'deployment'), false);
  }
});

test('satisfied：回执待补与回执已补分明，均不得误报部署', () => {
  const pending = state({
    jobs: {
      'job-satisfied': job({
        jobId: 'job-satisfied',
        status: 'satisfied',
        candidateTreeSha: '5'.repeat(40),
        resumeAction: 'sync-satisfied-receipt',
        prNumber: undefined,
      }),
    },
  });
  const pendingGroup = onlyGroup(viewOf(pending));
  assert.equal(pendingGroup.waiting.title, '等控制器补齐回执');
  assert.equal(pendingGroup.waiting.role, 'controller');
  assert.match(pendingGroup.waiting.reason, /不涉及代码 PR 或部署/);
  assert.equal(pendingGroup.nodes.find((node) => node.id === 'build-deploy')?.status, 'pending');
  assert.equal(pendingGroup.nodes.find((node) => node.id === 'health-receipt')?.status, 'pending');

  const complete = state({
    jobs: {
      'job-satisfied': job({
        jobId: 'job-satisfied',
        status: 'satisfied',
        candidateTreeSha: '5'.repeat(40),
        prNumber: undefined,
      }),
    },
  });
  const completeGroup = onlyGroup(viewOf(complete));
  assert.equal(completeGroup.waiting.title, '已验收，无需代码变更');
  assert.equal(completeGroup.waiting.state, 'complete');
  assert.equal(completeGroup.waiting.role, 'none');
  assert.doesNotMatch(`${completeGroup.waiting.title} ${completeGroup.waiting.reason}`, /已部署/);
  const evidenceHref = completeGroup.evidence.find((entry) => entry.kind === 'test-runs')?.href;
  assert.ok(evidenceHref);
  const evidenceSearch = new URL(evidenceHref, 'http://127.0.0.1').searchParams;
  assert.equal(evidenceSearch.get('candidateTreeSha'), '5'.repeat(40));
  assert.equal(evidenceSearch.get('specPath'), SPEC_PATH);
  assert.equal(evidenceSearch.get('dispatchRevision'), '1');
  const evidenceLabel = completeGroup.evidence.find((entry) => entry.kind === 'test-runs')?.label;
  assert.match(evidenceLabel ?? '', /r1/);
  assert.match(evidenceLabel ?? '', /docs\/specs\/pending\/panel\.md/);
});

test('r1/r2 同 hash/SHA 仍按 revision 分组，旧 PR 和成功角色不污染 r2', () => {
  const raw = state({
    jobs: {
      'job-r1': job({
        jobId: 'job-r1',
        dispatchRevision: 1,
        status: 'in-review',
        prNumber: 71,
        headSHA: '6'.repeat(40),
      }),
    },
    dispatchRevisions: {
      [REQ_ID]: [
        revision({
          revision: 1,
          observation: { state: 'authorized', observedAt: T_0902 },
        }),
        revision({
          revision: 2,
          observation: { state: 'awaiting-label', observedAt: T_0904 },
        }),
      ],
    },
  });
  const view = viewOf(raw);
  assert.equal(view.deliveryGroups.length, 2);
  const r1 = view.deliveryGroups.find((group) => group.version.revision === 1)!;
  const r2 = view.deliveryGroups.find((group) => group.version.revision === 2)!;
  assert.notEqual(r1.id, r2.id);
  assert.equal(r1.superseded, true);
  assert.equal(r1.waiting.title, '历史版本');
  assert.equal(r1.evidence.some((entry) => entry.kind === 'code-pr'), true);
  assert.equal(r2.superseded, false);
  assert.equal(r2.waiting.title, '等你排期');
  assert.match(r2.waiting.nextAction, /可开工\/r2/);
  assert.equal(r2.evidence.some((entry) => entry.kind === 'code-pr'), false);
});

test('离线时保留上次实际观察时间并标记缓存，冲突优先于猜测角色', () => {
  const raw = state({
    dispatchRevisions: {
      [REQ_ID]: [revision({
        observation: { state: 'awaiting-label', observedAt: T_0903 },
      })],
    },
  });
  const offline = onlyGroup(viewOf(raw, meta({
    controllerOnline: false,
    stateUpdatedAt: T_0904,
    observedAt: T_1000,
  })));
  assert.equal(offline.waiting.title, '控制器离线');
  assert.equal(offline.waiting.basis, 'cached');
  assert.equal(offline.waiting.observedAt, T_0904);

  const conflicting = state({
    jobs: {
      'job-conflict': job({
        jobId: 'job-conflict',
        dispatchRevision: 2,
        specHash: HASH_R2,
        sourceMainSha: SHA_R2,
        status: 'processing',
      }),
    },
  });
  const conflict = viewOf(conflicting).deliveryGroups.find((group) => group.reqId === REQ_ID)!;
  assert.equal(conflict.waiting.title, '待核实');
  assert.equal(conflict.waiting.role, 'unknown');
  assert.equal(conflict.waiting.basis, 'conflict');
  assert.match(conflict.waiting.evidenceGaps[0] ?? '', /未选择任何记录/);
});

test('旧数据没有 dispatchRevisions 仍保留旧分组与执行角色', () => {
  const raw = state({
    dispatchRevisions: undefined,
    jobs: {
      'legacy-job': {
        jobId: 'legacy-job',
        reqId: REQ_ID,
        issueNumber: 18,
        specHash: HASH_R1,
        sourceMainSha: SHA_R1,
        attempt: 1,
        status: 'processing',
        startedAt: T_0903,
        updatedAt: T_0904,
      },
    },
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.version.revision, null);
  assert.equal(group.attempts[0]?.jobId, 'legacy-job');
  assert.equal(group.waiting.title, 'Code Agent 正在执行');
});

test('旧 requirement 缺少 specPath 时仍可读取，缺失路径不臆造', () => {
  const raw = state({
    requirements: {
      [REQ_ID]: {
        issueNumber: 18,
        specHash: HASH_R1,
        sourceMainSha: SHA_R1,
      },
    },
    dispatchRevisions: {},
  });
  const group = onlyGroup(viewOf(raw));
  assert.equal(group.version.specPath, null);
  assert.equal(group.waiting.title, '等控制器同步版本');
});

test('test-runs 只读筛选按 job 和完整版本身份精确匹配', () => {
  const response: TestRunsResponse = {
    schemaVersion: 'test-runs/v1',
    runs: [
      {
        id: 'run-r1',
        stage: 'browser',
        runner: 'playwright',
        version: SHA_R1,
        startedAt: T_0903,
        finishedAt: T_0904,
        jobId: 'job-panel-r1-a1',
        reqId: REQ_ID,
        specHash: HASH_R1,
        specPath: SPEC_PATH,
        dispatchRevision: 1,
        sourceMainSha: SHA_R1,
        candidateTreeSha: null,
        suiteFingerprint: 'suite-panel',
        ok: false,
        summary: null,
        cases: [],
      },
      {
        id: 'run-r2',
        stage: 'browser',
        runner: 'playwright',
        version: SHA_R2,
        startedAt: T_0903,
        finishedAt: T_0904,
        jobId: 'job-panel-r2-a1',
        reqId: REQ_ID,
        specHash: HASH_R1,
        specPath: SPEC_PATH,
        dispatchRevision: 2,
        sourceMainSha: SHA_R1,
        candidateTreeSha: null,
        suiteFingerprint: 'suite-panel',
        ok: true,
        summary: null,
        cases: [],
      },
    ],
  };
  const filtered = filterTestRunsResponse(response, new URLSearchParams({
    jobId: 'job-panel-r1-a1',
    reqId: REQ_ID,
    specHash: HASH_R1,
    specPath: SPEC_PATH,
    dispatchRevision: '1',
    sourceMainSha: SHA_R1,
  }));
  assert.deepEqual(filtered?.runs.map((run) => run.id), ['run-r1']);
  const sameHashes = filterTestRunsResponse(response, new URLSearchParams({
    reqId: REQ_ID,
    specHash: HASH_R1,
    specPath: SPEC_PATH,
    sourceMainSha: SHA_R1,
  }));
  assert.deepEqual(sameHashes?.runs.map((run) => run.id), ['run-r1', 'run-r2']);
  const r2 = filterTestRunsResponse(response, new URLSearchParams({
    reqId: REQ_ID,
    specHash: HASH_R1,
    specPath: SPEC_PATH,
    dispatchRevision: '2',
    sourceMainSha: SHA_R1,
  }));
  assert.deepEqual(r2?.runs.map((run) => run.id), ['run-r2']);
  assert.equal(filterTestRunsResponse(response, new URLSearchParams({ unknown: 'x' })), null);
  assert.equal(filterTestRunsResponse(response, new URLSearchParams({ specHash: 'not-a-hash' })), null);
  assert.equal(
    filterTestRunsResponse(response, new URLSearchParams({ specPath: 'docs/specs/../secret.md' })),
    null,
  );
  for (const dispatchRevision of ['0', '-1', '1.5', '9007199254740992']) {
    assert.equal(
      filterTestRunsResponse(response, new URLSearchParams({ dispatchRevision })),
      null,
      dispatchRevision,
    );
  }
  const duplicate = new URLSearchParams();
  duplicate.append('dispatchRevision', '1');
  duplicate.append('dispatchRevision', '2');
  assert.equal(filterTestRunsResponse(response, duplicate), null);
});

test('node:test 证据持久化独立保留规格路径与 rN，旧记录缺失字段退化为 null', () => {
  const record = createNodeTestRunRecord({
    id: 'node-panel-r2',
    stage: 'build',
    version: SHA_R2,
    jobId: 'job-panel-r2-a1',
    reqId: REQ_ID,
    specHash: HASH_R1,
    specPath: SPEC_PATH,
    dispatchRevision: 2,
    sourceMainSha: SHA_R1,
    candidateTreeSha: SHA_R2,
    ok: true,
    stdout: [
      'ℹ tests 1',
      'ℹ pass 1',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 5',
    ].join('\n'),
  });
  const parsed = parseTestRunRecord(JSON.parse(JSON.stringify(record)) as unknown);
  assert.ok(parsed);
  assert.equal(parsed.specPath, SPEC_PATH);
  assert.equal(parsed.dispatchRevision, 2);
  assert.equal(parsed.specHash, HASH_R1);
  assert.equal(parsed.sourceMainSha, SHA_R1);
  assert.equal(parsed.candidateTreeSha, SHA_R2);
  assert.equal(parsed.version, SHA_R2);

  const legacyRaw = structuredClone(parsed) as unknown as Record<string, unknown>;
  delete legacyRaw.specPath;
  delete legacyRaw.dispatchRevision;
  const legacy = parseTestRunRecord(legacyRaw);
  assert.ok(legacy);
  assert.equal(legacy.specPath, null);
  assert.equal(legacy.dispatchRevision, null);

  for (const invalid of [
    { ...record, specPath: '/docs/specs/pending/panel.md' },
    { ...record, specPath: 'docs/specs/../pending/panel.md' },
    { ...record, specPath: 42 },
    { ...record, dispatchRevision: 0 },
    { ...record, dispatchRevision: 1.5 },
    { ...record, dispatchRevision: '2' },
  ]) {
    assert.equal(parseTestRunRecord(invalid), null);
  }
});

test('Playwright 证据与 node:test 使用同一规格路径、rN、来源和候选树身份', () => {
  const record = createManualTestRunRecord({
    id: 'browser-panel-r2',
    stage: 'browser',
    runner: 'playwright',
    version: SHA_R2,
    jobId: 'job-panel-r2-a1',
    reqId: REQ_ID,
    specHash: HASH_R1,
    specPath: SPEC_PATH,
    dispatchRevision: 2,
    sourceMainSha: SHA_R1,
    candidateTreeSha: SHA_R2,
    ok: true,
  });
  const parsed = parseTestRunRecord(JSON.parse(JSON.stringify(record)) as unknown);
  assert.ok(parsed);
  assert.equal(parsed.runner, 'playwright');
  assert.equal(parsed.specPath, SPEC_PATH);
  assert.equal(parsed.dispatchRevision, 2);
  assert.equal(parsed.specHash, HASH_R1);
  assert.equal(parsed.sourceMainSha, SHA_R1);
  assert.equal(parsed.candidateTreeSha, SHA_R2);
  assert.equal(parsed.version, SHA_R2);
});
