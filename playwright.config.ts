import { defineConfig, devices, type PlaywrightWorkerOptions } from '@playwright/test';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Playwright 验收缺少环境变量 ${name}`);
  return value;
}

function localBaseURL(): string {
  const value = requiredEnvironment('SPEC_LOOP_E2E_BASE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SPEC_LOOP_E2E_BASE_URL 必须是有效 URL');
  }
  if (!url.port) {
    throw new Error('SPEC_LOOP_E2E_BASE_URL 必须显式指定 IPv4 本机端口');
  }
  if (url.hostname !== '127.0.0.1') {
    throw new Error('SPEC_LOOP_E2E_BASE_URL 仅允许 127.0.0.1');
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SPEC_LOOP_E2E_BASE_URL 必须是无凭据的 IPv4 本机 HTTP URL');
  }
  return url.toString();
}

function videoMode(): PlaywrightWorkerOptions['video'] {
  const value = process.env.SPEC_LOOP_E2E_VIDEO?.trim() || 'retain-on-failure';
  if (value === 'on' || value === 'retain-on-failure') return value;
  throw new Error('SPEC_LOOP_E2E_VIDEO 仅允许 on 或 retain-on-failure');
}

const baseURL = localBaseURL();
const reportDir = requiredEnvironment('SPEC_LOOP_E2E_REPORT_DIR');
requiredEnvironment('SPEC_LOOP_E2E_VERSION');

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: `${reportDir}/artifacts`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  globalTimeout: 180_000,
  reporter: [
    ['line'],
    ['json', { outputFile: `${reportDir}/results.json` }],
    ['html', { outputFolder: `${reportDir}/html`, open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    video: videoMode(),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'counter',
      testMatch: /counter\.spec\.ts/,
      outputDir: `${reportDir}/artifacts/counter`,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1200 },
        browserName: 'chromium',
      },
    },
    {
      name: 'panel',
      testMatch: /panel(?:-evidence)?\.spec\.ts/,
      outputDir: `${reportDir}/artifacts/panel`,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1400 },
        browserName: 'chromium',
      },
    },
  ],
});
