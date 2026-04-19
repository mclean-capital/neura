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
import { WorktreeManager } from './worktree-manager.js';

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
  /** Retention window (hours) for failed/cancelled worktrees. Default 24. */
  worktreeRetentionHours?: number;
  /**
   * Optional pre-built WorktreeManager (for tests). When omitted, the
   * agent builds one from the path + retention options above.
   */
  worktreeManager?: WorktreeManager;
}

/**
 * Canonical Neura worker system-prompt preamble. Injected ahead of every
 * task-driven dispatch via {@link buildCanonicalWorkerPrompt}. Defines the
 * role, tool posture, the reversibility rule, the 6-verb protocol, and
 * heartbeat cadence — things every worker reads the same way regardless
 * of the specific task.
 *
 * Target length: ~500-700 words. Kept in code (not a skill) because
 * every worker in the system depends on it being present; treating it
 * as a skill would couple dispatch to skill loading and fail-open if
 * the skill file is missing.
 */
export const CANONICAL_WORKER_SYSTEM_PROMPT = `You are a Neura worker — a capable engineering agent executing a task dispatched by the Neura orchestrator. The orchestrator is a voice-first assistant that briefed this task with the user, confirmed intent, and handed it off to you.

Your posture: be decisive. You have full tool access — Read, Write, Edit, Bash — scoped to an isolated worktree directory (your cwd). Make progress. Don't ask the user to double-check obvious things. Don't propose a plan and wait for approval when the path is clear.

Reversibility rule: before any destructive or hard-to-reverse action **outside** your worktree, call \`request_approval\` and wait for the user's answer. Examples that require approval:
- Deleting files the user owns
- Force-pushing branches, rewriting git history
- Sending email, SMS, or other external messages
- Spending money (API calls with cost, cloud resources)
- Running \`rm\` outside your cwd

Actions inside your worktree (creating new files, editing files you created, running tests, installing deps) are reversible — just act.

Communication protocol — use these tools to report back, not prose:

- \`report_progress(message)\` — brief status updates. Surfaces to the user as ambient voice. Use sparingly: one update per meaningful step, not one per tool call.
- \`heartbeat(note?)\` — signal you're alive on long tasks. Emit at least every 2 minutes when you expect to run longer than that, or the orchestrator will treat you as crashed.
- \`request_clarification(question, context?, urgency?)\` — ask the user a blocking question. Returns their answer. Only escalate when you genuinely cannot resolve ambiguity from the task context. Try to answer from context first.
- \`request_approval(action, rationale?, urgency?)\` — mandatory before destructive actions (see reversibility rule above).
- \`complete_task(summary)\` — mark the task done. Include a short summary of what you did, keyed to the acceptance criteria. The invariant layer will reject this if any clarification or approval is still unresolved.
- \`fail_task(reason, reason_code)\` — mark the task failed. Use the right reason_code: \`impossible\` (missing precondition), \`already_done\` (no-op), \`user_aborted\` (user stopped you), \`hard_error\` (exception/timeout).

Escalation discipline: escalate sparingly. The orchestrator is mediating a voice conversation with a human — every clarification interrupts it. Only escalate when:
- You cannot determine which of several paths the user wants (and context doesn't make it obvious).
- You hit a blocker that requires user authorization (destructive action, external side effect).
- You genuinely lack required information (credentials, API endpoints, user preferences).

Don't escalate for things you can try yourself. Don't escalate to confirm a plan before acting when the plan is obvious.

Reference skills: if your task's \`reference_skills\` is populated, skill docs appear in your context. They are reference material, not capability gates — consult them for domain specifics (e.g. "how does our CMS auth work") but you aren't required to follow them verbatim. Skills are snapshotted at dispatch; edits mid-run won't reach you.

Complete what you were asked to complete. If the task is done, call \`complete_task\`. If you cannot finish, call \`fail_task\` with the best-fit reason_code — do not stall or exit silently.`;

