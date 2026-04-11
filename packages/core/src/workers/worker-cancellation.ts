/**
 * Phase 6 — Worker cancellation
 *
 * Triggers that should abort one or more workers:
 *
 *   1. User says "stop" / "cancel that" during voice session
 *   2. SIGINT / SIGTERM on core (graceful shutdown)
 *   3. Presence transition to idle (for short-lived workers only —
 *      long-running workers continue in the background)
 *
 * The cancellation path is the same for all three: fire
 * `session.agent.abort()` via `runtime.abort(workerId)`, let pi propagate
 * the AbortSignal into every in-flight tool execute, and let agent-worker
 * observe the resulting `stopReason: "aborted"` to mark the worker
 * `cancelled` in the workers table.
 *
 * This module is a thin coordinator — the real cancellation work happens
 * inside `PiRuntime.abort()` which talks to pi. We own the policy:
 *
 *   - Which workers get cancelled on SIGINT? (all active)
 *   - Which workers get cancelled on voice "stop"? (the active skill's
 *     worker, or all if ambiguous)
 *   - Short-lived vs long-running worker policy on presence idle
 *     (Phase 7 — for now, presence idle cancels nothing automatically)
 */

import { Logger } from '@neura/utils/logger';
import type { WorkerRuntime } from './worker-runtime.js';

const log = new Logger('worker-cancellation');

export interface WorkerCancellationOptions {
  runtime: WorkerRuntime;
  /**
   * Callback fired after each worker is aborted so agent-worker can
   * update its table row. Runs after the underlying `runtime.abort()`
   * resolves.
   */
  onWorkerAborted?: (workerId: string) => void | Promise<void>;
}

export class WorkerCancellation {
  private readonly runtime: WorkerRuntime;
  private readonly onWorkerAborted?: (workerId: string) => void | Promise<void>;
  private activeWorkerIds = new Set<string>();

  constructor(options: WorkerCancellationOptions) {
    this.runtime = options.runtime;
    this.onWorkerAborted = options.onWorkerAborted;
  }

  /**
   * Register a worker with the cancellation coordinator. agent-worker
   * calls this at dispatch time so SIGINT knows which workers to abort.
   * Unregistered via `unregister()` when the worker completes.
   */
  register(workerId: string): void {
    this.activeWorkerIds.add(workerId);
  }

  /** Remove a worker from the active set (on normal completion). */
  unregister(workerId: string): void {
    this.activeWorkerIds.delete(workerId);
  }

  /**
   * Abort a specific worker by id. No-op if the worker is unknown or
   * already terminal. Safe to call from the voice "stop" intent path.
   */
  async cancel(workerId: string): Promise<void> {
    log.info('cancelling worker', { workerId });
    try {
      await this.runtime.abort(workerId);
    } catch (err) {
      log.warn('runtime.abort threw', { workerId, err: String(err) });
    }
    this.activeWorkerIds.delete(workerId);
    if (this.onWorkerAborted) {
      try {
        await this.onWorkerAborted(workerId);
      } catch (err) {
        log.warn('onWorkerAborted callback threw', { workerId, err: String(err) });
      }
    }
  }

  /**
   * Abort all active workers. Used on SIGINT / SIGTERM / core shutdown.
   * Runs cancellations in parallel — pi's abort signal is synchronous
   * inside each session so there's no benefit to sequencing.
   */
  async cancelAll(): Promise<void> {
    const ids = [...this.activeWorkerIds];
    log.info('cancelling all workers', { count: ids.length });
    await Promise.all(ids.map((id) => this.cancel(id)));
  }

  /** Number of workers currently tracked as active. */
  get activeCount(): number {
    return this.activeWorkerIds.size;
  }
}
