import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AsyncTask<T> = () => Promise<T>;

export type Mutex = <T>(task: AsyncTask<T>) => Promise<T>;

/**
 * 进程内串行互斥：任务按提交顺序逐个执行，前一个完成（无论成败）后才运行下一个。
 * 单个任务抛错只影响调用方，不会阻塞后续任务。
 */
export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: AsyncTask<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export interface InstanceLock {
  acquired: boolean;
  reason?: string;
  release: () => void;
}

export type PidAliveFn = (pid: number) => boolean;

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * 单实例锁：以 pid 文件占位。若已有存活进程持有锁则拒绝；pid 失效视为陈旧锁并回收。
 * 创建使用 `wx` 原子排他，避免并发实例之间 `existsSync + writeFileSync` 竞态覆盖；
 * 无法创建锁文件时显式降级（不宣称已获取），不静默覆盖他人刚创建的锁。
 *
 * 陈旧回收用「独占 mkdir reaper guard」保护临界区：A/B 同时看到死 pid 时，先 mkdir
 * guard 的进程独占回收，另一方 EEXIST 后 fail closed，避免 A unlink 后 B 按旧判断再
 * unlink A 的新锁（双 acquire）。空/损坏锁（非正整数 pid）保守拒绝、不直接删除，避免
 * 他人刚 `wx` 创建但尚未写 pid 的瞬间被夺锁；恢复无法确定时 fail closed 并给出人工
 * 回收路径，不实现复杂锁框架。
 */
export function acquireInstanceLock(
  lockFile: string,
  isPidAlive: PidAliveFn = defaultIsPidAlive,
): InstanceLock {
  mkdirSync(dirname(lockFile), { recursive: true });
  const myPid = String(process.pid);

  const reject = (reason: string): InstanceLock => ({
    acquired: false,
    reason,
    release: () => {},
  });

  const acquiredLock: InstanceLock = {
    acquired: true,
    release: () => {
      try {
        if (existsSync(lockFile) && readFileSync(lockFile, 'utf8').trim() === myPid) {
          unlinkSync(lockFile);
        }
      } catch {
        // 释放尽力而为。
      }
    },
  };

  // 1) 原子创建；EEXIST 说明已存在，需判断存活/陈旧。
  try {
    writeFileSync(lockFile, myPid, { encoding: 'utf8', flag: 'wx' });
    return acquiredLock;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      return reject(`无法创建锁文件: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2) 锁已存在：先读 pid。
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf8').trim();
  } catch (readError) {
    return reject(`无法读取锁文件（可能正被并发回收）: ${readError instanceof Error ? readError.message : String(readError)}`);
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // 空/损坏锁：可能是他人刚 `wx` 创建但尚未写 pid，不能直接删除夺锁。
    return reject(`锁文件内容异常（空或非正整数 pid），无法安全回收。请人工检查后删除 ${lockFile} 再重试`);
  }

  if (isPidAlive(pid)) {
    return reject(`已有守护进程运行（pid ${pid}）`);
  }

  // 3) 陈旧回收：独占 reaper guard 保护临界区，进入后重新读 pid 并二次确认已死。
  const guardDir = `${lockFile}.reap`;
  try {
    mkdirSync(guardDir);
  } catch (guardError) {
    const code = (guardError as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return reject(`另一实例正在回收陈旧锁，请稍后重试；若长期卡住可人工删除 ${guardDir} 与 ${lockFile}`);
    }
    return reject(`无法创建锁回收守卫: ${guardError instanceof Error ? guardError.message : String(guardError)}`);
  }

  try {
    let currentRaw: string;
    try {
      currentRaw = readFileSync(lockFile, 'utf8').trim();
    } catch {
      return reject(`回收期间锁文件已消失或被并发改写，放弃回收以避免覆盖新锁`);
    }
    const currentPid = Number.parseInt(currentRaw, 10);
    if (currentRaw !== raw || currentPid !== pid) {
      return reject(`锁文件在回收期间已变化，放弃回收以避免覆盖新锁`);
    }
    if (isPidAlive(pid)) {
      return reject(`锁 pid ${pid} 在回收期间复活，拒绝回收`);
    }

    try {
      unlinkSync(lockFile);
    } catch (unlinkError) {
      const code = (unlinkError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return reject(`无法回收陈旧锁: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`);
      }
    }

    try {
      writeFileSync(lockFile, myPid, { encoding: 'utf8', flag: 'wx' });
    } catch (createError) {
      const code = (createError as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return reject('另一实例已获取锁');
      }
      return reject(`无法创建锁文件: ${createError instanceof Error ? createError.message : String(createError)}`);
    }
  } finally {
    try {
      rmdirSync(guardDir);
    } catch {
      // 守卫清理尽力而为；残留时后续回收会 fail closed 提示人工处理。
    }
  }

  return acquiredLock;
}
