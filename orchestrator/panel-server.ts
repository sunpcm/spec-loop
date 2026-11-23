import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { buildPanelView, type PanelView } from './panel-view.ts';
import {
  createTestEvidenceStore,
  isTestRunDispatchRevision,
  isTestRunSpecPath,
  type TestEvidenceStore,
  type TestRunsResponse,
} from './test-evidence.ts';

export interface PanelServerOptions {
  readView: () => Promise<PanelView>;
  assetsDir: string;
  /** 面板受控版本发布根；未配置时兼容旧的单一 panel-dist 目录。 */
  panelReleaseRootDir?: string;
  /** 每次请求读取已校验的活动版本；缺省或返回空时回退旧 assetsDir。 */
  readActivePanelSha?: () => string | null;
  testEvidence?: TestEvidenceStore;
}

export interface StaticAsset {
  file: string;
  type: string;
}

const ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.(?:js|css)$/;
const TEST_RUN_FILTER_KEYS = new Set([
  'jobId',
  'reqId',
  'specHash',
  'specPath',
  'dispatchRevision',
  'sourceMainSha',
  'candidateTreeSha',
]);
const TEST_RUN_ID_FILTER_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const TEST_RUN_SHA_FILTER_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TEST_RUN_REVISION_FILTER_RE = /^[1-9][0-9]*$/;

/**
 * 固定静态资源白名单：仅 index.html 与构建产物 assets/*.(js|css)。
 * 不遍历目录、不读任意文件；路径只能命中单段文件名的 js/css。
 */
export function resolveStaticAsset(pathname: string): StaticAsset | null {
  if (pathname === '/' || pathname === '/index.html') {
    return { file: 'index.html', type: 'text/html; charset=utf-8' };
  }
  const match = /^\/assets\/([A-Za-z0-9._-]+\.(?:js|css))$/.exec(pathname);
  if (!match) return null;
  const name = match[1]!;
  if (!ASSET_NAME_RE.test(name)) return null;
  const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
  return { file: join('assets', name), type };
}

/**
 * 解析受控面板历史路由。只允许活动 SHA、首页与单段 assets 文件，
 * 不接受任意嵌套路径或兄弟 release。
 */
export function resolvePanelReleaseAsset(
  pathname: string,
  activeSha: string | null,
): StaticAsset | null {
  if (!activeSha || !/^[0-9a-f]{40}$/.test(activeSha)) return null;
  const match = /^\/releases\/([0-9a-f]{40})(?:\/(.*))?$/.exec(pathname);
  if (!match || match[1] !== activeSha) return null;
  const remainder = match[2] ?? '';
  if (remainder === '' || remainder === 'index.html') {
    return { file: 'index.html', type: 'text/html; charset=utf-8' };
  }
  const assetMatch = /^assets\/([A-Za-z0-9._-]+\.(?:js|css))$/.exec(remainder);
  if (!assetMatch) return null;
  const name = assetMatch[1]!;
  if (!ASSET_NAME_RE.test(name)) return null;
  return {
    file: join('assets', name),
    type: name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/css; charset=utf-8',
  };
}

type TestRunFilterKey =
  | 'jobId'
  | 'reqId'
  | 'specHash'
  | 'specPath'
  | 'dispatchRevision'
  | 'sourceMainSha'
  | 'candidateTreeSha';

/**
 * 按本版作业身份筛选受管 test-runs。筛选只缩小已经脱敏、已限额的只读索引，
 * 不接受路径或任意表达式；未知筛选键返回 400，避免把全局列表误当成精确证据。
 */
