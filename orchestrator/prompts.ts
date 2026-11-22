import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const promptDir = join(here, 'prompts');

const DEFAULT_WORKER_PROMPT = `你是 Spec Loop 的 Worker。只能修改 src/ 下的前端源文件。
只输出一个 JSON 对象，不要输出其它文字，格式：
{"summary":"改动摘要","files":[{"path":"src/counter.ts","content":"..."}]}
禁止 shell、git、GitHub 或任意文件系统工具；不要读取或修改 docs、package.json、orchestrator。`;

const DEFAULT_PLANNER_PROMPT = `你是 Spec Loop 的 Planner（任务 Agent）。根据给定需求快照只提出目标、步骤与验收引用。
只输出一个 JSON 对象：{"goal":"一句话目标","steps":[{"text":"工作项说明","acceptanceRefs":["A1"]}]}。
不要虚构需求 ID、来源或验收内容；步骤必须引用控制器给定的验收键。`;

function load(name: string, fallback: string): string {
  try {
    return readFileSync(join(promptDir, name), 'utf8');
  } catch {
    return fallback;
  }
}

export const WORKER_PROMPT = load('worker.md', DEFAULT_WORKER_PROMPT);
export const PLANNER_PROMPT = load('planner.md', DEFAULT_PLANNER_PROMPT);
export const DISPATCH_TASK_PROMPT = PLANNER_PROMPT;
export const SPEC_AUTHOR_PROMPT = load(
  'spec-author.md',
  `你是 Spec Loop 的 spec-author。根据用户文本，仅更新给定需求文档 docs/specs/counter.md 中现有 REQ-CNT-01 块。
只输出一个 JSON 对象：{"summary":"...","content":"完整的新文档内容"}。
必须保留所有现有需求 ID，不能新增或删除需求块，不能修改其它文件。`,
);
