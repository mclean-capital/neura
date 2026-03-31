import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

function createBaseLogger(): pino.Logger {
  // In dev, try pino-pretty for human-readable output; fall back to JSON if unavailable
  if (process.env.NODE_ENV !== 'production') {
    try {
      return pino({
        level,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      });
    } catch {
      // pino-pretty not available (e.g. bundled context) — fall through to JSON
    }
  }
  return pino({ level });
}

const baseLogger = createBaseLogger();

export class Logger {
  private log: pino.Logger;

  constructor(namespace: string) {
    this.log = baseLogger.child({ ns: namespace });
  }

  debug(msg: string, data?: Record<string, unknown>) {
    this.log.debug(data ?? {}, msg);
  }

  info(msg: string, data?: Record<string, unknown>) {
    this.log.info(data ?? {}, msg);
  }

  warn(msg: string, data?: Record<string, unknown>) {
    this.log.warn(data ?? {}, msg);
  }

  error(msg: string, data?: Record<string, unknown>) {
    this.log.error(data ?? {}, msg);
  }

  child(sub: string): Logger {
    const child = Object.create(Logger.prototype) as Logger;
    child.log = this.log.child({ sub });
    return child;
  }
}
