import { expect, test, type Locator, type Page } from '@playwright/test';
import { PANEL_DEMO_CASE_IDS } from './panel-case-ids.ts';

const MAX_DEMO_STEPS = 16;

test.describe('本机面板既有合成演示与证据回归', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPanel(page);
  });

  test(`${PANEL_DEMO_CASE_IDS[0]} 演示标识可见且明确为浏览器内合成场景`, async ({ page }) => {
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    await expect(page.getByLabel('合成演示数据', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: '当前画面全部来自浏览器内合成场景。' }),
    ).toContainText('不会触发 Merge、Retry 或 Deploy');
    await expect(
      page.getByRole('heading', { name: '演示：计数器增加翻倍功能', exact: true }),
    ).toBeVisible();
  });

  test(`${PANEL_DEMO_CASE_IDS[1]} 点击节点显示该节点的详情与合成证据`, async ({ page }) => {
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    const taskNode = page.getByRole('button', { name: /^同步开发任务，/ });
    await taskNode.click();
    const details = page.getByRole('complementary', { name: '节点详情', exact: true });
    const detailCard = details.locator('.node-detail-card');
    const evidence = details.locator('.demo-evidence-card');
    await expect(detailCard.getByRole('heading', { name: '同步开发任务', exact: true })).toBeVisible();
    await expect(detailCard).toContainText('主路径尚未到达，当前没有合成执行证据');
    await expect(evidence.getByText('SYNTHETIC EVIDENCE', { exact: true })).toBeVisible();
    await expect(
      evidence.getByRole('heading', {
        name: '同步开发任务',
        exact: true,
      }),
    ).toBeVisible();
  });

  test(`${PANEL_DEMO_CASE_IDS[2]} 文档门禁阻断推进，仅显式模拟确认可越过`, async ({ page }) => {
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    const apiRequests = observeAPIRequests(page);
    const next = page.getByRole('button', { name: '下一步', exact: true });
    await openDocumentGate(page);

    const details = page.locator('#node-details-panel');
    const gate = page.getByRole('button', { name: '模拟确认文档合并', exact: true });
    await expect(next).toBeDisabled();
    await expect(details.getByText('等待文档人工确认', { exact: true })).toBeVisible();
    await expect(details).toContainText('真实合并调用');
    await expect(details).toContainText('仅浏览器内模拟');

    await expect(next).toBeDisabled();
    await gate.click();
    await expect(next).toBeEnabled();
    await expect(
      details.locator('.node-detail-card').getByRole('heading', {
        name: 'main 需求生效',
        exact: true,
      }),
    ).toBeVisible();
    expect(apiRequests(), '演示交互期间不应发起同源 API 请求').toEqual([]);
  });

  test(`${PANEL_DEMO_CASE_IDS[3]} 固定检查失败门禁阻断推进，仅显式模拟重试可越过`, async ({ page }) => {
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    const apiRequests = observeAPIRequests(page);
    const next = page.getByRole('button', { name: '下一步', exact: true });
    const details = page.locator('#node-details-panel');
    const detailCard = details.locator('.node-detail-card');
    await openDocumentGate(page);
    await page.getByRole('button', { name: '模拟确认文档合并', exact: true }).click();
    await advanceToDetailsGate(next, details, 'check-failed');

    const retry = page.getByRole('button', { name: '模拟重试当前阶段', exact: true });
    await expect(next).toBeDisabled();
    await expect(details.getByRole('button', { name: '模拟确认代码合并', exact: true })).toHaveCount(0);
    await expect(retry).toBeVisible();
    await expect(detailCard.getByRole('heading', { name: '失败记录 / 人工重试', exact: true })).toBeVisible();
    await expect(detailCard.locator('.status-badge')).toHaveText('待人工确认');
    await expect(details.locator('.demo-evidence-card')).toContainText('失败，已保留产物与失败项');

    await retry.click();
    await expect(next).toBeEnabled();
    await expect(details.getByRole('button', { name: '模拟重试当前阶段', exact: true })).toHaveCount(0);
    await expect(details.locator('.demo-evidence-card')).toContainText('尝试 2');
    await expect(details.locator('.demo-evidence-card')).toContainText('第 1 次失败被保留');
    expect(apiRequests(), '演示交互期间不应发起同源 API 请求').toEqual([]);
  });

  test(`${PANEL_DEMO_CASE_IDS[4]} 代码门禁单独阻断并允许显式模拟确认`, async ({ page }) => {
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    const next = page.getByRole('button', { name: '下一步', exact: true });
    const details = page.locator('#node-details-panel');
    await openDocumentGate(page);
    await page.getByRole('button', { name: '模拟确认文档合并', exact: true }).click();
    await advanceToDetailsGate(next, details, 'check-failed');
    await page.getByRole('button', { name: '模拟重试当前阶段', exact: true }).click();
    await advanceToDetailsGate(next, details, 'code-confirm');

    const gate = page.getByRole('button', { name: '模拟确认代码合并', exact: true });
    await expect(next).toBeDisabled();
    await expect(details.getByRole('button', { name: '模拟重试当前阶段', exact: true })).toHaveCount(0);
    await expect(details.getByText('等待代码人工确认', { exact: true })).toBeVisible();
    await expect(gate).toBeVisible();

    await gate.click();
    await expect(next).toBeEnabled();
    await expect(
      details.locator('.node-detail-card').getByRole('heading', {
        name: '构建候选版本',
        exact: true,
      }),
    ).toBeVisible();
  });

});

async function openPanel(page: Page): Promise<void> {
  const response = await page.goto('./');
  expect(response?.status(), '面板静态页面应返回 200').toBe(200);
  await expect(page.getByRole('group', { name: '数据源模式', exact: true })).toBeVisible();
}

async function openDocumentGate(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: '下一步', exact: true });
  const gate = page.getByRole('button', { name: '模拟确认文档合并', exact: true });
  for (let step = 0; step < MAX_DEMO_STEPS; step += 1) {
    if (await gate.isVisible()) {
      await expect(next).toBeDisabled();
      return;
    }
    await expect(next).toBeEnabled();
    await next.click();
  }
  throw new Error(`演示流程在 ${MAX_DEMO_STEPS} 次推进内未到达文档确认门禁`);
}

async function detailsStepIs(
  details: Locator,
  step: 'doc-confirm' | 'check-failed' | 'code-confirm',
): Promise<boolean> {
  const gateName = {
    'doc-confirm': '模拟确认文档合并',
    'check-failed': '模拟重试当前阶段',
    'code-confirm': '模拟确认代码合并',
  }[step];
  return details.getByRole('button', { name: gateName, exact: true }).isVisible();
}

async function advanceToDetailsGate(
  next: Locator,
  details: Locator,
  step: 'check-failed' | 'code-confirm',
): Promise<void> {
  for (let index = 0; index <= MAX_DEMO_STEPS; index += 1) {
    if (await detailsStepIs(details, step)) {
      await expect(next).toBeDisabled();
      return;
    }
    expect(index, `演示流程在 ${MAX_DEMO_STEPS} 次推进内应到达 ${step}`).toBeLessThan(
      MAX_DEMO_STEPS,
    );
    await expect(next).toBeEnabled();
    await next.click();
  }
}

function observeAPIRequests(page: Page): () => string[] {
  const observedOrigin = new URL(page.url()).origin;
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === observedOrigin && /\/api(?:\/|$)/.test(url.pathname)) {
      requests.push(request.url());
    }
  });
  return () => [...requests];
}
