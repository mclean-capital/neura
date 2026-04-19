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

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Logger } from '@neura/utils/logger';
import type {
  WorkItemEntry,
  WorkerCallbacks,
  WorkerResult,
  WorkerStatus,
  WorkerTask,
} from '@neura/types';
import {
  createWorker,
  getWorker,
  listWorkers,
  sweepCrashedWorkers,
  updateWorker,
  type WorkerEntry,
} from '../stores/worker-queries.js';
import { getWorkItem, updateWorkItem } from '../stores/work-item-queries.js';
import type { WorkerHandle, WorkerRuntime } from './worker-runtime.js';
import { WorkerCancellation } from './worker-cancellation.js';

const log = new Logger('agent-worker');

export interface AgentWorkerOptions {
  db: PGlite;
  runtime: WorkerRuntime;
  /**
   * Base directory for per-worker worktrees. Defaults to `~/.neura/worktrees`.
   * Each worker gets an isolated subdirectory `<base>/<workerId>/` that
   * becomes the pi session `cwd`. See plan §Git Worktree Isolation.
   */
  worktreeBasePath?: string;
}

/** Build the canonical task-driven prompt from a work_items row. */
export function buildCanonicalWorkerPrompt(task: WorkItemEntry): string {
  const lines: string[] = [];
  lines.push(`Your task: ${task.title}`);
  if (task.goal) lines.push(`\nGoal (what success looks like): ${task.goal}`);
  if (task.description) lines.push(`\nDescription:\n${task.description}`);
  const ctx = task.context;
  if (ctx) {
    if (Array.isArray(ctx.acceptanceCriteria) && ctx.acceptanceCriteria.length > 0) {
      lines.push('\nAcceptance criteria:');
      for (const c of ctx.acceptanceCriteria) lines.push(`- ${c}`);
    }
    if (Array.isArray(ctx.constraints) && ctx.constraints.length > 0) {
      lines.push('\nConstraints:');
      for (const c of ctx.constraints) lines.push(`- ${c}`);
    }
    if (Array.isArray(ctx.references) && ctx.references.length > 0) {
      lines.push('\nReferences:');
      for (const c of ctx.references) lines.push(`- ${c}`);
    }
  }
  if (task.relatedSkills.length > 0) {
    lines.push(
      `\nReference skills available: ${task.relatedSkills.join(', ')}. Consult them for domain specifics if relevant.`
    );
  }
  lines.push(
    `\nReport progress, ask for clarification, or request approval via update_task on task id ${task.id}. Complete with status: done when finished.`
  );
  return lines.join('\n');
}

export class AgentWorker {
  private readonly db: PGlite;
  private readonly runtime: WorkerRuntime;
  private readonly cancellation: WorkerCancellation;
  private readonly worktreeBasePath: string;

  constructor(options: AgentWorkerOptions) {
    this.db = options.db;
    this.runtime = options.runtime;
    this.worktreeBasePath = options.worktreeBasePath ?? join(homedir(), '.neura', 'worktrees');
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

    // Call the runtime, passing the db-assigned workerId so the
    // runtime keys its internal active map under the SAME id the
    // orchestrator persisted. Without this, every later
    // steer/cancel/waitForIdle lookup by db id misses the runtime's
    // active map and pause/cancel/voice-stop silently break (B1).
    const handle = await this.runtime.dispatch(task, wrapped, workerId);

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

    return handle;
  }