export function filterTestRunsResponse(
  response: TestRunsResponse,
  search: URLSearchParams,
): TestRunsResponse | null {
  const filters = new Map<TestRunFilterKey, string | number>();
  for (const [key, value] of search) {
    if (!TEST_RUN_FILTER_KEYS.has(key) || filters.has(key as TestRunFilterKey) || !value) return null;
    if (key === 'specHash' || key === 'sourceMainSha' || key === 'candidateTreeSha') {
      if (!TEST_RUN_SHA_FILTER_RE.test(value)) return null;
      filters.set(key, value);
      continue;
    }
    if (key === 'specPath') {
      if (!isTestRunSpecPath(value)) return null;
      filters.set(key, value);
      continue;
    }
    if (key === 'dispatchRevision') {
      if (!TEST_RUN_REVISION_FILTER_RE.test(value)) return null;
      const revision = Number(value);
      if (!isTestRunDispatchRevision(revision)) return null;
      filters.set(key, revision);
      continue;
    }
    if (!TEST_RUN_ID_FILTER_RE.test(value)) return null;
    filters.set(key as TestRunFilterKey, value);
  }
  if (filters.size === 0) return response;
  return {
    schemaVersion: response.schemaVersion,
    runs: response.runs.filter((run) => {
      for (const [key, expected] of filters) {
        if (run[key] !== expected) return false;
      }
      return true;
    }),
  };
}

// React Flow 运行时通过内联 style 设置节点位置/尺寸，故允许 style 内联；脚本保持 self。
const CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'";

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isLocalHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function parseAuthority(host: string): { hostname: string; port: number } | null {
  if (!host) return null;
  let hostname = host;
  let port = 80;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return null;
    hostname = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest.startsWith(':')) {
      const portRaw = rest.slice(1);
      if (!/^\d+$/.test(portRaw)) return null;
      port = Number.parseInt(portRaw, 10);
    } else if (rest) {
      return null;
    }
  } else {
    const colon = host.indexOf(':');
    if (colon >= 0) {
      hostname = host.slice(0, colon);
      const portRaw = host.slice(colon + 1);
      if (!/^\d+$/.test(portRaw)) return null;
      port = Number.parseInt(portRaw, 10);
    }
  }
  if (!hostname) return null;
  return { hostname, port };
}

function isCrossSiteRequest(req: IncomingMessage): boolean {
  const authority = parseAuthority(req.headers.host ?? '');
  if (!authority) return true;
  if (!isLocalHostname(authority.hostname)) return true;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return true;
    }
    if (url.protocol !== 'http:') return true;
    if (normalizeHostname(url.hostname) !== normalizeHostname(authority.hostname)) return true;
    const originPort = url.port ? Number.parseInt(url.port, 10) : 80;
    if (originPort !== authority.port) return true;
  }
  return false;
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function safeDownloadName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return sanitized || 'artifact';
}

function readFileSize(path: string): { size: number } | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { size: stat.size } : null;
  } catch {
    return null;
  }
}

function createArtifactReadStream(path: string, range?: { start: number; end: number }) {
  return createReadStream(path, range);
}

type ByteRangeResult =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'range'; start: number; end: number };

export function parseByteRange(value: string | undefined, size: number): ByteRangeResult {
  if (value === undefined) return { kind: 'none' };
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'none' };
  if (!trimmed.startsWith('bytes=')) return { kind: 'invalid' };
  const spec = trimmed.slice('bytes='.length);
  if (spec.includes(',')) return { kind: 'invalid' };
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return { kind: 'invalid' };
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (!startRaw && !endRaw) return { kind: 'invalid' };
  if (size === 0) return { kind: 'invalid' };

  if (startRaw) {
    const start = Number(startRaw);
    if (!Number.isSafeInteger(start) || start < 0) return { kind: 'invalid' };
    if (start >= size) return { kind: 'invalid' };
    let end = size - 1;
    if (endRaw) {
      const parsedEnd = Number(endRaw);
      if (!Number.isSafeInteger(parsedEnd) || parsedEnd < 0) return { kind: 'invalid' };
      if (parsedEnd < start) return { kind: 'invalid' };
      end = Math.min(parsedEnd, size - 1);
    }
    return { kind: 'range', start, end };
  }

  const suffixLength = Number(endRaw);
  if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
  if (suffixLength >= size) return { kind: 'range', start: 0, end: size - 1 };
  return { kind: 'range', start: size - suffixLength, end: size - 1 };
}

