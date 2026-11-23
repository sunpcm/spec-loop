/**
 * 受管需求的交付画像与面板受信绑定。
 *
 * 这是交付画像与面板绑定的唯一接口契约来源：调度器、运行时、Worker、部署与重试都从这里读取
 * 同一份 reqId → 规格路径 / 源码范围 / 构建脚本的映射，避免各模块各自拼装。
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const SPEC_HASH_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REPO_ID_RE = /^github-repository-id:[1-9][0-9]*$/;

export const COUNTER_REQ_ID = 'REQ-CNT-01';
export const PANEL_REQ_ID = 'REQ-PANEL-01';
export const COUNTER_SPEC_PATH = 'docs/specs/counter.md';
export const PANEL_SPEC_PATH = 'docs/specs/pending/panel.md';

/**
 * 面板的受信配置绑定。repositoryId 沿用 GitHub 客户端返回的
 * `github-repository-id:<数字>`，用于把开工许可绑定到具体仓库。
 */
export interface PanelBinding {
  repo: string;
  mainBranch: string;
  repositoryId: string;
  issueNumber: number;
  confirmedMainSha: string;
  specHash: string;
}

export type DeliveryProject = 'counter' | 'panel';

export interface DeliveryProfile {
  reqId: string;
  specPath: string;
  sourceDir: 'src' | 'panel/src';
  project: DeliveryProject;
  buildScript: 'build' | 'build:panel';
}

/**
 * 返回内置计数器或显式绑定面板的交付画像；未识别的 reqId 返回 undefined。
 * 面板只有在提供受信 PanelBinding 时才被识别，不接受任意新 reqId。
 */
export function deliveryProfile(
  reqId: string,
  panelBinding?: PanelBinding,
): DeliveryProfile | undefined {
  if (reqId === COUNTER_REQ_ID) {
    return {
      reqId,
      specPath: COUNTER_SPEC_PATH,
      sourceDir: 'src',
      project: 'counter',
      buildScript: 'build',
    };
  }
  if (reqId === PANEL_REQ_ID && panelBinding) {
    return {
      reqId,
      specPath: PANEL_SPEC_PATH,
      sourceDir: 'panel/src',
      project: 'panel',
      buildScript: 'build:panel',
    };
  }
  return undefined;
}

/** 输入是否显式宣称面板需求（与是否绑定无关）。 */
export function isPanelReqId(reqId: string): boolean {
  return reqId === PANEL_REQ_ID;
}

/** 校验 PanelBinding 形态与边界；任意字段非法都 fail closed。 */
export function isValidPanelBinding(binding: unknown): binding is PanelBinding {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const candidate = binding as Partial<PanelBinding>;
  return (
    typeof candidate.repo === 'string' &&
    REPO_RE.test(candidate.repo.trim()) &&
    typeof candidate.mainBranch === 'string' &&
    candidate.mainBranch.trim().length > 0 &&
    typeof candidate.repositoryId === 'string' &&
    REPO_ID_RE.test(candidate.repositoryId) &&
    Number.isSafeInteger(candidate.issueNumber) &&
    candidate.issueNumber! > 0 &&
    typeof candidate.confirmedMainSha === 'string' &&
    SHA_RE.test(candidate.confirmedMainSha) &&
    typeof candidate.specHash === 'string' &&
    SPEC_HASH_RE.test(candidate.specHash)
  );
}

/** 兼容 `github-repository-id:<数字>` 与纯数字两种表示的比较。 */
export function sameRepositoryId(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/^github-repository-id:/, '');
  return normalize(left) === normalize(right);
}

/**
 * 受管规格路径白名单：只接受 docs/specs 的直属 *.md，或唯一登记的面板子路径
 * docs/specs/pending/panel.md。其余未登记子路径一律拒绝，防止任意路径进入状态。
 */
export function isRegisteredSpecPath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path === PANEL_SPEC_PATH) return true;
  return /^docs\/specs\/[^/]+\.md$/.test(path);
}
