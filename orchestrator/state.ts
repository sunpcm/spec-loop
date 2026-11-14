import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState, type OrchestratorState, type SpecRequest } from './types.ts';

export class StateStore {
  private state: OrchestratorState;
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;
  private static corruptBackupSeq = 0;

  constructor(file: string, initialState?: OrchestratorState) {
    this.file = file;
    this.state = initialState ?? emptyState();
  }

  load(): OrchestratorState {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.snapshot();
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as OrchestratorState;
      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1) {
        parsed.specRequests ??= {};
        for (const req of Object.values(parsed.specRequests)) {
          normalizeSpecRequest(req);
        }
        this.state = parsed;
      } else {
        throw new Error('schemaVersion 不是 1');
      }
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}-${(StateStore.corruptBackupSeq += 1)}`;
      try {
        writeFileSync(backup, raw, 'utf8');
      } catch {
        // 备份失败时仍拒绝启动，避免覆盖原状态。
      }
      throw new Error(
        `状态文件损坏，已备份到 ${backup}，拒绝启动: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.snapshot();
  }

  snapshot(): OrchestratorState {
    return JSON.parse(JSON.stringify(this.state)) as OrchestratorState;
  }

  async update<T>(fn: (state: OrchestratorState) => T): Promise<{ state: OrchestratorState; result: T }> {
    const run = async (): Promise<{ state: OrchestratorState; result: T }> => {
      const working = JSON.parse(JSON.stringify(this.state)) as OrchestratorState;
      const result = fn(working);
      this.persist(working);
      this.state = working;
      return { state: this.snapshot(), result };
    };

    const resultPromise = this.queue.then(run, run);
    this.queue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  protected persist(state: OrchestratorState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}

function normalizeSpecRequest(req: SpecRequest): void {
  req.hasValidDoc ??= Boolean(req.docContent);
  req.labelsSynced ??= false;
  if (req.stage === 'commit') req.stage = 'write';
  if (req.stage === 'review') req.stage = 'pr-open';
}

export function backupState(stateFile: string): void {
  try {
    const raw = readFileSync(stateFile);
    writeFileSync(`${stateFile}.bak`, raw);
  } catch {
    // Nothing to back up.
  }
}
