import { isatty } from 'node:tty';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

const COLORS: Record<string, string> = {
  INIT: '\u001b[36m',
  RECOVERY: '\u001b[35m',
  RECONCILER: '\u001b[34m',
  WORKER: '\u001b[32m',
  DEPLOY: '\u001b[33m',
  'ERROR-CATCH': '\u001b[31m',
  TRIAGE: '\u001b[91m',
  FEISHU: '\u001b[95m',
};

const RESET = '\u001b[0m';

function useColor(stage: string): boolean {
  if (process.env.NO_COLOR) return false;
  if (!isatty(process.stdout.fd)) return false;
  return stage in COLORS;
}

export function createLogger(stage: string): Logger {
  const emit = (level: LogLevel, message: string): void => {
    const line = `[${stage}] ${message}`;
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
    } else if (level === 'warn') {
      process.stderr.write(`${line}\n`);
    } else if (level === 'debug' && !process.env.SPEC_LOOP_DEBUG) {
      return;
    } else {
      const colored = useColor(stage) ? `${COLORS[stage]}${line}${RESET}` : line;
      process.stdout.write(`${colored}\n`);
    }
  };
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    debug: (m) => emit('debug', m),
  };
}

export function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi, '$1[REDACTED]');
}
