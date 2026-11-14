import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { buildPanelView, type PanelView } from './panel-view.ts';

export interface PanelServerOptions {
  readView: () => Promise<PanelView>;
  assetsDir: string;
}

export interface StaticAsset {
  file: string;
  type: string;
}

const ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.(?:js|css)$/;

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

// React Flow 运行时通过内联 style 设置节点位置/尺寸，故允许 style 内联；脚本保持 self。
const CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

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

export function createPanelServer(opts: PanelServerOptions): Server {
  const cache = new Map<string, Buffer>();
  let rootReal: string | null | undefined;

  const assetsRootReal = (): string | null => {
    if (rootReal === undefined) rootReal = realpathOrNull(opts.assetsDir);
    return rootReal;
  };

  const readAsset = (file: string): Buffer | null => {
    const cached = cache.get(file);
    if (cached) return cached;
    try {
      const root = assetsRootReal();
      if (!root) return null;
      const full = resolve(opts.assetsDir, file);
      const real = realpathSync(full);
      // 符号链接逃逸到 assetsDir 之外一律拒绝。
      if (real !== root && !real.startsWith(root + sep)) return null;
      const content = readFileSync(real);
      cache.set(file, content);
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

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendText(res, 400, 'bad request\n', 'text/plain; charset=utf-8');
      return;
    }

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

    const asset = resolveStaticAsset(pathname);
    if (!asset) {
      sendText(res, 404, 'not found\n', 'text/plain; charset=utf-8');
      return;
    }

    const content = readAsset(asset.file);
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
