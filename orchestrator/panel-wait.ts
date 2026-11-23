export type PanelWaitState = 'waiting' | 'active' | 'complete' | 'failed' | 'unknown';

export type PanelWaitRole =
  | 'operator'
  | 'task-agent'
  | 'scheduler'
  | 'code-agent'
  | 'controller'
  | 'unknown'
  | 'none';

export type PanelWaitBasis = 'current' | 'cached' | 'conflict' | 'unknown';

export interface PanelVersionIdentity {
  reqId: string;
  specPath: string | null;
  specHash: string | null;
  sourceMainSha: string | null;
  revision: number | null;
  issueNumber: number | null;
  documentRequestId: string | null;
  documentPrNumber: number | null;
}

export type PanelEvidenceKind =
  | 'spec-request'
  | 'document-pr'
  | 'document-merge'
  | 'issue'
  | 'dispatch-publication'
  | 'dispatch-grant'
  | 'job'
  | 'code-pr'
  | 'test-runs'
  | 'deployment';

export interface PanelEvidenceRef {
  kind: PanelEvidenceKind;
  label: string;
  href: string | null;
  observedAt: string | null;
}

export interface PanelWaitProjection {
  state: PanelWaitState;
  role: PanelWaitRole;
  roleLabel: string;
  title: string;
  reason: string;
  nextAction: string;
  basis: PanelWaitBasis;
  observedAt: string;
  humanActionRequired: boolean;
  /**
   * 当前快照里明确缺少、且不能从角色或旧记录反推的证据。空数组表示本投影
   * 没有发现额外证据缺口，不表示所有外部记录都已被在线回读。
   */
  evidenceGaps: string[];
}

/**
 * 控制器在观察当时对某一已发布 revision 的许可读取结果。
 *
 * - `awaiting-label`：当次读取成功，并确认当前 Issue 没有有效本版许可。
 * - `authorized`：当次读取成功，并确认当前 Issue 存在有效本版许可；领取作业时仍须重新核验。
 * - `unverified`：当次读取失败、状态不明或证据冲突，不能据此推断等待谁。
 *
 * 这里只保存当次可核对的结果，不把观察结果提升为长期授权。已发布 revision 缺少
 * `observation` 时只能退化为“待核实”；没有 `grant`、存在旧 `grant` 或控制器离线，
 * 都不能反推 `awaiting-label`。DTO 不保存凭据、原始标签事件或未经控制器核实的远端内容。
 */
export interface PanelDispatchObservation {
  state: 'awaiting-label' | 'authorized' | 'unverified';
  observedAt: string;
}

export interface PanelWaitNode {
  id: string;
  status: 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'stale' | 'unknown';
  detail: string;
}

export interface PanelWaitPrimaryJob {
  status: string;
  failureStage: string | null;
  resumeAction: string | null;
  prNumber: number | null;
  updatedAt: string | null;
}

export interface PanelWaitRevision {
  revision: number;
  publishedAt: string | null;
  publicationCommentId: number | null;
  observation: PanelDispatchObservation | null;
  hasGrant: boolean;
}

export interface PanelWaitInput {
  controllerOnline: boolean;
  stateObservedAt: string | null;
  observedAt: string;
  /**
   * 只能来自受信文档合并记录或 PanelBinding 对 `confirmedMainSha`/`specHash`
   * 的核对结果。仅看到 `docs/specs/pending/**` 文件不能说明文档已经确认。
   */
  documentStage: string | null;
  /**
   * absent 只能来自两种明确记录：控制器完成同仓、同 reqId、同版本 Issue 的
   * 存在性核对后记录任务尚不存在，或控制器已持久冻结本版 revision、但尚未
   * 回读对应任务清单发布评论。本地没有 requirement、只看到 pending 目录、
   * 缺少 grant 或从未读到 Issue 都只能传 unknown。
   */
  taskRegistration: 'registered' | 'absent' | 'unknown';
  revision: PanelWaitRevision | null;
  primaryJob: PanelWaitPrimaryJob | null;
  activeOtherJob: boolean;
  nodes: PanelWaitNode[];
  /** 已回读到、能唯一定位本版部署与健康检查的回执地址；缺失时必须保持待核实。 */
  deploymentReceiptHref: string | null;
  conflict: boolean;
  superseded: boolean;
}

const ROLE_LABELS: Record<PanelWaitRole, string> = {
  operator: '你是负责人',
  'task-agent': '任务 Agent',
  scheduler: '调度器',
  'code-agent': 'Code Agent',
  controller: '控制器',
  unknown: '负责人未知',
  none: '无需操作',
};

