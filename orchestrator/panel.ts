import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { createPanelServer } from './panel-server.ts';
import { buildPanelView, parsePanelState, type PanelView } from './panel-view.ts';

const DEFAULT_PORT = 4001;
const DEFAULT_CONTROL_PORT = 4000;

export interface PanelCliArgs {
  port: number;
  controlPort: number;
  controlEnabled: boolean;
  stateFile: string;
}

function isPort(value: string): boolean {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 && String(n) === value.trim();
}

export function parsePanelArgs(argv: string[]): PanelCliArgs {
  let port = DEFAULT_PORT;
  let controlPort = DEFAULT_CONTROL_PORT;
  let controlEnabled = true;
  let stateFile = resolve(process.cwd(), '.orchestrator-state.json');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--port') {
      const value = argv[++i];
      if (!value || !isPort(value)) throw new Error('--port 必须是 1-65535 的整数');
      port = Number.parseInt(value, 10);
    } else if (arg === '--control-port') {
      const value = argv[++i];
      if (!value || !isPort(value)) throw new Error('--control-port 必须是 1-65535 的整数');
      controlPort = Number.parseInt(value, 10);
    } else if (arg === '--state') {
      const value = argv[++i];
      if (!value) throw new Error('--state 缺少路径');
      stateFile = resolve(value);
    } else if (arg === '--no-control') {
      controlEnabled = false;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(
        '用法: node orchestrator/panel.ts [--port 4001] [--state 路径] [--control-port 4000] [--no-control]',
      );
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (controlEnabled && port === controlPort) {
    throw new Error('--port 与 --control-port 相同时健康探测会命中面板自身，请使用不同端口或加 --no-control');
  }

  return { port, controlPort, controlEnabled, stateFile };
}

function readStateFile(stateFile: string): { raw: string | null; stateUpdatedAt: string | null; missing: boolean } {
  let stat;
  try {
    stat = statSync(stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, stateUpdatedAt: null, missing: true };
    }
    return { raw: null, stateUpdatedAt: null, missing: false };
  }
  if (!stat.isFile()) return { raw: null, stateUpdatedAt: null, missing: false };
  try {
    const raw = readFileSync(stateFile, 'utf8');
    return { raw, stateUpdatedAt: stat.mtime.toISOString(), missing: false };
  } catch {
    return { raw: null, stateUpdatedAt: null, missing: false };
  }
}

async function probeController(controlPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort}/api/health`, {
      signal: AbortSignal.timeout(500),
      redirect: 'error',
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body?.ok === true;
  } catch {
    return false;
  }
}

function createReader(args: PanelCliArgs): () => Promise<PanelView> {
  let controllerOnline = false;
  let lastProbeAt = 0;
  const controlTtlMs = 1500;

  return async (): Promise<PanelView> => {
    const observedAt = new Date().toISOString();
    const file = readStateFile(args.stateFile);
    let state = null;
    let stateKind: 'ok' | 'missing' | 'invalid' | 'unsupported' = 'ok';

    if (file.missing) {
      stateKind = 'missing';
    } else if (file.raw === null) {
      stateKind = 'invalid';
    } else {
      const parsed = parsePanelState(file.raw);
      state = parsed.state;
      stateKind = parsed.kind;
    }

    if (args.controlEnabled) {
      const now = Date.now();
      if (now - lastProbeAt >= controlTtlMs) {
        controllerOnline = await probeController(args.controlPort);
        lastProbeAt = now;
      }
    } else {
      controllerOnline = false;
    }

    return buildPanelView(state, {
      observedAt,
      stateUpdatedAt: file.stateUpdatedAt,
      stateKind,
      controllerOnline,
    });
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  let args: PanelCliArgs;
  try {
    args = parsePanelArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const assetsDir = resolve(process.cwd(), '.orchestrator/panel-dist');
  const server = createPanelServer({
    readView: createReader(args),
    assetsDir,
  });

  try {
    await listen(server, args.port);
  } catch (error) {
    process.stderr.write(`无法启动面板: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`只读流程面板: http://127.0.0.1:${args.port}\n`);
  process.stdout.write(`状态文件: ${args.stateFile}\n`);
  if (args.controlEnabled) {
    process.stdout.write(`控制器健康探测: http://127.0.0.1:${args.controlPort}/api/health\n`);
  }

  const shutdown = (signal: string): void => {
    process.stdout.write(`收到 ${signal}，退出\n`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.main) void main();
