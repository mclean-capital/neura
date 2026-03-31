import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger.js';

describe('Logger', () => {
  const originalEnv = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalEnv;
  });

  it('creates a logger with a namespace', () => {
    const log = new Logger('test');
    expect(log).toBeInstanceOf(Logger);
  });

  it('exposes all log level methods', () => {
    const log = new Logger('test');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('creates a child logger', () => {
    const log = new Logger('parent');
    const child = log.child('sub');
    expect(child).toBeInstanceOf(Logger);
  });

  it('does not throw when logging with data', () => {
    const log = new Logger('test');
    expect(() => log.info('hello', { key: 'value' })).not.toThrow();
    expect(() => log.error('fail', { code: 42 })).not.toThrow();
  });

  it('does not throw when logging without data', () => {
    const log = new Logger('test');
    expect(() => log.debug('trace')).not.toThrow();
    expect(() => log.warn('caution')).not.toThrow();
  });
});
