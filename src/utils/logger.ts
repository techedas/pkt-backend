/* Minimal structured logger. Swap for pino/winston without touching call sites. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = process.env.NODE_ENV === 'test' ? 'warn' : process.env.NODE_ENV === 'production' ? 'info' : 'debug';

function log(level: Level, message: string, meta?: unknown) {
  if (order[level] < order[minLevel]) return;
  const line = { time: new Date().toISOString(), level, message, ...(meta !== undefined ? { meta } : {}) };
  const out = JSON.stringify(line, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export const logger = {
  debug: (m: string, meta?: unknown) => log('debug', m, meta),
  info: (m: string, meta?: unknown) => log('info', m, meta),
  warn: (m: string, meta?: unknown) => log('warn', m, meta),
  error: (m: string, meta?: unknown) => log('error', m, meta),
};
