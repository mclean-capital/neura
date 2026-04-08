import { describe, it, expect, vi, afterEach } from 'vitest';
import { IntervalTimer } from './timer.js';

describe('IntervalTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() begins calling the callback', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const timer = new IntervalTimer(fn, 100);

    timer.start();
    vi.advanceTimersByTime(350);

    expect(fn).toHaveBeenCalledTimes(3);
    timer.stop();
  });

  it('stop() stops the callback', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const timer = new IntervalTimer(fn, 100);

    timer.start();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);

    timer.stop();
    vi.advanceTimersByTime(300);
    // Should not have been called again after stop
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('double start is guarded', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const timer = new IntervalTimer(fn, 100);

    timer.start();
    timer.start(); // second start should be a no-op

    vi.advanceTimersByTime(150);
    // Only one interval should be running, so only 1 call
    expect(fn).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('isRunning reflects state correctly', () => {
    const noop = vi.fn();
    const timer = new IntervalTimer(noop, 100);

    expect(timer.isRunning).toBe(false);
    timer.start();
    expect(timer.isRunning).toBe(true);
    timer.stop();
    expect(timer.isRunning).toBe(false);
  });

  it('callback errors are swallowed (sync)', () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => {
      throw new Error('boom');
    });
    const timer = new IntervalTimer(fn, 100);

    timer.start();
    // Should not throw
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('callback errors are swallowed (async)', () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => {
      return Promise.reject(new Error('async boom'));
    });
    const timer = new IntervalTimer(fn, 100);

    timer.start();
    // Should not throw — async rejection is caught internally
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    timer.stop();
  });
});
