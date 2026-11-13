import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './log.ts';
import type { StateStore } from './state.ts';

export interface ControlServerOptions {
  state: StateStore;
  logger: Logger;
  retry: (issueNumber: number) => Promise<string>;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage, limitBytes = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      if (raw.length > limitBytes) {
        overflow = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (overflow) {
        reject(new Error('请求体过大'));
        return;
      }
      try {
        resolve(raw ? (JSON.parse(raw) as unknown) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function hostHeader(req: Pick<IncomingMessage, 'headers'>): string {
  const host = req.headers.host ?? '';
  return host.split(':')[0] ?? '';
}

/**
 * 拒绝外站 Origin / 不合规 Content-Type / 非本机 Host，避免任意网页触发本地 GitHub 写操作。
 * 非浏览器客户端（curl/CLI）通常不携带 Origin，放行；携带 Origin 的请求必须指向本机。
 */
export function isCrossSiteRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const host = hostHeader(req);
  if (host && !isLocalHostname(host)) return true;

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const url = new URL(origin);
      if (!isLocalHostname(url.hostname)) return true;
    } catch {
      return true;
    }
  }

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) return true;
  return false;
}

export function createControlServer(opts: ControlServerOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const s = opts.state.snapshot();
      sendJson(res, 200, {
        repo: s.repo,
        cursorMainSha: s.cursorMainSha,
        requirements: Object.keys(s.requirements).length,
        jobs: s.jobs,
        deploy: s.deploy,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/retry') {
      if (isCrossSiteRequest(req)) {
        sendJson(res, 403, { error: '拒绝跨站请求' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const issueNumber =
        body && typeof body === 'object' && typeof (body as { issueNumber?: unknown }).issueNumber === 'number'
          ? (body as { issueNumber: number }).issueNumber
          : Number.NaN;
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        sendJson(res, 400, { error: 'issueNumber 必须是正整数' });
        return;
      }
      try {
        const result = await opts.retry(issueNumber);
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        opts.logger.error(`重试命令失败: ${error instanceof Error ? error.message : String(error)}`);
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found\n');
  });
}
