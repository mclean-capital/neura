/**
 * Phase 6 — WorkerRuntime interface
 *
 * Abstraction boundary over the pi-coding-agent SDK. Phase 6's primary
 * implementation is `PiRuntime` (in-process pi AgentSession), with
 * `ClaudeCodeRuntime` (subprocess wrapper, validated by Spike #1) held in
 * reserve as a fallback if pi-runtime hits an unforeseen blocker.
 *
 * Keeping an explicit interface between the orchestrator (`agent-worker.ts`)
 * and the runtime lets us swap implementations without rewriting the
 * orchestrator, which is the same reason the original design kept it. Both
 * implementations obey the same lifecycle contract: `dispatch` starts a new
 * worker, `resume` reopens a paused worker from its on-disk session, `steer`
 * injects a mid-execution message, `abort` cancels cleanly via AbortSignal,
 * and `waitForIdle` lets the orchestrator synchronize on the pause-ack turn
 * without polling.
 *
 * No logic lives here — this file is contract-only. See `pi-runtime.ts` for
 * the actual implementation.
 */

import type { WorkerTask, WorkerCallbacks, WorkerResult } from '@neura/types';

/**
 * Handle returned when a worker is dispatched or resumed. Exposes the
 * identifiers the orchestrator needs to persist in the workers table and a
 * `done` promise the caller may optionally await for a terminal result.
 *
 * Fire-and-forget dispatches (via `run_skill`) ignore `done` — the
 * orchestrator surfaces completion through the callbacks instead. Tests and
 * integration flows await `done` directly.
 */
export interface WorkerHandle {
  /** Neura-assigned worker id (persisted to the workers table). */
  readonly workerId: string;

  /** Pi-assigned session id (stable across dispose/reopen, useful for logs). */
  readonly sessionId: string;

  /**
   * Absolute path to the pi JSONL session file on disk. Undefined only for
   * in-memory sessions (tests). The orchestrator writes this to
   * `workers.session_file` immediately after dispatch so restart-safe resume
   * works — see Spike #4e and the "Session persistence" section in the
   * design doc.
   */
  readonly sessionFile: string | undefined;

  /**
   * Resolves when the worker reaches a terminal status (completed, failed,
   * crashed, cancelled, or — after a pause steer — idle_partial). Tests
   * `await` this; fire-and-forget dispatchers ignore it.
   */
  readonly done: Promise<WorkerResult>;
}

/** Parameters for reopening a previously paused worker. */
export interface ResumeParams {
  /** Worker row id from the workers table. */
  workerId: string;

  /**
   * Absolute path to the pi JSONL session file previously written by
   * `dispatch`. Read from `workers.session_file`. Must exist on disk.
   */
  sessionFile: string;

  /**
   * The prompt Neura sends to the reopened session. Typically a phrase like
   * "OK, continue the task you were working on." For crash-recovery Neura
   * prepends context: "The task was interrupted by a system issue. ..."
   */
  resumePrompt: string;

  /** Callback fanout for status, progress, and completion events. */
  callbacks: WorkerCallbacks;
}

/**
 * Runtime that executes worker tasks via an underlying agent framework
 * (pi-coding-agent for Approach D, Claude Code CLI for Approach A fallback).
 *
 * Implementations are stateful: they own a map of active workers keyed by
 * `workerId`. Callers resolve worker references by id rather than by
 * handle, so the orchestrator can persist ids in PGlite without holding a
 * reference to the runtime's internal state.
 */
export interface WorkerRuntime {
  /**
   * Start a new worker for a fresh task. Returns as soon as the pi
   * AgentSession is constructed and the `session.prompt()` call has been
   * kicked off — does NOT wait for the task to complete. Progress and
   * completion flow through `callbacks`.
   *
   * The caller provides `workerId` so the runtime's internal active map
   * is keyed under the same id the caller will use for subsequent
   * `steer` / `abort` / `waitForIdle` / `hasWorker` lookups. Phase 6
   * uses the db-assigned id from `createWorker(db, task)` — the id the
   * orchestrator persists AND the id every downstream caller holds. If
   * the runtime minted its own id internally, every control-path lookup
   * by db id would miss (the B1 bug in the PR review).
   */
  dispatch(task: WorkerTask, callbacks: WorkerCallbacks, workerId: string): Promise<WorkerHandle>;

  /**
   * Reopen a previously paused worker from its persisted session file.
   * Implementation details for pi-runtime: `SessionManager.open(sessionFile)`
   * then `createAgentSession({ sessionManager, customTools: buildNeuraTools(ctx) })`
   * then `session.prompt(resumePrompt)` as a fresh turn (NOT a steer) — the
   * pattern verified by Spike #4e.
   */
  resume(params: ResumeParams): Promise<WorkerHandle>;

  /**
   * Send a steering message to an in-flight worker. Used by the pause
   * primitive: calls `session.prompt(message, { streamingBehavior: 'steer' })`
   * under the hood. The message is delivered at the next tool-call boundary
   * and the agent runs to `agent_end` — after which the worker transitions
   * to `idle_partial` (if the orchestrator flagged a pending pause) or
   * `completed`.
   */
  steer(workerId: string, message: string): Promise<void>;

  /**
   * Cancel a worker. Fires pi's `session.agent.abort()` which propagates
   * the AbortSignal into every in-flight tool `execute`. The agent emits
   * `agent_end` with `stopReason: "aborted"` and the orchestrator transitions
   * the worker to `cancelled` per the authoritative stopReason mapping.
   */
  abort(workerId: string): Promise<void>;

  /**
   * Wait for the worker's next `agent_end`. Used by the pause flow so the
   * orchestrator can synchronously confirm the pause landed before marking
   * the worker `idle_partial`. For workers already in a terminal state,
   * resolves immediately.
   */
  waitForIdle(workerId: string): Promise<void>;

  /**
   * Check whether a worker with the given id is currently tracked by the
   * runtime. Returns false for completed / disposed workers.
   */
  hasWorker(workerId: string): boolean;
}
