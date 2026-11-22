export interface DispatchLabelEvent {
  id: number;
  actorId: string | null;
  name: string;
  event: 'labeled' | 'unlabeled';
  createdAt: string;
}

/**
 * 从 Issue 当前标签和历史事件中恢复本版开工许可。
 *
 * 当前标签必须包含精确的“可开工/rN”，并且严格晚于发布时间的最新一次同名标签
 * 事件必须是白名单用户的添加。事件缺页、冲突 ID、最新时间无法定序或当前标签与
 * 最新事件不一致时均返回 null。
 */
export function currentDispatchGrant(
  events: DispatchLabelEvent[],
  labels: string[],
  revision: number,
  publishedAt: string,
  allowedIds: readonly string[],
): DispatchLabelEvent | null {
  if (!Number.isSafeInteger(revision) || revision < 1) return null;

  const dispatchLabel = `可开工/r${revision}`;
  if (!labels.includes(dispatchLabel)) return null;

  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return null;

  const allowed = new Set(allowedIds.map((id) => id.trim()).filter((id) => id.length > 0));
  if (allowed.size === 0) return null;

  const eventsById = new Map<number, DispatchLabelEvent>();
  const candidates: Array<{ event: DispatchLabelEvent; createdAtMs: number }> = [];

  for (const event of events) {
    if (!Number.isSafeInteger(event.id) || event.id <= 0) return null;
    const previous = eventsById.get(event.id);
    if (previous) {
      if (!sameDispatchLabelEvent(previous, event)) return null;
      continue;
    }
    eventsById.set(event.id, event);

    if (event.name !== dispatchLabel) continue;

    const createdAtMs = Date.parse(event.createdAt);
    if (!Number.isFinite(createdAtMs)) return null;
    if (createdAtMs <= publishedMs) continue;
    candidates.push({ event, createdAtMs });
  }

  if (candidates.length === 0) return null;

  const latestCreatedAtMs = Math.max(...candidates.map((candidate) => candidate.createdAtMs));
  const latestGroup = candidates.filter((candidate) => candidate.createdAtMs === latestCreatedAtMs);
  if (latestGroup.length !== 1) return null;

  const latest = latestGroup[0]!.event;
  if (latest.event !== 'labeled') return null;

  const actorId = latest.actorId?.trim();
  if (!actorId || !allowed.has(actorId)) return null;
  return latest;
}

function sameDispatchLabelEvent(left: DispatchLabelEvent, right: DispatchLabelEvent): boolean {
  return left.id === right.id
    && left.actorId === right.actorId
    && left.name === right.name
    && left.event === right.event
    && left.createdAt === right.createdAt;
}