function projection(
  input: PanelWaitInput,
  value: Omit<PanelWaitProjection, 'roleLabel' | 'observedAt' | 'evidenceGaps'>
    & Partial<Pick<PanelWaitProjection, 'evidenceGaps'>>,
): PanelWaitProjection {
  return {
    ...value,
    roleLabel: ROLE_LABELS[value.role],
    observedAt: input.observedAt,
    evidenceGaps: value.evidenceGaps ?? [],
  };
}

function nodeStatus(input: PanelWaitInput, id: string): PanelWaitNode['status'] | null {
  return input.nodes.find((node) => node.id === id)?.status ?? null;
}

function revisionLabel(revision: PanelWaitRevision | null): string {
  return revision ? `r${revision.revision}` : '当前版本';
}

/**
 * 只根据当前快照里的可核对记录生成等待说明。该函数不读取 GitHub，也不把旧作业、
 * 同名标签或其他需求的活跃作业混入当前版本。
 */
export function projectPanelWait(input: PanelWaitInput): PanelWaitProjection {
  if (!input.controllerOnline) {
    return projection(input, {
      state: 'unknown',
      role: 'unknown',
      title: '控制器离线',
      reason: '以下结论来自上次保存的记录，控制器恢复前无法确认当前许可和作业状态。',
      nextAction: '控制器恢复并刷新后再作决定。',
      basis: 'cached',
      humanActionRequired: false,
    });
  }

  if (input.conflict) {
    return projection(input, {
      state: 'unknown',
      role: 'unknown',
      title: '待核实',
      reason: '版本、作业或记录之间存在冲突，不能据此判断负责人和下一步。',
      nextAction: '核对本版 Issue、冻结派工记录和绑定作业后再刷新。',
      basis: 'conflict',
      humanActionRequired: false,
      evidenceGaps: ['本版记录互相冲突，未选择任何记录作为结论依据。'],
    });
  }

  if (input.superseded) {
    return projection(input, {
      state: 'complete',
      role: 'none',
      title: '历史版本',
      reason: `${revisionLabel(input.revision)} 已被同需求后续版本取代，此处的记录只用于追溯。`,
      nextAction: '查看最新版本或该版本自己的 PR、部署回执。',
      basis: 'current',
      humanActionRequired: false,
    });
  }

  const job = input.primaryJob;
  if (job) {
    const deploymentPrecedesJobStatus =
      nodeStatus(input, 'code-confirm') === 'succeeded'
      && (
        nodeStatus(input, 'build-deploy') === 'running'
        || nodeStatus(input, 'build-deploy') === 'succeeded'
      );

    if (nodeStatus(input, 'code-verify') === 'failed') {
      const verifyFailed = job.failureStage === 'verify';
      return projection(input, {
        state: 'failed',
        role: 'operator',
        title: verifyFailed ? '等你处理验收失败' : '等你处理执行失败',
        reason: verifyFailed
          ? `本版 ${revisionLabel(input.revision)} 在验收阶段失败，不能发布或确认完成。`
          : `本版 ${revisionLabel(input.revision)} 在${job.failureStage ?? '执行'}阶段失败，不能继续发布。`,
        nextAction: verifyFailed
          ? '查看本版验收记录，处理后显式重试；不要把其他版本的通过结果用于本版。'
          : '查看本版作业记录，处理后按控制器恢复路径重试。',
        basis: 'current',
        humanActionRequired: true,
        evidenceGaps: verifyFailed
          ? ['当前快照未索引本版 test-runs 记录，需通过本版作业筛选入口确认失败报告。']
          : [],
      });
    }

    if (nodeStatus(input, 'build-deploy') === 'failed') {
      return projection(input, {
        state: 'failed',
        role: 'operator',
        title: '等你处理部署失败',
        reason: `本版 ${revisionLabel(input.revision)} 代码已合并，但部署失败；旧预览仍在。`,
        nextAction: '查看部署记录并处理失败后，只重试未完成部署阶段。',
        basis: 'current',
        humanActionRequired: true,
        evidenceGaps: ['状态记录只有部署失败结论，缺少可定位的构建与健康检查回执。'],
      });
    }

    // 受控合并记录与部署节点是比 job 状态更晚的事实。markDeployed 会在远端
    // 部署成功后把 job 改为 done，但部署进行中的正常快照仍可能保留 in-review。
    if (deploymentPrecedesJobStatus) {
      if (nodeStatus(input, 'build-deploy') === 'running') {
        return projection(input, {
          state: 'waiting',
          role: 'controller',
          title: '等控制器完成发布',
          reason: `本版 ${revisionLabel(input.revision)} 的代码 PR 已由受控记录确认合并，部署和健康检查仍在进行。`,
          nextAction: '等待控制器完成本版部署、健康检查和回执。',
          basis: 'current',
          humanActionRequired: false,
        });
      }
      if (
        nodeStatus(input, 'health-receipt') === 'waiting'
        || job.resumeAction === 'sync-deploy-receipt'
      ) {
        return projection(input, {
          state: 'waiting',
          role: 'controller',
          title: '等控制器完成发布',
          reason: `本版 ${revisionLabel(input.revision)} 已部署，但健康检查或 GitHub 回执尚未补齐。`,
          nextAction: '等待控制器回读本版部署结果并补齐回执。',
          basis: 'current',
          humanActionRequired: false,
          evidenceGaps: ['本版健康检查或 GitHub 部署回执尚未补齐。'],
        });
      }
      if (
        nodeStatus(input, 'build-deploy') === 'succeeded'
        && nodeStatus(input, 'health-receipt') === 'succeeded'
      ) {
        if (input.deploymentReceiptHref === null) {
          return projection(input, {
            state: 'unknown',
            role: 'unknown',
            title: '待核实',
            reason: `状态记录显示本版 ${revisionLabel(input.revision)} 已部署，但缺少可定位的健康检查与部署回执。`,
            nextAction: '补齐本版部署回执引用或由控制器重新回读后再确认完成。',
            basis: 'unknown',
            humanActionRequired: false,
            evidenceGaps: ['健康检查与部署回执没有可定位地址，不能据 PR 部署结果冒充完整回执。'],
          });
        }
        return projection(input, {
          state: 'complete',
          role: 'none',
          title: '已部署，无需操作',
          reason: `本版 ${revisionLabel(input.revision)} 的受控合并、健康检查和部署回执齐全。`,
          nextAction: '无需操作，可查看本版代码 PR 和部署回执。',
          basis: 'current',
          humanActionRequired: false,
        });
      }
    }

    if (job.status === 'satisfied') {
      if (job.resumeAction === 'sync-satisfied-receipt') {
        return projection(input, {
          state: 'waiting',
          role: 'controller',
          title: '等控制器补齐回执',
          reason: `本版 ${revisionLabel(input.revision)} 已验收无需源码变更，也不涉及代码 PR 或部署，但 GitHub 回执尚未补齐。`,
          nextAction: '等待控制器写入并回读本版 Issue 回执；回执完成后才显示已验收。',
          basis: 'current',
          humanActionRequired: false,
          evidenceGaps: ['本版无变更验收已通过，但 Issue 回执尚未确认完成。'],
        });
      }
      return projection(input, {
        state: 'complete',
        role: 'none',
        title: '已验收，无需代码变更',
        reason: `本版 ${revisionLabel(input.revision)} 的源码已满足需求，验收通过且 Issue 回执已完成；没有代码 PR，也不需要部署。`,
        nextAction: '无需操作，可查看本版验收筛选结果和 Issue 回执记录。',
        basis: 'current',
        humanActionRequired: false,
      });
    }

    if (job.status === 'todo' || job.status === 'processing') {
      return projection(input, {
        state: 'active',
        role: 'code-agent',
        title: 'Code Agent 正在执行',
        reason: job.status === 'todo'
          ? `本版 ${revisionLabel(input.revision)} 已被领取，作业正在启动。`
          : `本版 ${revisionLabel(input.revision)} 的唯一作业正在执行。`,
        nextAction: '无需人工操作，等待作业产生 PR 或失败记录。',
        basis: 'current',
        humanActionRequired: false,
      });
    }

    if (job.status === 'in-review') {
      if (job.prNumber !== null) {
        return projection(input, {
          state: 'waiting',
          role: 'operator',
          title: '等你审查代码',
          reason: `本版代码 PR #${job.prNumber} 正在等待人工确认。`,
          nextAction: '打开本版代码 PR，完成审查和人工合并。',
          basis: 'current',
          humanActionRequired: true,
        });
      }
      return projection(input, {
        state: 'unknown',
        role: 'unknown',
        title: '待核实',
        reason: '作业处于待审状态，但没有绑定的代码 PR，不能确定人工入口。',
        nextAction: '核对本版作业与代码 PR 后刷新。',
        basis: 'unknown',
        humanActionRequired: false,
      });
    }

    if (job.status === 'done' || job.status === 'satisfied' || deploymentPrecedesJobStatus) {
      if (nodeStatus(input, 'code-confirm') === 'unknown' || nodeStatus(input, 'build-deploy') === 'unknown') {
        return projection(input, {
          state: 'unknown',
          role: 'unknown',
          title: '待核实',
          reason: '作业本身已结束，但缺少可核对的本版合并或部署依据。',
          nextAction: '核对同版本代码 PR、合并提交和部署回执后刷新。',
          basis: 'unknown',
          humanActionRequired: false,
        });
      }
      if (
        nodeStatus(input, 'health-receipt') === 'waiting'
        || job.resumeAction === 'sync-deploy-receipt'
        || job.resumeAction === 'sync-satisfied-receipt'
      ) {
        return projection(input, {
          state: 'waiting',
          role: 'controller',
          title: '等控制器完成发布',
          reason: `本版 ${revisionLabel(input.revision)} 已有部署或验收结果，但发布回执尚未补齐。`,
          nextAction: '等待控制器补齐本版回执；回执齐全前不会标为完成。',
          basis: 'current',
          humanActionRequired: false,
          evidenceGaps: ['GitHub 发布回执尚未补齐。'],
        });
      }
      if (nodeStatus(input, 'build-deploy') === 'running') {
        return projection(input, {
          state: 'waiting',
          role: 'controller',
          title: '等控制器完成发布',
          reason: `本版代码已合并，部署和健康检查仍在进行。`,
          nextAction: '等待控制器完成本版部署、健康检查和回执。',
          basis: 'current',
          humanActionRequired: false,
        });
      }
      if (
        nodeStatus(input, 'code-confirm') === 'succeeded'
        && nodeStatus(input, 'build-deploy') === 'succeeded'
        && nodeStatus(input, 'health-receipt') === 'succeeded'
      ) {
        if (input.deploymentReceiptHref === null) {
          return projection(input, {
            state: 'unknown',
            role: 'unknown',
            title: '待核实',
            reason: `状态记录显示本版 ${revisionLabel(input.revision)} 已部署，但缺少可定位的健康检查与部署回执。`,
            nextAction: '补齐本版部署回执引用或由控制器重新回读后再确认完成。',
            basis: 'unknown',
            humanActionRequired: false,
            evidenceGaps: ['健康检查与部署回执没有可定位地址，不能据 PR 部署结果冒充完整回执。'],
          });
        }
        return projection(input, {
          state: 'complete',
          role: 'none',
          title: '已部署，无需操作',
          reason: `本版 ${revisionLabel(input.revision)} 的合并、健康检查和部署回执齐全。`,
          nextAction: '无需操作，可查看本版代码 PR 和部署回执。',
          basis: 'current',
          humanActionRequired: false,
        });
      }
      if (job.resumeAction === 'sync-satisfied-receipt') {
        return projection(input, {
          state: 'waiting',
          role: 'controller',
          title: '等控制器完成发布',
          reason: `本版已确认无需代码变更，但验收回执尚未补齐。`,
          nextAction: '等待控制器补齐本版回执。',
          basis: 'current',
          humanActionRequired: false,
        });
      }
      return projection(input, {
        state: 'unknown',
        role: 'unknown',
        title: '待核实',
        reason: '作业已结束，但流程节点没有形成完整的同版本完成依据。',
        nextAction: '核对本版代码 PR、部署和健康检查记录后刷新。',
        basis: 'unknown',
        humanActionRequired: false,
      evidenceGaps: ['流程节点没有形成完整的同版本完成依据。'],
      });
    }

    if (job.status === 'failed') {
      return projection(input, {
        state: 'failed',
        role: 'operator',
        title: '等你处理失败',
        reason: `本版 ${revisionLabel(input.revision)} 的作业失败，原因记录不完整。`,
        nextAction: '查看本版作业记录并处理后再刷新。',
        basis: 'unknown',
        humanActionRequired: true,
      });
    }
  }

  const revision = input.revision;
  if (revision) {
    if (revision.publishedAt === null || revision.publicationCommentId === null) {
      return projection(input, {
        state: 'waiting',
        role: 'task-agent',
        title: '等任务 Agent 发布清单',
        reason: `控制器已持久记录本版 ${revisionLabel(revision)} 的冻结任务，但尚未回读任务清单的发布评论。`,
        nextAction: '等待任务 Agent 发布本版清单；发布回读后由控制器观察本版 Issue 的准确开工标签。',
        basis: 'current',
        humanActionRequired: false,
        evidenceGaps: ['冻结派工记录已存在，但任务清单发布评论尚未回读。'],
      });
    }

    const observation = revision.observation;
    if (!observation) {
      return projection(input, {
        state: 'unknown',
        role: 'unknown',
        title: '待核实',
        reason: revision.hasGrant
          ? `本版 ${revisionLabel(revision)} 有上次授权记录，但缺少发布后的当前许可观察。`
          : `本版 ${revisionLabel(revision)} 已发布，但尚无发布后的许可观察记录。`,
        nextAction: '等待控制器读取本版 Issue 当前标签和事件后刷新。',
        basis: 'unknown',
        humanActionRequired: false,
        evidenceGaps: ['缺少发布后的当前许可观察，不能据此判断等待谁。'],
      });
    }

    if (observation.state === 'unverified') {
      return projection(input, {
        state: 'unknown',
        role: 'unknown',
        title: '待核实',
        reason: `控制器最近一次读取本版 ${revisionLabel(revision)} 时无法确认有效开工许可。`,
        nextAction: '核对本版 Issue 当前标签、添加人和版本后刷新。',
        basis: 'unknown',
        humanActionRequired: false,
        evidenceGaps: ['最近一次许可读取失败、状态不明或证据冲突。'],
      });
    }

    if (observation.state === 'awaiting-label') {
      return projection(input, {
        state: 'waiting',
        role: 'operator',
        title: '等你排期',
        reason: `本版 ${revisionLabel(revision)} 尚无有效开工许可。`,
        nextAction: `在本版 Issue 添加准确标签 \`可开工/r${revision.revision}\`。`,
        basis: 'current',
        humanActionRequired: true,
      });
    }

    if (observation.state === 'authorized') {
      if (input.activeOtherJob) {
        return projection(input, {
          state: 'waiting',
          role: 'scheduler',
          title: '等调度器',
          reason: `本版 ${revisionLabel(revision)} 已获准开工，但唯一作业名额正被另一项作业占用。`,
          nextAction: '等待当前作业释放名额，调度器会在领取前再次核验本版许可。',
          basis: 'current',
          humanActionRequired: false,
        });
      }
      return projection(input, {
        state: 'waiting',
        role: 'scheduler',
        title: '等调度器',
        reason: `本版 ${revisionLabel(revision)} 已获准开工，当前尚无可领取作业。`,
        nextAction: '等待调度器在现时核验许可后领取一次。',
        basis: 'current',
        humanActionRequired: false,
      });
    }
  }

  if (input.documentStage === 'pr-open' || input.documentStage === 'review') {
    return projection(input, {
      state: 'waiting',
      role: 'operator',
      title: '等你确认文档',
      reason: '本需求的文档 PR 已打开，尚未合并。',
      nextAction: '审查并人工合并本需求的文档 PR。',
      basis: 'current',
      humanActionRequired: true,
    });
  }

  if (input.documentStage === 'pr-merged' && input.taskRegistration === 'absent') {
    return projection(input, {
      state: 'waiting',
      role: 'task-agent',
      title: '等任务 Agent 发布清单',
      reason: '受信记录已确认需求文档合并，并核对同仓、同需求、同版本任务仍不存在。',
      nextAction: '任务 Agent 发布本版普通 Issue、冻结清单和准确开工标签。',
      basis: 'current',
      humanActionRequired: false,
    });
  }

  if (input.documentStage === 'pr-merged' && input.taskRegistration === 'unknown') {
    return projection(input, {
      state: 'unknown',
      role: 'unknown',
      title: '待核实',
      reason: '已有文档合并依据，但没有可核对的同版本任务登记或缺失观察。',
      nextAction: '核对本版 Issue 和受信任务登记记录后刷新。',
      basis: 'unknown',
      humanActionRequired: false,
      evidenceGaps: ['缺少同仓、同需求、同版本的任务登记或明确缺失观察。'],
    });
  }

  if (input.taskRegistration === 'registered') {
    return projection(input, {
      state: 'waiting',
      role: 'controller',
      title: '等控制器同步版本',
      reason: '已登记本需求，但本地状态没有可核对的冻结派工版本。',
      nextAction: '等待控制器核对 Issue 并同步本版冻结记录。',
      basis: 'unknown',
      humanActionRequired: false,
    });
  }

  return projection(input, {
    state: 'unknown',
    role: 'unknown',
    title: '待核实',
    reason: '当前记录不足以确定本版的负责人、原因和下一步。',
    nextAction: '补齐本版需求、Issue、许可、作业和回执证据后刷新。',
    basis: 'unknown',
    humanActionRequired: false,
  });
}
