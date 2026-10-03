import type { Logger } from './types.js';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

const COLOR: Record<string, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

/**
 * Small structured logger. No dependency, scoped prefixes, and it silences
 * cleanly — a library should not spray the host app's stdout.
 */
export function createLogger(level: LogLevel = 'info', scope = 'super'): Logger {
  const threshold = LEVELS[level];
  const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

  const make = (prefix: string): Logger => {
    const emit = (kind: 'error' | 'warn' | 'info' | 'debug', msg: string, meta?: Record<string, unknown>) => {
      if (LEVELS[kind] > threshold) return;
      const ts = new Date().toISOString().slice(11, 23);
      const tail = meta && Object.keys(meta).length ? ` ${dim(JSON.stringify(meta))}` : '';
      const tag = `${prefix}:`;
      const line = useColor
        ? `${dim(ts)} ${COLOR[kind]}${tag}${msg}${COLOR.reset}${tail}`
        : `${ts} ${tag} ${msg}${tail}`;
      (kind === 'error' ? console.error : console.log)(line);
    };

    const dim = (s: string): string => (useColor ? `${COLOR.dim}${s}${COLOR.reset}` : s);

    return {
      error: (m, x) => emit('error', m, x),
      warn: (m, x) => emit('warn', m, x),
      info: (m, x) => emit('info', m, x),
      debug: (m, x) => emit('debug', m, x),
      child: (child: string) => make(`${prefix}:${child}`),
    };
  };

  return make(scope);
}

/** A logger that does nothing. Default for libraries. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger,
};
