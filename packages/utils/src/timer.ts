/**
 * Reusable interval timer with start/stop lifecycle.
 *
 * Wraps setInterval with:
 * - Double-start guard
 * - .unref() so the timer doesn't prevent process exit
 * - Async callback support with error swallowing
 */

export class IntervalTimer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly callback: () => void | Promise<void>,
    private readonly intervalMs: number
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        const result = this.callback();
        if (result instanceof Promise) {
          result.catch(() => {
            /* swallow async errors */
          });
        }
      } catch {
        /* swallow synchronous errors */
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}
