import { join } from 'node:path';
import type { Logger } from './log.ts';
import { PLANNER_PROMPT } from './prompts.ts';
import { preparePiAgentDir, runPi, type PiInvocation, type PiResult } from './pi-runner.ts';
import { buildIsolationPaths, type SandboxProfileSpec } from './sandbox.ts';
import type { Spec } from './types.ts';

export interface PlannerDeps {
  repoDir: string;
  runDir: string;
  provider: string;
  model: string;
  /** 全局 agentDir（models.json 源，只读；Pi 只接触作业内副本）。 */
  agentDir: string;
  timeoutMs: number;
  graceMs: number;
  logger: Logger;
  runPi?: (inv: PiInvocation) => Promise<PiResult>;
}

function plannerSandbox(deps: PlannerDeps, agentDir: string): SandboxProfileSpec {
  const isolation = buildIsolationPaths(deps.repoDir);
  const plannerTmp = join(deps.runDir, 'planner');
  return {
    writableDirs: [plannerTmp, agentDir],
    writableLiterals: ['/dev/null'],
    denyReadDirs: isolation.denyReadDirs,
    denyReadLiterals: isolation.denyReadLiterals,
    allowReadDirs: [...isolation.allowReadDirs, agentDir],
    sensitiveDenyDirs: isolation.sensitiveDenyDirs,
    sensitiveDenyLiterals: isolation.sensitiveDenyLiterals,
    denyNetwork: false,
  };
}

function parsePlannerOutput(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const body = (output as { body?: unknown }).body;
  if (typeof body !== 'string' || body.trim().length === 0) return null;
  return body.trim();
}

/**
 * 用真实 Planner Pi 派生 Issue 正文。仅产出正文文本，需求 ID / 版本 / 元数据由控制器固定，
 * Planner 不能决定任何外部操作。失败时返回 null，由调用方回退到确定性正文。
 */
export async function deriveIssueBody(spec: Spec, deps: PlannerDeps): Promise<string | null> {
  if (!deps.provider || !deps.model) {
    return null;
  }

  const agentDir = join(deps.runDir, 'planner', 'agent');
  preparePiAgentDir(deps.agentDir, agentDir);

  const prompt = `${PLANNER_PROMPT}\n\n## 需求快照\n需求 ID: ${spec.id}\n标题: ${spec.title}\n路径: ${spec.path}\n\n${spec.body}`;
  const inv: PiInvocation = {
    role: 'planner',
    prompt,
    workDir: deps.runDir,
    agentDir,
    provider: deps.provider,
    model: deps.model,
    timeoutMs: deps.timeoutMs,
    graceMs: deps.graceMs,
    repoDir: deps.repoDir,
    sandbox: plannerSandbox(deps, agentDir),
  };

  try {
    const res = await (deps.runPi ?? runPi)(inv);
    if (!res.ok) {
      deps.logger.warn(`Planner 派生正文失败（${spec.id}）: ${res.error ?? '未知错误'}`);
      return null;
    }
    const body = parsePlannerOutput(res.output);
    if (!body) {
      deps.logger.warn(`Planner 返回无效正文（${spec.id}）`);
      return null;
    }
    return body;
  } catch (error) {
    deps.logger.warn(`Planner 调用异常（${spec.id}）: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
