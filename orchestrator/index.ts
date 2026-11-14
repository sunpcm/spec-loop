import type { Server } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { createControlServer } from './control-server.ts';
import { createFeishuBridgeRuntime } from './feishu-factory.ts';
import type { FeishuBridge } from './feishu-contract.ts';
import { GitClient } from './git.ts';
import { acquireInstanceLock, type InstanceLock } from './lock.ts';
import { createLogger } from './log.ts';
import { createPreviewServer } from './preview.ts';
import { createCore, resolveRepoFromOrigin, runOnce } from './runtime.ts';

export type ExclusiveRunner = <T>(task: () => Promise<T>) => Promise<T>;

/** 轮询与写命令共用的进程内串行门；只包住会写状态/远端的命令。 */
export function createExclusiveRunner(): ExclusiveRunner {
  let active: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = active.then(task, task);
    active = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function createBridgedCommands(
  commands: import('./feishu-contract.ts').FeishuCommands,
  runExclusive: ExclusiveRunner,
): import('./feishu-contract.ts').FeishuCommands {
  return {
    status: () => commands.status(),
    retry: (issueNumber: number) => runExclusive(() => commands.retry(issueNumber)),
    help: () => commands.help(),
    require: (description: string, messageId?: string) =>
      runExclusive(() => commands.require(description, messageId)),
    retryRequirement: (requestId: string) =>
      runExclusive(() => commands.retryRequirement(requestId)),
    merge: (prNumber, context) => runExclusive(() => commands.merge(prNumber, context)),
    confirmMerge: (prNumber, confirmationCode, context) =>
      runExclusive(() => commands.confirmMerge(prNumber, confirmationCode, context)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server: Server | null): Promise<void> {
  return server
    ? new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
    : Promise.resolve();
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('DAEMON');
  const git = new GitClient();

  let lock: InstanceLock | null = null;
  let bridge: FeishuBridge | null = null;
  let controlServer: Server | null = null;
  let previewServer: Server | null = null;
  let stopped = false;

  const releaseLock = (): void => {
    if (lock) {
      lock.release();
      lock = null;
    }
  };

  const cleanup = async (): Promise<void> => {
    await closeServer(controlServer);
    await closeServer(previewServer);
    if (bridge) {
      try {
        await bridge.stop();
      } catch {
        // 停止桥尽力而为。
      }
      bridge = null;
    }
    releaseLock();
  };

  const fail = async (message: string): Promise<void> => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    await cleanup();
  };

  // 全局串行互斥：轮询 runOnce 与 HTTP/飞书写命令共用同一条队列。
  const runExclusive = createExclusiveRunner();

  // 默认本地降级；飞书桥启动成功后替换为真实桥通知。
  let send: (text: string) => Promise<void> = async (text) => {
    logger.info(`通知（本地降级）: ${text}`);
  };
  const notify = (text: string): Promise<void> => send(text);

  try {
    const repo = config.repo ?? (await resolveRepoFromOrigin(git, config.repoDir));
    if (!repo) {
      await fail('未绑定仓库：请配置 origin（或 SPEC_LOOP_REPO）后重试');
      return;
    }

    lock = acquireInstanceLock(join(config.runDir, 'daemon.lock'));
    if (!lock.acquired) {
      process.stderr.write(`无法启动：${lock.reason ?? '已有实例运行'}\n`);
      process.exitCode = 1;
      return;
    }

    // createCore 在 try 内：抛错（如状态文件损坏）会走 catch -> fail -> cleanup 释放锁。
    const core = createCore(config, repo, notify);

    const existingRepo = core.state.snapshot().repo;
    if (existingRepo && existingRepo !== repo) {
      await fail(`状态文件已绑定仓库 ${existingRepo}，与目标 ${repo} 不一致，拒绝启动`);
      return;
    }
    await core.state.update((s) => {
      if (s.repo !== repo) s.repo = repo;
      return undefined;
    });

    // 飞书桥（可选）：失败降级为仅本地控制接口，不阻断守护进程启动。
    try {
      // status/help 只读取快照；写命令仍与轮询任务共用串行队列。
      const bridgedCommands = createBridgedCommands(core.commands, runExclusive);
      bridge = await createFeishuBridgeRuntime(config.feishu, bridgedCommands, (m) => logger.info(m));
      if (bridge) await bridge.start();
    } catch (error) {
      logger.warn(`飞书桥启动失败，降级为仅本地控制接口: ${error instanceof Error ? error.message : String(error)}`);
      bridge = null;
    }
    send = async (text) => {
      if (bridge) await bridge.notify(text);
    };

    controlServer = createControlServer({
      state: core.state,
      logger: createLogger('CONTROL'),
      retry: (issueNumber) => runExclusive(() => core.commands.retry(issueNumber)),
    });
    await listen(controlServer, config.httpPort);

    previewServer = createPreviewServer(
      () => ({
        activeSha: core.state.snapshot().deploy.activeSha,
        releaseDir: core.state.snapshot().deploy.releaseDir,
      }),
      createLogger('PREVIEW'),
      config.previewPort,
    );
    await listen(previewServer, config.previewPort);

    logger.info(`控制接口: http://127.0.0.1:${config.httpPort}`);
    logger.info(`预览服务: http://127.0.0.1:${config.previewPort}`);

    const shutdown = (signal: string): void => {
      if (stopped) return;
      stopped = true;
      logger.info(`收到 ${signal}，开始优雅退出`);
      void (async () => {
        // 1) 关闭入口，拒绝新任务。
        await closeServer(controlServer);
        await closeServer(previewServer);
        // 2) 停止飞书桥。
        if (bridge) {
          try {
            await bridge.stop();
          } catch {
            // 停止桥尽力而为。
          }
          bridge = null;
        }
        // 3) 等待当前 exclusive 任务结束（Pi 自身有总超时）。
        await runExclusive(async () => undefined);
        // 4) 释放实例锁后退出，避免留下无锁却挂起的进程。
        releaseLock();
        process.exit(0);
      })();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    while (!stopped) {
      try {
        const result = await runExclusive(() => runOnce(core));
        if (result.deploy.status !== 'nothing') {
          logger.info(`部署: ${result.deploy.status}${result.deploy.sha ? ` ${result.deploy.sha}` : ''}`);
        }
      } catch (error) {
        logger.error(`本轮执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopped) break;
      await sleep(config.pollIntervalMs);
    }
  } catch (error) {
    await fail(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (import.meta.main) void main();