  /**
   * Phase 6b — task-driven dispatch.
   *
   * Loads the work_items row, creates an isolated worktree directory at
   * `<worktreeBasePath>/<workerId>/`, builds the canonical worker prompt
   * from task goal/context/related_skills, writes `worker_id` + `status =
   * in_progress` back onto the task, and kicks off a pi AgentSession with
   * `cwd` set to the worktree.
   *
   * Worktree is scratch-only in Pass 2. Wave 4 adds `git worktree add` for
   * repo-scoped tasks, LFS hydration, disk-cap enforcement, and the
   * terminal-status cleanup sweep.
   */
  async dispatchForTask(taskId: string, callbacks: WorkerCallbacks = {}): Promise<WorkerHandle> {
    const task = await getWorkItem(this.db, taskId);
    if (!task) throw new Error(`dispatchForTask: unknown task ${taskId}`);

    // Build a minimal WorkerTask. `taskType` stays `ad_hoc` now that
    // `execute_skill` is retired from the dispatch flow — tracking taskId
    // on the shape is the actual linkage back to the work_items row.
    const prompt = buildCanonicalWorkerPrompt(task);
    const workerTask: WorkerTask = {
      taskType: 'ad_hoc',
      description: prompt,
      taskId: task.id,
    };

    // Create the worker row FIRST so we know the workerId — then carve a
    // worktree under `<base>/<workerId>/`. Passing the pre-minted
    // workerId to `runtime.dispatch` keeps the active-map key and the
    // db-row id in lockstep (B1 fix from Phase 6).
    const workerId = await createWorker(this.db, workerTask);
    const worktreePath = join(this.worktreeBasePath, workerId);
    try {
      mkdirSync(worktreePath, { recursive: true });
    } catch (err) {
      log.warn('failed to create worktree dir; continuing with runtime default cwd', {
        workerId,
        worktreePath,
        err: String(err),
      });
    }
    if (task.repoPath) {
      // Wave 4: `git worktree add <worktreePath> <base-branch>` goes here.
      // For now, we log that git isolation isn't active yet — the worker
      // gets a plain scratch dir, not a working-tree view of the repo.
      log.info('repo_path set but git worktree not yet integrated (Wave 4)', {
        workerId,
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
      });
    }

    // Wrap callbacks so status + results mirror into the workers table.
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

    // Runtime dispatch — per-task cwd so pi's filesystem view is scoped
    // to the worktree. Passing the pre-minted workerId keeps the active
    // map keyed by the db id (B1).
    const handle = await this.runtime.dispatch(
      { ...workerTask, cwd: worktreePath },
      wrapped,
      workerId
    );

    // Persist session metadata so crash-recovery can reopen.
    try {
      await updateWorker(this.db, workerId, {
        status: 'running',
        sessionId: handle.sessionId,
        sessionFile: handle.sessionFile ?? undefined,
      });
    } catch (err) {
      log.warn('failed to persist session metadata', { workerId, err: String(err) });
    }

    // Write the worker_id + status back onto the task row — the invariant
    // layer uses this to authorize the worker's future update_task calls.
    // This runs as `system` conceptually; we go through the raw query layer
    // to bypass the transition matrix (orchestrator → in_progress is
    // already allowed, but writing `worker_id` is not expressible via the
    // normal `update_task` payload cleanly).
    try {
      await updateWorkItem(this.db, task.id, {
        status: 'in_progress',
        workerId,
      });
    } catch (err) {
      // Best-effort: if the task row can't accept the update (e.g. already
      // terminal), the worker is still running but unable to post updates.
      // The next status change will be visible via worker-queries so this
      // doesn't block dispatch — but surface the warning so operators
      // notice the race.
      log.warn('failed to link worker to task', {
        workerId,
        taskId: task.id,
        err: String(err),
      });
    }

    this.cancellation.register(workerId);
    void handle.done.then(() => {
      this.cancellation.unregister(workerId);
    });

    return handle;
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
   * Mirror a runtime-driven status transition into the workers table.
   * Used by the clarification bridge onBlock/onUnblock wiring (C2) to
   * flip a worker to `blocked_clarifying` while it waits on a user
   * answer and back to `running` when the answer arrives. Keeping this
   * as a first-class method lets callers compose with AgentWorker
   * instead of reaching into PGlite directly.
   */
  async setStatus(workerId: string, status: WorkerStatus): Promise<void> {
    await updateWorker(this.db, workerId, { status });
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

  /**
   * Convenience: return the single most recently paused (`idle_partial`)
   * worker, or null if none are paused. Used by `resume_worker` so an
   * implicit target resolution doesn't land on a still-running worker.
   * Without this filter, `resume_worker` without an explicit id targets
   * the most-recent non-terminal worker which may be running — the
   * subsequent `runtime.resume()` would try to reopen a live session
   * or fail with "no session_file" (C1 in the PR review).
   */
  async getMostRecentPausedWorker(): Promise<WorkerEntry | null> {
    const list = await listWorkers(this.db, {
      status: ['idle_partial'],
      limit: 1,
    });
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