export function createPanelServer(opts: PanelServerOptions): Server {
  const cache = new Map<string, Buffer>();
  const roots = new Map<string, string>();

  const activePanelSha = (): string | null => {
    const sha = opts.readActivePanelSha?.() ?? null;
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  };

  const assetsRootReal = (rootDir: string): string | null => {
    const cached = roots.get(rootDir);
    if (cached) return cached;
    const resolved = realpathOrNull(rootDir);
    if (resolved) roots.set(rootDir, resolved);
    return resolved;
  };

  const readAsset = (rootDir: string, file: string): Buffer | null => {
    const cacheKey = `${rootDir}\0${file}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    try {
      const root = assetsRootReal(rootDir);
      if (!root) return null;
      const full = resolve(rootDir, file);
      const real = realpathSync(full);
      // 符号链接逃逸到 assetsDir 之外一律拒绝。
      if (real !== root && !real.startsWith(root + sep)) return null;
      const content = readFileSync(real);
      cache.set(cacheKey, content);
      return content;
    } catch {
      return null;
    }
  };

  return createServer(async (req, res) => {
    if (isCrossSiteRequest(req)) {
      sendText(res, 403, 'forbidden\n', 'text/plain; charset=utf-8');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8');
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendText(res, 400, 'bad request\n', 'text/plain; charset=utf-8');
      return;
    }
    const pathname = requestUrl.pathname;

    if (pathname === '/api/panel') {
      let view: PanelView;
      try {
        view = await opts.readView();
      } catch {
        view = buildPanelView(null, {
          observedAt: new Date().toISOString(),
          stateUpdatedAt: null,
          stateKind: 'invalid',
          controllerOnline: false,
        });
      }
      sendJson(res, 200, view);
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/test-runs') {
      if (!opts.testEvidence) {
        sendJson(res, 200, { schemaVersion: 'test-runs/v1', runs: [] });
        return;
      }
      const filtered = filterTestRunsResponse(opts.testEvidence.listRuns(), requestUrl.searchParams);
      if (!filtered) {
        sendJson(res, 400, { error: 'invalid test-run filter' });
        return;
      }
      sendJson(res, 200, filtered);
      return;
    }

    const testRunArtifactMatch = /^\/api\/test-runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
    if (testRunArtifactMatch && opts.testEvidence) {
      const runId = decodePathSegment(testRunArtifactMatch[1] ?? '');
      const artifactId = decodePathSegment(testRunArtifactMatch[2] ?? '');
      const artifact = opts.testEvidence.readRunArtifact(runId, artifactId);
      if (!artifact) {
        sendText(res, 404, 'not found\n', 'text/plain; charset=utf-8');
        return;
      }

      const stat = readFileSize(artifact.path);
      if (!stat) {
        sendText(res, 404, 'not found\n', 'text/plain; charset=utf-8');
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', artifact.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'bytes');
      if (artifact.kind === 'json' || artifact.kind === 'trace') {
        res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(artifact.name)}"`);
      }
      const range = parseByteRange(req.headers.range, stat.size);
      if (range.kind === 'invalid') {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }
      if (range.kind === 'range') {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
      } else {
        res.setHeader('Content-Length', String(stat.size));
      }
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createArtifactReadStream(
        artifact.path,
        range.kind === 'range' ? { start: range.start, end: range.end } : undefined,
      );
      stream.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end('not found\n');
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
      return;
    }

    let asset: StaticAsset | null;
    let assetRoot: string;
    const activeSha = activePanelSha();
    if (pathname.startsWith('/releases/')) {
      asset = opts.panelReleaseRootDir
        ? resolvePanelReleaseAsset(pathname, activeSha)
        : null;
      assetRoot = opts.panelReleaseRootDir && activeSha
        ? resolve(opts.panelReleaseRootDir, activeSha)
        : opts.assetsDir;
    } else {
      asset = resolveStaticAsset(pathname);
      assetRoot = opts.panelReleaseRootDir && activeSha
        ? resolve(opts.panelReleaseRootDir, activeSha)
        : opts.assetsDir;
    }
    if (!asset) {
      sendText(res, 404, 'not found\n', 'text/plain; charset=utf-8');
      return;
    }

    const content = readAsset(assetRoot, asset.file);
    if (!content) {
      sendText(res, 404, 'not found\n', 'text/plain; charset=utf-8');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', asset.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (asset.file === 'index.html') {
      res.setHeader('Content-Security-Policy', CSP);
    }
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(content);
    }
  });
}
