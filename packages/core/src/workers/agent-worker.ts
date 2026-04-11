/**
 * Phase 6 — AgentWorker orchestrator
 *
 * The high-level API the rest of the core uses for worker lifecycle.
 * Sits between `PiRuntime` (the pi-backed execution) and the server +
 * tool router (which dispatches new workers, surfaces progress, and
 * handles user cancellation intents).
 *
 * Responsibilities:
 *
 *   1. Wrap `PiRuntime.dispatch` / `resume` with the persistent workers
 *      table writes. The runtime is store-agnostic by design; this file
 *      is where runtime events become database transitions.
 *
 *   2. Register workers with `WorkerCancellation` so SIGINT + voice
 *      "stop" intents know which ids to abort.
 *
 *   3. Run the recovery sweep at startup. Calls
 *      `sweepCrashedWorkers()` to mark mid-run orphans as crashed
 *      and preserve resumable idle_partial rows.
 *
 *   4. Expose the crash-detection pattern pi actually uses: pi catches
 *      errors internally and encodes them as `stopReason: "error"` on
 *      the final assistant message, which finalizeWorker picks up via
 *      the stopReason → WorkerStatus mapping. No subprocess liveness,
 *      no SIGCHLD handlers — just observing the event stream.
 */

import { existsSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { Logger } from '@neura/utils/logger';
import type { WorkerCallbacks, WorkerResult, WorkerStatus, WorkerTask } from '@neura/types';
import {
  createWorker,
  getWorker,
  listWorkers,
  sweepCrashedWorkers,
  updateWorker,
  type WorkerEntry,
} from '../stores/worker-queries.js';
import type { WorkerHandle, WorkerRuntime } from './worker-runtime.js';
import { WorkerCancellation } from './worker-cancellation.js';

const log = new Logger('agent-worker');

export interface AgentWorkerOptions {
  db: PGlite;
  runtime: WorkerRuntime;
}

export class AgentWorker {
  private readonly db: PGlite;
  private readonly runtime: WorkerRuntime;
  private readonly cancellation: WorkerCancellation;

  constructor(options: AgentWorkerOptions) {
    this.db = options.db;
    this.runtime = options.runtime;
    this.cancellation = new WorkerCancellation({
      runtime: options.runtime,
      onWorkerAborted: async (workerId) => {
        // The runtime's finalizeWorker will fire on agent_end with
        // stopReason "aborted" and transition the in-memory state;
        // mirror that into the workers table here so the row is
        // terminal even if agent-worker's own transition wiring
        // misses the event (defensive).
        try {
          await updateWorker(this.db, workerId, { status: 'cancelled' });
        } catch (err) {
          log.warn('failed to persist cancelled status', {
            workerId,
            err: String(err),
          });
        }
      },
    });
  }

  /**
   * Run the startup recovery sweep. Must be called before any new
   * workers are dispatched. Marks mid-execution orphans as crashed and
   * preserves idle_partial rows with a valid session_file.
   */
  async recoverFromCrash(): Promise<void> {
    const summary = await sweepCrashedWorkers(this.db, (path) => existsSync(path));
    log.info('crash recovery sweep complete', { ...summary });
  }

  /**
   * Dispatch a new worker task. Persists a row in `spawning`, hands off
   * to the runtime, then writes the runtime-assigned session_id /
   * session_file back to the row. The caller decides whether to await
   * the returned handle's `done` promise or fire-and-forget.
   */
  async dispatch(task: WorkerTask, callbacks: WorkerCallbacks = {}): Promise<WorkerHandle> {
    const workerId = await createWorker(this.db, task);
    log.info('dispatching worker', { workerId, taskType: task.taskType });

    // Wrap the caller's callbacks so status transitions also mirror
    // into the workers table. This is the single source of truth for
    // "what the row looks like at any moment": runtime fires a callback,
    // we persist, caller observes.
    //
    // WorkerCallbacks is typed as fire-and-forget (void return), so we
    // use sync wrappers that fire off the persistence work with `void`
    // and catch any rejection so it doesn't become an unhandled promise.
    const wrapped: WorkerCallbacks = {
      onStatusChange: (status) => {
        void updateWorker(this.db, workerId, { status }).catch((err: unknown) => {
          log.warn('failed to persist status', { workerId, status, err: String(err) });
        });
        callbacks.onStatusChange?.(status);
      },
      onProgress: (message) => {
        // last_progress_at is implicitly bumped by every updateWorker
        // with a status change, but pure progress messages don't
        // transition status. We could add a dedicated touch helper —
        // for Phase 2 we just forward to the caller.
        callbacks.onProgress?.(message);
      },
      onComplete: (result) => {
        void this.persistTerminalResult(workerId, result).catch((err: unknown) => {
          log.warn('failed to persist terminal result', {
            workerId,
            err: String(err),
          });
        });
        callbacks.onComplete?.(result);
      },
    };

    // Call the runtime. The handle is returned BEFORE the underlying
    // session.prompt resolves; dispatch is async-kickoff, not
    // async-await.
    const handle = await this.runtime.dispatch(task, wrapped);

    // Immediately persist session_id + session_file so restart-safe
    // resume has the load-bearing path recorded even if the core dies
    // mid-turn.
    try {
      await updateWorker(this.db, workerId, {
        status: 'running',
        sessionId: handle.sessionId,
        sessionFile: handle.sessionFile ?? undefined,
      });
    } catch (err) {
      log.warn('failed to persist session metadata', { workerId, err: String(err) });
    }

    this.cancellation.register(workerId);

    // Schedule cleanup when the handle settles. NOT awaited — callers
    // that want to await the result do so via handle.done directly.
    void handle.done.then(() => {
      this.cancellation.unregister(workerId);
    });

    // Return the handle using the db-assigned workerId so the caller's
    // persisted id and the runtime's id match. The runtime's internal
    // uuid is discarded — we use the db id as the external contract.
    return {
      workerId,
      sessionId: handle.sessionId,
      sessionFile: handle.sessionFile,
      done: handle.done,
    };
  }

  /**
   * Resume a paused worker. Reads session_file from the workers table,
   * calls `runtime.resume()`, and updates the row.
   */
  async resume(
    workerId: string,
    resumePrompt: string,
    callbacks: WorkerCallbacks = {}
  ): Promise<WorkerHandle> {
    const row = await getWorker(this.db, workerId);
    if (!row) throw new Error(`resume: unknown worker ${workerId}`);
    if (!row.sessionFile) {
      throw new Error(`resume: worker ${workerId} has no session_file`);
    }

    const wrapped: WorkerCallbacks = {
      onStatusChange: (status) => {
        void updateWorker(this.db, workerId, { status }).catch((err: unknown) => {
          log.warn('failed to persist status', { workerId, status, err: String(err) });
        });
        callbacks.onStatusChange?.(status);
      },
      onProgress: callbacks.onProgress,
      onComplete: (result) => {
        void this.persistTerminalResult(workerId, result).catch((err: unknown) => {
          log.warn('failed to persist terminal result', {
            workerId,
            err: String(err),
          });
        });
        callbacks.onComplete?.(result);
      },
    };

    log.info('resuming worker', { workerId, sessionFile: row.sessionFile });
    const handle = await this.runtime.resume({
      workerId,
      sessionFile: row.sessionFile,
      resumePrompt,
      callbacks: wrapped,
    });

    await updateWorker(this.db, workerId, { status: 'running' });
    this.cancellation.register(workerId);
    void handle.done.then(() => {
      this.cancellation.unregister(workerId);
    });
    return handle;
  }

  /**
   * Send a steering message to an in-flight worker. Used by the pause
   * primitive — caller should have the orchestrator layer interpret the
   * user's voice intent and route through here.
   */
  async steer(workerId: string, message: string): Promise<void> {
    await this.runtime.steer(workerId, message);
  }

  /**
   * Wait for a worker to reach the next idle state. Used by the pause
   * flow: orchestrator calls `steer()` then `waitForIdle()` so the
   * status transition to idle_partial only fires after pi actually
   * emits agent_end.
   */
  async waitForIdle(workerId: string): Promise<void> {
    await this.runtime.waitForIdle(workerId);
  }

  /**
   * Cancel a worker by id. Idempotent.
   */
  async cancel(workerId: string): Promise<void> {
    await this.cancellation.cancel(workerId);
  }

  /**
   * Cancel every tracked worker. Used on SIGINT / SIGTERM / shutdown.
   */
  async cancelAll(): Promise<void> {
    await this.cancellation.cancelAll();
  }

  /** Read the current workers table row for a given id. */
  async getWorker(workerId: string): Promise<WorkerEntry | null> {
    return getWorker(this.db, workerId);
  }

  /**
   * Return every non-terminal worker, sorted most-recently-active
   * first. Used by the voice-intent router to find the target worker
   * for pause / resume / cancel commands when the user says something
   * like "stop that" without naming a specific worker.
   */
  async listActiveWorkers(): Promise<WorkerEntry[]> {
    return listWorkers(this.db, {
      status: ['spawning', 'running', 'blocked_clarifying', 'idle_partial'],
      limit: 50,
    });
  }

  /**
   * Convenience: return the single most recently active worker, or
   * null if none are running. Used by voice intent detection to pick
   * a default target.
   */
  async getMostRecentActiveWorker(): Promise<WorkerEntry | null> {
    const list = await this.listActiveWorkers();
    return list[0] ?? null;
  }

  /** Number of workers currently registered with the cancellation coordinator. */
  get activeCount(): number {
    return this.cancellation.activeCount;
  }

  /**
   * Persist a terminal result to the workers table. Called by the
   * callbacks wrapper on `onComplete`. Maps the WorkerResult into the
   * row fields (status, result_json, error_json).
   */
  private async persistTerminalResult(workerId: string, result: WorkerResult): Promise<void> {
    const status: WorkerStatus = result.status;
    try {
      if (result.error) {
        await updateWorker(this.db, workerId, {
          status,
          error: result.error,
        });
      } else {
        await updateWorker(this.db, workerId, {
          status,
          result,
        });
      }
    } catch (err) {
      log.error('failed to persist terminal result', { workerId, err: String(err) });
    }
  }
}