/**
 * Build the canonical task-driven prompt. Prepends
 * {@link CANONICAL_WORKER_SYSTEM_PROMPT} to the task-specific context
 * block (goal, acceptance criteria, references, related skills) and the
 * update-task reminder.
 */
export function buildCanonicalWorkerPrompt(task: WorkItemEntry): string {
  const lines: string[] = [];
  lines.push(CANONICAL_WORKER_SYSTEM_PROMPT);
  lines.push('\n<task>');
  lines.push(`Title: ${task.title}`);
  lines.push(`Task ID: ${task.id}`);
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
  lines.push('</task>');
  lines.push(
    `\nWhen the task is complete, call \`complete_task\` with your summary. If you cannot finish, call \`fail_task\` with a reason_code.`
  );
  return lines.join('\n');
}

export class AgentWorker {
  private readonly db: PGlite;
  private readonly runtime: WorkerRuntime;
  private readonly cancellation: WorkerCancellation;
  private readonly worktrees: WorktreeManager;
  /** Tracks worktree paths per workerId so terminal handlers can clean up. */
  private readonly workerTaskIds = new Map<string, string>();

  constructor(options: AgentWorkerOptions) {
    this.db = options.db;
    this.runtime = options.runtime;
    this.worktrees =
      options.worktreeManager ??
      new WorktreeManager({
        basePath: options.worktreeBasePath,
        retentionHours: options.worktreeRetentionHours,
      });
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
   * workers are dispatched. Marks mid-execution orphans as crashed,
   * preserves idle_partial rows with a valid session_file, and sweeps
   * orphaned worktrees whose backing worker row is no longer live.
   */
  async recoverFromCrash(): Promise<void> {
    const summary = await sweepCrashedWorkers(this.db, (path) => existsSync(path));
    log.info('crash recovery sweep complete', { ...summary });

    // Worktree orphan sweep. Any non-terminal worker is considered live
    // for the purposes of retaining its worktree; everything else is a
    // cleanup candidate (subject to the retention window inside
    // WorktreeManager.sweepOrphans).
    const liveWorkers = await listWorkers(this.db, {
      status: ['spawning', 'running', 'blocked_clarifying', 'idle_partial'],
      limit: 1000,
    });
    const liveIds = new Set(liveWorkers.map((w) => w.workerId));
    const wtSummary = this.worktrees.sweepOrphans(liveIds);
    log.info('worktree orphan sweep complete', { ...wtSummary });
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
   * Wave 4 adds `git worktree add` for repo-scoped tasks, retention-aware
   * cleanup on failed / cancelled outcomes, and the orphan-sweep hook
   * (wired via `recoverFromCrash` below).
   */
  async dispatchForTask(taskId: string, callbacks: WorkerCallbacks = {}): Promise<WorkerHandle> {
    const task = await getWorkItem(this.db, taskId);
    if (!task) throw new Error(`dispatchForTask: unknown task ${taskId}`);

    // Guard against redispatch. Without these checks, tool retries or a
    // double-confirm in the voice loop would spin up a second worker and
    // silently overwrite the task's worker_id back to the new worker,
    // losing the link to the first one. `done` / `cancelled` / `failed`
    // are terminal; a task with a live `workerId` already has an active
    // worker that should finish or be cancelled first.
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
      throw new Error(
        `dispatchForTask: task ${taskId} is terminal (${task.status}); cannot redispatch`
      );
    }
    if (task.workerId) {
      const existing = await getWorker(this.db, task.workerId);
      const terminalWorker =
        existing == null ||
        existing.status === 'completed' ||
        existing.status === 'failed' ||
        existing.status === 'crashed' ||
        existing.status === 'cancelled';
      if (!terminalWorker) {
        throw new Error(
          `dispatchForTask: task ${taskId} already has live worker ${task.workerId} (${existing.status})`
        );
      }
      // Prior worker is terminal — the task row still points at it but
      // the orchestrator likely decided to redispatch. Fall through so a
      // fresh worker can pick up.
      log.info('redispatching task that previously had a terminal worker', {
        taskId,
        priorWorkerId: task.workerId,
      });
    }

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
    this.workerTaskIds.set(workerId, task.id);
    const wt = this.worktrees.create({
      workerId,
      repoPath: task.repoPath,
      baseBranch: task.baseBranch,
    });
    const worktreePath = wt.path;
    if (task.repoPath && !wt.gitBacked) {
      // The manager already logged the fallback; surface a task comment
      // via the regular persist path so the operator sees the downgrade
      // without digging through logs. Best-effort, no await.
      log.warn('worker fell back to scratch worktree despite repo_path', {
        workerId,
        taskId: task.id,
      });
    }

    // Link the task row BEFORE starting the runtime session. The worker
    // can begin calling tools the instant `runtime.dispatch` kicks off
    // its async `session.prompt()`; if the invariant layer reads
    // `work_items.worker_id` and sees `null`, the cross-task-write guard
    // rejects any update_task call the worker makes on its own ticket.
    // Writing the linkage first closes that race — the row is ready for
    // the worker's first tool call.
    try {
      await updateWorkItem(this.db, task.id, {
        status: 'in_progress',
        workerId,
      });
    } catch (err) {
      // If we can't link the task (e.g. it's already terminal), bail out
      // before dispatching the runtime — a worker with no writable ticket
      // is worse than no worker.
      log.error('failed to link worker to task; aborting dispatch', {
        workerId,
        taskId: task.id,
        err: String(err),
      });
      this.worktrees.cleanup(workerId);
      this.workerTaskIds.delete(workerId);
      await updateWorker(this.db, workerId, {
        status: 'failed',
        error: { reason: 'task_link_failed', detail: String(err) },
      }).catch((persistErr: unknown) => {
        log.warn('failed to mark worker as failed after task-link error', {
          workerId,
          err: String(persistErr),
        });
      });
      throw err;
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

    // Mirror worker-terminal status back onto the linked task. Without
    // this, `cancelled` / `failed` / `crashed` worker outcomes leave the
    // task row stuck in `in_progress` — `get_system_state` keeps
    // surfacing it as active and a redispatch is blocked. The happy
    // path (`completed`) is NOT mirrored: the worker's own
    // `complete_task` call is the authoritative transition to `done`
    // and it happens before this callback fires. Mapping `completed`
    // here would overwrite the worker's richer result comment.
    const taskId = this.workerTaskIds.get(workerId);
    if (taskId) {
      const taskStatus =
        status === 'cancelled'
          ? 'cancelled'
          : status === 'failed' || status === 'crashed'
            ? 'failed'
            : null;
      if (taskStatus) {
        try {
          const task = await getWorkItem(this.db, taskId);
          // Only mirror if the task is still non-terminal — the worker
          // may have already called fail_task / complete_task and
          // transitioned the task itself.
          if (
            task &&
            task.status !== 'done' &&
            task.status !== 'cancelled' &&
            task.status !== 'failed'
          ) {
            await updateWorkItem(this.db, taskId, { status: taskStatus });
          }
        } catch (err) {
          log.warn('failed to mirror terminal status to task', {
            workerId,
            taskId,
            taskStatus,
            err: String(err),
          });
        }
      }
    }

    // Worktree cleanup policy:
    //  - `completed` / `cancelled`: clean up immediately
    //  - `failed` / `crashed`: keep for the retention window so the operator
    //    can inspect the state, then schedule a sweep
    //  - `idle_partial`: leave alone (resumable)
    try {
      if (status === 'completed' || status === 'cancelled') {
        this.worktrees.cleanup(workerId);
        this.workerTaskIds.delete(workerId);
      } else if (status === 'failed' || status === 'crashed') {
        this.worktrees.scheduleCleanup(workerId);
      }
    } catch (err) {
      log.warn('worktree cleanup failed', { workerId, status, err: String(err) });
    }
  }
}
