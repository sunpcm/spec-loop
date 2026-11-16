import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const counterContract = JSON.parse(
  readFileSync(new URL('./contracts/counter.json', import.meta.url), 'utf8'),
) as {
  reqId: string;
  caseIds: string[];
};

const expectedVersion = process.env.SPEC_LOOP_E2E_VERSION?.trim() ?? '';

test.describe('REQ-CNT-01 计数器真实浏览器验收', () => {
  test.beforeEach(async ({ page }) => {
    expect(expectedVersion.length > 0, '必须提供计数器页面预期版本').toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCounter(page);
    await expect(page.getByText(counterContract.reqId, { exact: true }).first()).toBeVisible();
    await expect(page.locator('#app-version')).toHaveText(expectedVersion);
  });

  test('E2E-CNT-001 初始计数为 0，需求 ID 和页面版本可见', async ({ page }) => {
    await expect(page.locator('#counter-value')).toHaveText('0');
  });

  test('E2E-CNT-002 步长 2 增加显示 2，减少回到 0', async ({ page }) => {
    await page.locator('#step-input').fill('2');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('2');

    await page.locator('#decrement-button').click();
    await expect(page.locator('#counter-value')).toHaveText('0');
  });

  test('E2E-CNT-003 步长 3 增至 3，切换步长 2 后翻倍 6，继续加 8 减 6', async ({ page }) => {
    await page.locator('#step-input').fill('3');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('3');

    await page.locator('#step-input').fill('2');
    await page.locator('#double-button').click();
    await expect(page.locator('#counter-value')).toHaveText('6');
    await expect(page.locator('#step-input')).toHaveValue('2');

    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('8');
    await page.locator('#decrement-button').click();
    await expect(page.locator('#counter-value')).toHaveText('6');
  });

  test('E2E-CNT-004 重置显示 0 并保留步长', async ({ page }) => {
    await page.locator('#step-input').fill('2');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('2');

    await page.locator('#reset-button').click();
    await expect(page.locator('#counter-value')).toHaveText('0');
    await expect(page.locator('#step-input')).toHaveValue('2');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('2');
  });

  test('E2E-CNT-005 翻倍后重置显示 0，步长保持可用', async ({ page }) => {
    await page.locator('#step-input').fill('3');
    await increment(page);
    await page.locator('#double-button').click();
    await expect(page.locator('#counter-value')).toHaveText('6');

    await page.locator('#reset-button').click();
    await expect(page.locator('#counter-value')).toHaveText('0');
    await expect(page.locator('#step-input')).toHaveValue('3');
    await page.locator('#decrement-button').click();
    await expect(page.locator('#counter-value')).toHaveText('-3');
  });

  test('E2E-CNT-006 非法步长显示现有错误且计数不变', async ({ page }) => {
    await page.locator('#step-input').fill('');
    await increment(page);
    await expect(page.locator('#error-panel')).toBeVisible();
    await expect(page.locator('#error-message')).not.toBeEmpty();
    await expect(page.locator('#step-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#counter-value')).toHaveText('0');

    await page.locator('#step-input').fill('not-a-number');
    await page.locator('#decrement-button').click();
    await expect(page.locator('#error-panel')).toBeVisible();
    await expect(page.locator('#counter-value')).toHaveText('0');
  });

  test('E2E-CNT-007 正数 7 重置为 0 并保留步长', async ({ page }) => {
    await page.locator('#step-input').fill('7');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('7');

    await expectResetKeepsStep(page, '7');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('7');
  });

  test('E2E-CNT-008 负数 -5 重置为 0 并保留步长', async ({ page }) => {
    await page.locator('#step-input').fill('5');
    await page.locator('#decrement-button').click();
    await expect(page.locator('#counter-value')).toHaveText('-5');

    await expectResetKeepsStep(page, '5');
    await page.locator('#decrement-button').click();
    await expect(page.locator('#counter-value')).toHaveText('-5');
  });

  test('E2E-CNT-009 当前值为 0 时重置仍为 0 并保留步长', async ({ page }) => {
    await page.locator('#step-input').fill('4');
    await expect(page.locator('#counter-value')).toHaveText('0');

    await expectResetKeepsStep(page, '4');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('4');
  });

  test('E2E-CNT-010 翻倍得到非 0 后重置为 0 并保留步长', async ({ page }) => {
    await page.locator('#step-input').fill('5');
    await increment(page);
    await page.locator('#double-button').click();
    await expect(page.locator('#counter-value')).toHaveText('10');

    await expectResetKeepsStep(page, '5');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('5');
  });

  test('E2E-CNT-011 非法步长后重置为 0 并保留输入', async ({ page }) => {
    await page.locator('#step-input').fill('3');
    await increment(page);
    await expect(page.locator('#counter-value')).toHaveText('3');

    await page.locator('#step-input').fill('not-a-number');
    await increment(page);
    await expect(page.locator('#error-panel')).toBeVisible();
    await expect(page.locator('#counter-value')).toHaveText('3');

    await page.locator('#reset-button').click();
    await expect(page.locator('#counter-value')).toHaveText('0');
    await expect(page.locator('#step-input')).toHaveValue('not-a-number');
    await increment(page);
    await expect(page.locator('#error-panel')).toBeVisible();
    await expect(page.locator('#counter-value')).toHaveText('0');
  });
});

async function openCounter(page: Page): Promise<void> {
  const response = await page.goto('./');
  expect(response?.status(), '计数器静态页面应返回 200').toBe(200);
  await expect(
    page.getByRole('heading', { name: '需求驱动的计数器', exact: true }),
  ).toBeVisible();
}

async function increment(page: Page): Promise<void> {
  await page.locator('#counter-form button[type="submit"]').click();
}

async function expectResetKeepsStep(page: Page, step: string): Promise<void> {
  await page.locator('#reset-button').click();
  await expect(page.locator('#counter-value')).toHaveText('0');
  await expect(page.locator('#step-input')).toHaveValue(step);
}
