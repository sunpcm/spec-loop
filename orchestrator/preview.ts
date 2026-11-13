import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import type { Logger } from './log.ts';

export interface PreviewPointer {
  activeSha: string | null;
  releaseDir: string | null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const RELEASE_ROUTE_RE = /^\/releases\/([0-9a-f]{40})(?:\/(.*))?$/;

type ResolvedFile =
  | { ok: true; filePath: string }
  | { ok: false; status: 403 | 404 };

function resolveReleaseFile(rootDir: string, pathname: string): ResolvedFile {
  let requestPath = pathname;
  if (requestPath.endsWith('/')) requestPath += 'index.html';
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return { ok: false, status: 403 };
  }
  if (decoded.includes('\0')) return { ok: false, status: 403 };

  const root = normalize(rootDir);
  const filePath = normalize(join(root, decoded));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    return { ok: false, status: 403 };
  }

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(filePath);
  } catch {
    return { ok: false, status: 404 };
  }
  // normalize 只能拦住词法穿越；symlink 指向发布根外时必须在 realpath 层再次拦截。
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
    return { ok: false, status: 403 };
  }
  try {
    if (!statSync(realFile).isFile()) return { ok: false, status: 404 };
  } catch {
    return { ok: false, status: 404 };
  }
  return { ok: true, filePath: realFile };
}

function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
  pathnameOverride?: string,
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const resolved = resolveReleaseFile(rootDir, pathnameOverride ?? url.pathname);
  if (!resolved.ok) {
    res.statusCode = resolved.status;
    res.end(resolved.status === 403 ? 'forbidden\n' : 'not found\n');
    return;
  }

  const ext = extname(resolved.filePath);
  res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(resolved.filePath).pipe(res);
}

function sendVersion(res: ServerResponse, version: string): void {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ version }));
}

function makeHandler(
  getVersion: () => string,
  getRoot: () => string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = RELEASE_ROUTE_RE.exec(url.pathname);
    if (url.pathname.startsWith('/releases/') && !route) {
      res.statusCode = 404;
      res.end('invalid release\n');
      return;
    }
    if (route && route[2] === undefined) {
      res.statusCode = 308;
      res.setHeader('Location', `${url.pathname}/`);
      res.end();
      return;
    }
    if (url.pathname === '/__version') {
      sendVersion(res, getVersion());
      return;
    }
    if (route?.[2] === '__version') {
      sendVersion(res, route[1]);
      return;
    }

    const root = getRoot();
    if (!root) {
      res.statusCode = 503;
      res.end('no active release\n');
      return;
    }
    if (route) {
      // 版本化路由先收敛到对应 release 目录，再把剩余路径交给安全解析器；
      // 当前与历史 SHA 都可访问，根路径仍始终指向 active.releaseDir。
      serveFile(req, res, join(dirname(root), route[1]), `/${route[2]}`);
      return;
    }
    serveFile(req, res, root);
  };
}

export function createPreviewServer(
  getActive: () => PreviewPointer,
  logger: Logger,
  _port = 5173,
): Server {
  const server = createServer(
    makeHandler(
      () => getActive().activeSha ?? 'dev',
      () => getActive().releaseDir ?? '',
    ),
  );
  server.on('error', (error) => {
    logger.error(`预览服务错误: ${error.message}`);
  });
  return server;
}

/** 服务于固定发布目录的静态服务器，供部署前 HTTP 健康检查使用（不主动 listen）。 */
export function createStaticServer(rootDir: string, version: string, logger: Logger): Server {
  const server = createServer(makeHandler(() => version, () => rootDir));
  server.on('error', (error) => {
    logger.error(`静态检查服务错误: ${error.message}`);
  });
  return server;
}

/** 从 index.html 提取相对资源引用（src/href），用于验证版本化资源真实可服务。 */
export function extractAssetRefs(html: string): string[] {
  const refs: string[] = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const value = match[1] ?? '';
    if (
      !value ||
      value.startsWith('http') ||
      value.startsWith('//') ||
      value.startsWith('data:') ||
      value.startsWith('#')
    ) {
      continue;
    }
    refs.push(value.replace(/^\.?\//, ''));
  }
  return refs;
}
