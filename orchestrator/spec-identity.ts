import { createHash } from 'node:crypto';

export const MAX_SPEC_DESCRIPTION_LENGTH = 2000;
export const SPEC_REQUEST_ID_RE = /^[0-9a-f]{12}$/;

export function normalizeSpecDescription(description: string): string {
  const normalized = description.trim();
  if (normalized.length === 0) {
    throw new Error('需求描述为空');
  }
  if (normalized.length > MAX_SPEC_DESCRIPTION_LENGTH) {
    throw new Error(`需求描述超过 ${MAX_SPEC_DESCRIPTION_LENGTH} 字符`);
  }
  return normalized;
}

export function computeSpecRequestId(messageId: string): string {
  const normalized = messageId.trim();
  if (!normalized) {
    throw new Error('缺少飞书消息 ID，拒绝生成需求请求');
  }
  return createHash('sha256').update(`feishu-message\n${normalized}`).digest('hex').slice(0, 12);
}

export function computeSpecBranch(requestId: string): string {
  if (!SPEC_REQUEST_ID_RE.test(requestId)) {
    throw new Error(`非法需求请求 ID: ${requestId}`);
  }
  return `pi/spec-${requestId}`;
}
