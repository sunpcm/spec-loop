import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

// 固定 API 夹具，不是一次真实浏览器执行留下的证据。
type TestRunsResponse = {
  schemaVersion: 'test-runs/v1';
  runs: Array<{
    id: string;
    stage: 'worker' | 'build' | 'manual' | 'browser';
    runner: 'node:test' | 'playwright' | 'manual' | 'unknown';
    version: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    jobId: string | null;
    reqId: string | null;
    specHash: string | null;
    sourceMainSha: string | null;
    candidateTreeSha: string | null;
    suiteFingerprint: string | null;
    ok: boolean | null;
    summary:
      | {
          runner: 'node:test';
          total: number | null;
          passed: number | null;
          failed: number | null;
          skipped: number | null;
          cancelled: number | null;
          todo: number | null;
          durationMs: number | null;
          unknown: boolean;
        }
      | {
          runner: 'playwright';
          specCount: number | null;
          targetTestCount: number | null;
          resultCount: number | null;
          skipped: number | null;
          flaky: number | null;
          unexpected: number | null;
          errorCount: number | null;
          failedResultCount: number | null;
          retriedCount: number | null;
          unknown: boolean;
        }
      | null;
    cases: Array<{
      id: string;
      title: string;
      status: 'passed' | 'failed' | 'unknown';
      durationMs: number | null;
      error: string | null;
      artifacts: Array<{
        id: string;
        kind: 'screenshot' | 'video' | 'trace' | 'json';
        name: string;
        href: string;
      }>;
    }>;
  }>;
};

const PANEL_EVIDENCE_CASE_IDS = [
  'PANEL-EVIDENCE-001',
  'PANEL-EVIDENCE-002',
  'PANEL-EVIDENCE-003',
  'PANEL-EVIDENCE-004',
  'PANEL-EVIDENCE-005',
  'PANEL-EVIDENCE-006',
  'PANEL-EVIDENCE-007',
] as const;

const BROWSER_RUN_ID = 'fixture-browser-failed';
const UNKNOWN_RUN_ID = 'fixture-fixed-unknown';
const NO_SUMMARY_RUN_ID = 'fixture-summary-missing';

const browserCases = [
  {
    id: 'fixture-browser-case-failed',
    title: '夹具：失败用例保留截图、trace 与视频',
    status: 'failed',
    durationMs: 2201,
    error: '夹具：断言未通过',
    artifacts: [
      artifact(BROWSER_RUN_ID, 'fixture-screenshot', 'fixture-failure.png', 'screenshot'),
      artifact(BROWSER_RUN_ID, 'fixture-trace', 'fixture-failure.zip', 'trace'),
      artifact(BROWSER_RUN_ID, 'fixture-video', 'fixture-failure.webm', 'video'),
    ],
  },
  {
    id: 'fixture-browser-case-no-artifact',
    title: '夹具：未保留附件的通过用例',
    status: 'passed',
    durationMs: 311,
    error: null,
    artifacts: [],
  },
] satisfies TestRunsResponse['runs'][number]['cases'];

const fixtureRuns: TestRunsResponse = {
  schemaVersion: 'test-runs/v1',
  runs: [
    {
      id: BROWSER_RUN_ID,
      stage: 'browser',
      runner: 'playwright',
      version: 'panel-test-fixture',
      startedAt: '2026-11-16T03:00:00.000Z',
      finishedAt: '2026-11-16T03:00:15.000Z',
      jobId: 'fixture-job-browser',
      reqId: 'REQ-CNT-01',
      specHash: 'b'.repeat(64),
      sourceMainSha: 'c'.repeat(40),
      candidateTreeSha: null,
      suiteFingerprint: 'd'.repeat(64),
      ok: false,
      summary: {
        runner: 'playwright',
        specCount: 2,
        targetTestCount: 2,
        resultCount: 2,
        skipped: 0,
        flaky: 0,
        unexpected: 1,
        errorCount: 0,
        failedResultCount: 1,
        retriedCount: 0,
        unknown: false,
      },
      cases: browserCases,
    },
    {
      id: UNKNOWN_RUN_ID,
      stage: 'worker',
      runner: 'node:test',
      version: 'panel-test-fixture',
      startedAt: '2026-11-16T02:00:00.000Z',
      finishedAt: '2026-11-16T02:00:05.000Z',
      jobId: 'fixture-job-worker',
      reqId: 'REQ-CNT-01',
      specHash: 'e'.repeat(64),
      sourceMainSha: 'f'.repeat(40),
      candidateTreeSha: '1'.repeat(40),
      suiteFingerprint: null,
      ok: null,
      summary: {
        runner: 'node:test',
        total: null,
        passed: null,
        failed: null,
        skipped: null,
        cancelled: null,
        todo: null,
        durationMs: null,
        unknown: true,
      },
      cases: [],
    },
  ],
};

