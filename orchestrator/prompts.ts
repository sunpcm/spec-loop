import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const promptDir = join(here, 'prompts');

const DEFAULT_WORKER_PROMPT = `你是 Spec Loop 的 Worker。只能修改 src/ 下的前端源文件。
只输出一个 JSON 对象，不要输出其它文字，格式：
{"summary":"改动摘要","files":[{"path":"src/counter.ts","content":"..."}]}
禁止 shell、git、GitHub 或任意文件系统工具；不要读取或修改 docs、package.json、orchestrator。`;

const DEFAULT_PLANNER_PROMPT = `你是 Spec Loop 的 Planner。根据给定需求快照派生 Issue 正文。
只输出一个 JSON 对象：{"title":"...","body":"..."}。不要虚构需求，不要修改确定性 ID 差量。`;

function load(name: string, fallback: string): string {
  try {
    return readFileSync(join(promptDir, name), 'utf8');
  } catch {
    return fallback;
  }
}

export const WORKER_PROMPT = load('worker.md', DEFAULT_WORKER_PROMPT);
export const PLANNER_PROMPT = load('planner.md', DEFAULT_PLANNER_PROMPT);
