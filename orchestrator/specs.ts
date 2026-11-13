import { createHash } from 'node:crypto';
import type { Spec, SpecDiff, SpecDiffEntry } from './types.ts';

export const REQ_ID_RE = /^REQ-[A-Z0-9]+-[0-9]{2,}$/;
const HEADING_RE = /^###\s+\[(REQ-[A-Z0-9]+-[0-9]{2,})\]\s+(.+)$/;
const BRACKET_HEADING_RE = /^###\s+\[.*\]/;

export interface ParseIssue {
  path: string;
  line: number;
  reason: string;
}

export interface ParseResult {
  specs: Spec[];
  errors: ParseIssue[];
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function hashBlock(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function parseSpecs(files: Record<string, string>): ParseResult {
  const specs: Spec[] = [];
  const errors: ParseIssue[] = [];
  const seenIds = new Map<string, string>();

  for (const path of Object.keys(files).sort()) {
    const lines = normalize(files[path] ?? '').split('\n');
    let inFence = false;
    let fenceMarker = '';
    let current: { id: string; title: string; start: number; lines: string[] } | null = null;

    const finalize = (): void => {
      if (!current) return;
      const body = current.lines.join('\n');
      const id = current.id;
      if (seenIds.has(id)) {
        errors.push({ path, line: current.start, reason: `重复的需求 ID: ${id}` });
      } else {
        seenIds.set(id, path);
        specs.push({
          id,
          title: current.title,
          path,
          body,
          hash: hashBlock(body),
        });
      }
      current = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();

      const fence = /^```+|^~~~+/.exec(trimmed);
      if (fence) {
        const marker = fence[0];
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
          inFence = false;
          fenceMarker = '';
        }
        if (current) current.lines.push(line);
        continue;
      }

      if (inFence) {
        if (current) current.lines.push(line);
        continue;
      }

      if (trimmed.startsWith('### ')) {
        if (BRACKET_HEADING_RE.test(trimmed)) {
          const match = HEADING_RE.exec(trimmed);
          if (!match || !match[2]?.trim()) {
            errors.push({ path, line: i + 1, reason: `非法需求标题: ${trimmed}` });
            if (current) current.lines.push(line);
            continue;
          }
          finalize();
          current = { id: match[1], title: match[2].trim(), start: i + 1, lines: [line] };
        } else {
          finalize();
        }
        continue;
      }

      if (current) current.lines.push(line);
    }

    finalize();
  }

  return { specs, errors };
}

export function diffSpecs(previous: Spec[], next: Spec[]): SpecDiffEntry[] {
  const prevById = new Map(previous.map((s) => [s.id, s]));
  const nextById = new Map(next.map((s) => [s.id, s]));
  const entries: SpecDiffEntry[] = [];

  for (const id of nextById.keys()) {
    const spec = nextById.get(id)!;
    const prev = prevById.get(id);
    if (!prev) {
      entries.push({ action: 'add', id, spec, pathChanged: false, contentChanged: true });
    } else {
      const contentChanged = prev.hash !== spec.hash;
      const pathChanged = prev.path !== spec.path;
      const action = contentChanged ? 'update' : pathChanged ? 'move' : 'unchanged';
      entries.push({ action, id, spec, previous: prev, pathChanged, contentChanged });
    }
  }

  for (const id of prevById.keys()) {
    if (!nextById.has(id)) {
      entries.push({ action: 'remove', id, previous: prevById.get(id), pathChanged: false, contentChanged: true });
    }
  }

  return entries;
}

export function buildSpecDiff(previous: Spec[], next: Spec[], targetMainSha: string): SpecDiff {
  return { entries: diffSpecs(previous, next), targetMainSha };
}

export function hashSpecBody(body: string): string {
  return hashBlock(normalize(body));
}