const missingSummaryRuns: TestRunsResponse = {
  schemaVersion: 'test-runs/v1',
  runs: [
    {
      ...fixtureRuns.runs[0]!,
      id: NO_SUMMARY_RUN_ID,
      ok: null,
      summary: null,
      cases: [],
    },
  ],
};

const emptyRuns: TestRunsResponse = { schemaVersion: 'test-runs/v1', runs: [] };

test.describe('测试与验收证据面板', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[0]} 固定 run 摘要、失败用例及受管附件入口可核对`, async ({
    page,
  }) => {
    const runsRequests = await openPanelWithRuns(page, fixtureRuns);
    const list = testRunsSection(page);
    await expect(list).toContainText('Playwright · 2 用例');
    await expect(list).toContainText('node:test 摘要未知或计数不一致');

    await selectRun(list, 'Playwright · 2 用例');
    const details = testRunDetails(page);
    await expect(details).toContainText('夹具：断言未通过');
    await expect(details).toContainText('2201 ms');
    await expect(details.getByRole('img', { name: 'fixture-failure.png' })).toHaveAttribute(
      'src',
      '/api/test-runs/fixture-browser-failed/artifacts/fixture-screenshot',
    );
    await expect(
      details.getByRole('link', { name: '打开 fixture-failure.png', exact: true }),
    ).toHaveAttribute('href', '/api/test-runs/fixture-browser-failed/artifacts/fixture-screenshot');
    await expect(
      details.getByRole('link', { name: '下载 fixture-failure.zip', exact: true }),
    ).toHaveAttribute('href', '/api/test-runs/fixture-browser-failed/artifacts/fixture-trace');
    await expect(
      details.getByRole('link', { name: '下载 fixture-failure.webm', exact: true }),
    ).toHaveAttribute('href', '/api/test-runs/fixture-browser-failed/artifacts/fixture-video');
    await expect(details.locator('video[aria-label="fixture-failure.webm"]')).toHaveAttribute(
      'src',
      '/api/test-runs/fixture-browser-failed/artifacts/fixture-video',
    );
    await expect(
      details.getByRole('button', { name: /重试|重跑|合并|部署/ }),
    ).toHaveCount(0);
    expectReadOnlyRunRequests(runsRequests(), page.url());
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[1]} 用例无附件时明确区分未保留`, async ({ page }) => {
    await openPanelWithRuns(page, fixtureRuns);
    await selectRun(testRunsSection(page), 'Playwright · 2 用例');
    const card = caseCard(testRunDetails(page), 'fixture-browser-case-no-artifact');
    await expect(card).toContainText('311 ms');
    await expect(card.locator('img, video, a')).toHaveCount(0);
    await expect(card).toContainText('未保留');
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[2]} 解析未知摘要不得显示为零通过`, async ({ page }) => {
    await openPanelWithRuns(page, fixtureRuns);
    await selectRun(testRunsSection(page), 'node:test 摘要未知或计数不一致');
    const details = testRunDetails(page);
    await expect(details).toContainText('node:test 摘要未知或计数不一致');
    await expect(details).toContainText('没有可用的用例附件记录');
    await expect(details).not.toContainText('0/0 通过');
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[3]} 缺失摘要明确记录缺失`, async ({ page }) => {
    await openPanelWithRuns(page, missingSummaryRuns);
    const list = testRunsSection(page);
    await expect(list).toContainText('摘要未记录');
    await selectRun(list, '摘要未记录');
    await expect(testRunDetails(page)).toContainText('摘要未记录');
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[4]} 零记录有明确空态且不伪造成功结果`, async ({
    page,
  }) => {
    await openPanelWithRuns(page, emptyRuns);
    const empty = testRunsSection(page);
    await expect(empty).toContainText('暂无测试运行记录');
    await expect(empty.getByRole('button', { name: /通过/ })).toHaveCount(0);
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[5]} HTTP、空响应及未知 schema 有明确错误态`, async ({
    page,
  }) => {
    await openPanelWithRuns(page, emptyRuns);
    await page.unroute('**/api/test-runs');
    await page.route('**/api/test-runs', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture unavailable' }),
      });
    });
    await page.reload();
    await expect(page.getByRole('group', { name: '数据源模式', exact: true })).toBeVisible();
    await expect(testRunsSection(page)).toContainText('测试记录暂时不可用');
    await expect(testRunsSection(page).getByRole('button', { name: /通过/ })).toHaveCount(0);

    for (const body of ['', '{"schemaVersion":"test-runs/v2","runs":[]}', '{"runs":[]}']) {
      await page.unroute('**/api/test-runs');
      await page.route('**/api/test-runs', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body });
      });
      await page.reload();
      await expect(
        testRunsSection(page),
        `非法固定响应应显示错误态: ${body || '<empty>'}`,
      ).toContainText('测试记录暂时不可用');
      await expect(testRunsSection(page)).toContainText('暂无测试运行记录');
      await expect(testRunsSection(page).getByRole('button', { name: /通过/ })).toHaveCount(0);
    }
  });

  test(`${PANEL_EVIDENCE_CASE_IDS[6]} 合成 demo 不冒充真实执行附件`, async ({ page }) => {
    await openPanelWithRuns(page, fixtureRuns);
    await expect(testRunsSection(page)).toContainText('Playwright · 2 用例');
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    const demo = testRunsSection(page);
    await expect(demo).toContainText('演示模式不展示真实测试记录');
    await expect(demo).not.toContainText('Playwright · 2 用例');
    await expect(page.locator('video[aria-label="fixture-failure.webm"]')).toHaveCount(0);
  });
});

