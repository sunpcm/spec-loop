import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FeishuSettings } from './feishu-contract.ts';

export interface Config {
  repo: string | null;
  repoDir: string;
  runDir: string;
  stateFile: string;
  mainBranch: string;
  httpPort: number;
  previewPort: number;
  devPort: number;
  pollIntervalMs: number;
  piTimeoutMs: number;
  piGraceMs: number;
  buildTimeoutMs: number;
  verifyTimeoutMs: number;
  piAttempts: number;
  piProvider: string;
  piModel: string;
  piAgentDir: string;
  errorDedupWindowMs: number;
  revisionBudget: number;
  logRetentionDays: number;
  reportToken: string;
  feishu: FeishuSettings;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadEnvFile(path: string): void {
  if (!path || !existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(repoDir: string = process.cwd()): Config {
  loadEnvFile(process.env.SPEC_LOOP_ENV_FILE ?? '');
  const runDir = resolve(repoDir, '.orchestrator');
  const fileConfig: Record<string, unknown> = (() => {
    const candidate = resolve(repoDir, 'orchestrator.config.json');
    if (!existsSync(candidate)) return {};
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const pick = (key: string): string | undefined => {
    const value = fileConfig[key];
    return typeof value === 'string' ? value : undefined;
  };

  // 空/纯空白 repo 视为未设置，避免 .env.example 复制出的 `SPEC_LOOP_REPO=` 阻止从 origin 推导。
  const repo = (() => {
    const envRepo = process.env.SPEC_LOOP_REPO?.trim();
    if (envRepo) return envRepo;
    const fileRepo = pick('repo');
    return fileRepo?.trim() ? fileRepo : null;
  })();

  return {
    repo,
    repoDir,
    runDir,
    stateFile: resolve(repoDir, '.orchestrator-state.json'),
    mainBranch: strEnv('SPEC_LOOP_MAIN_BRANCH', pick('mainBranch') ?? 'main'),
    httpPort: intEnv('SPEC_LOOP_HTTP_PORT', 4000),
    previewPort: intEnv('SPEC_LOOP_PREVIEW_PORT', 5173),
    devPort: intEnv('SPEC_LOOP_DEV_PORT', 5174),
    pollIntervalMs: intEnv('SPEC_LOOP_POLL_MS', 5000),
    piTimeoutMs: intEnv('SPEC_LOOP_PI_TIMEOUT_MS', 300000),
    piGraceMs: intEnv('SPEC_LOOP_PI_GRACE_MS', 5000),
    buildTimeoutMs: intEnv('SPEC_LOOP_BUILD_TIMEOUT_MS', 180000),
    verifyTimeoutMs: intEnv('SPEC_LOOP_VERIFY_TIMEOUT_MS', 300000),
    piAttempts: intEnv('SPEC_LOOP_PI_ATTEMPTS', 2),
    piProvider: strEnv('PI_PROVIDER', ''),
    piModel: strEnv('PI_MODEL', ''),
    piAgentDir: strEnv('PI_CODING_AGENT_DIR', resolve(runDir, 'agent')),
    errorDedupWindowMs: intEnv('SPEC_LOOP_DEDUP_MS', 600000),
    revisionBudget: intEnv('SPEC_LOOP_REVISION_BUDGET', 2),
    logRetentionDays: intEnv('SPEC_LOOP_LOG_RETENTION_DAYS', 7),
    reportToken: strEnv('SPEC_LOOP_REPORT_TOKEN', ''),
    feishu: {
      enabled: process.env.FEISHU_ENABLED === 'true',
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      chatId: process.env.FEISHU_CHAT_ID,
      allowedUserIds: splitCsv(process.env.FEISHU_ALLOWED_USER_IDS),
    },
  };
}
