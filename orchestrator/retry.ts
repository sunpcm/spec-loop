import { loadConfig } from './config.ts';

function parseIssueArg(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--issue' || arg === '-i') {
      const value = argv[i + 1];
      const n = value ? Number.parseInt(value, 10) : Number.NaN;
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    const m = /^--issue=([0-9]+)$/.exec(arg);
    if (m) return Number.parseInt(m[1] ?? '0', 10);
  }
  return null;
}

async function main(): Promise<void> {
  const issueNumber = parseIssueArg(process.argv.slice(2));
  if (!issueNumber) {
    process.stderr.write('用法: npm run demo:retry -- --issue <编号>\n');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const url = `http://127.0.0.1:${config.httpPort}/api/retry`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueNumber }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string; result?: string };
    if (!res.ok) {
      process.stderr.write(`${body.error ?? `HTTP ${res.status}`}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${body.result ?? body.error ?? '已提交重试'}\n`);
  } catch (error) {
    process.stderr.write(`无法连接守护进程（http://127.0.0.1:${config.httpPort}）: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