function artifact(
  runId: string,
  id: string,
  name: string,
  kind: 'screenshot' | 'video' | 'trace',
): TestRunsResponse['runs'][number]['cases'][number]['artifacts'][number] {
  return {
    id,
    kind,
    name,
    href: `/api/test-runs/${runId}/artifacts/${id}`,
  };
}

async function openPanelWithRuns(
  page: Page,
  runs: TestRunsResponse,
): Promise<() => Array<{ method: string; url: string }>> {
  const observed: Array<{ method: string; url: string }> = [];
  await page.route('**/api/test-runs', async (route: Route) => {
    if (new URL(route.request().url()).origin !== new URL(page.url()).origin) {
      await route.continue();
      return;
    }
    observed.push({ method: route.request().method(), url: route.request().url() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(runs),
    });
  });
  const response = await page.goto('./');
  expect(response?.status(), '面板静态页面应返回 200').toBe(200);
  await expect(page.getByRole('group', { name: '数据源模式', exact: true })).toBeVisible();
  return () => [...observed];
}

function expectReadOnlyRunRequests(
  requests: Array<{ method: string; url: string }>,
  panelURL: string,
): void {
  expect(requests.length, '面板应读取测试记录').toBeGreaterThan(0);
  for (const request of requests) {
    const url = new URL(request.url);
    expect(request.method, `${request.url} 只能使用 GET`).toBe('GET');
    expect(url.origin, `${request.url} 必须来自固定本机面板`).toBe(new URL(panelURL).origin);
    expect(url.pathname, `${request.url} 只能是测试记录读取接口`).toBe('/api/test-runs');
  }
}

function testRunsSection(page: Page): Locator {
  return page
    .getByRole('complementary', { name: '需求与交付列表', exact: true })
    .locator('section')
    .filter({ hasText: '测试与验收' });
}

function testRunDetails(page: Page): Locator {
  return page.locator('.test-run-card');
}

function caseCard(details: Locator, caseId: string): Locator {
  return details.locator('.test-case-card').filter({ hasText: caseId });
}

async function selectRun(list: Locator, name: string): Promise<void> {
  const run = list.getByRole('button', { name: new RegExp(escapeRegExp(name)) });
  await run.click();
  await expect(run).toHaveAttribute('aria-pressed', 'true');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
