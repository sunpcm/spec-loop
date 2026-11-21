import { join } from 'node:path';
import { buildAcceptanceMap, buildDeterministicDispatchTask, validateDispatchTask } from './dispatch-task.ts';
import type { Logger } from './log.ts';
import { DISPATCH_TASK_PROMPT } from './prompts.ts';
import { preparePiAgentDir, runPi, type PiInvocation, type PiResult } from './pi-runner.ts';
import { buildIsolationPaths, type SandboxProfileSpec } from './sandbox.ts';
import type { DispatchStep, DispatchTask, Spec } from './types.ts';

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

export interface DispatchTaskOptions {
  allowedPaths: string[];
  dependsOn?: string[];
}

/** 旧版自由正文派生仍保留给历史调用方；新派工路径使用 deriveDispatchTask。 */
const LEGACY_ISSUE_BODY_PROMPT = `你是 Spec Loop 的 Planner。根据给定需求快照派生 Issue 正文。
只输出一个 JSON 对象：{"title":"...","body":"..."}。不要虚构需求，不要修改确定性 ID 差量。`;

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

interface DispatchPlan {
  goal: string;
  steps: DispatchStep[];
}

function parseDispatchPlan(output: unknown): DispatchPlan | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as { goal?: unknown; steps?: unknown };
  if (typeof obj.goal !== 'string' || obj.goal.trim().length === 0) return null;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;
  const steps: DispatchStep[] = [];
  for (const item of obj.steps) {
    if (!item || typeof item !== 'object') return null;
    const step = item as { text?: unknown; acceptanceRefs?: unknown };
    if (typeof step.text !== 'string' || step.text.trim().length === 0) return null;
    if (!Array.isArray(step.acceptanceRefs)) return null;
    if (!step.acceptanceRefs.every((ref) => typeof ref === 'string' && ref.length > 0)) return null;
    steps.push({ text: step.text.trim(), acceptanceRefs: step.acceptanceRefs as string[] });
  }
  return { goal: obj.goal.trim(), steps };
}

/**
 * 用真实 Planner 派生结构化派工任务（目标 + 步骤 + 验收引用）。验收映射由控制器
 * 从规格确定性生成，写入范围与依赖由控制器注入。Planner 失败或返回无效结果时
 * 回退到确定性最小任务，而不是返回 null。
 */
export async function deriveDispatchTask(
  spec: Spec,
  deps: PlannerDeps,
  options: DispatchTaskOptions,
): Promise<DispatchTask | null> {
  const acceptance = buildAcceptanceMap(spec);
  if (!acceptance) {
    deps.logger.warn(`无法从规格生成验收映射（${spec.id}），保持待排期`);
    return null;
  }
  const allowedPaths = options.allowedPaths;
  const dependsOn = options.dependsOn ?? [];

  if (!deps.provider || !deps.model) {
    return buildDeterministicDispatchTask(spec, allowedPaths, dependsOn);
  }

  const agentDir = join(deps.runDir, 'planner', 'agent');
  preparePiAgentDir(deps.agentDir, agentDir);

  const acceptanceKeys = Object.keys(acceptance).join('、');
  const prompt = `${DISPATCH_TASK_PROMPT}\n\n## 需求快照\n需求 ID: ${spec.id}\n标题: ${spec.title}\n路径: ${spec.path}\n验收键: ${acceptanceKeys}\n\n${spec.body}`;
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
      deps.logger.warn(`Planner 派生任务失败（${spec.id}）: ${res.error ?? '未知错误'}，回退确定性任务`);
      return buildDeterministicDispatchTask(spec, allowedPaths, dependsOn);
    }
    const plan = parseDispatchPlan(res.output);
    if (!plan) {
      deps.logger.warn(`Planner 返回无效任务（${spec.id}），回退确定性任务`);
      return buildDeterministicDispatchTask(spec, allowedPaths, dependsOn);
    }
    const task: DispatchTask = {
      goal: plan.goal,
      steps: plan.steps,
      acceptance,
      allowedPaths,
      dependsOn,
    };
    if (!validateDispatchTask(task)) {
      deps.logger.warn(`Planner 任务未通过校验（${spec.id}），回退确定性任务`);
      return buildDeterministicDispatchTask(spec, allowedPaths, dependsOn);
    }
    return task;
  } catch (error) {
    deps.logger.warn(`Planner 调用异常（${spec.id}）: ${error instanceof Error ? error.message : String(error)}，回退确定性任务`);
    return buildDeterministicDispatchTask(spec, allowedPaths, dependsOn);
  }
}

/**
 * 旧版：用真实 Planner Pi 派生 Issue 正文。仅产出正文文本，需求 ID / 版本 / 元数据由控制器固定。
 * 失败时返回 null，由调用方回退到确定性正文。保留给尚未接入派工入口的历史调用方。
 */
export async function deriveIssueBody(spec: Spec, deps: PlannerDeps): Promise<string | null> {
  if (!deps.provider || !deps.model) {
    return null;
  }

  const agentDir = join(deps.runDir, 'planner', 'agent');
  preparePiAgentDir(deps.agentDir, agentDir);

  const prompt = `${LEGACY_ISSUE_BODY_PROMPT}\n\n## 需求快照\n需求 ID: ${spec.id}\n标题: ${spec.title}\n路径: ${spec.path}\n\n${spec.body}`;
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
    const body = parseLegacyIssueBody(res.output);
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

function parseLegacyIssueBody(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const body = (output as { body?: unknown }).body;
  if (typeof body !== 'string' || body.trim().length === 0) return null;
  return body.trim();
}
