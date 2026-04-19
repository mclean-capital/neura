/**
 * Phase 6 — Worker lifecycle types
 *
 * Workers are in-process pi-coding-agent AgentSessions dispatched by Neura
 * core. Every worker row in the `workers` table corresponds to an AgentSession
 * that was started to execute a skill or author a new one. See
 * docs/phase6-os-core.md for the full state machine and the authoritative
 * `stopReason` → `WorkerStatus` mapping.
 */

/**
 * All possible worker statuses. The state machine is documented in the design
 * doc under "Worker crash recovery" — see the authoritative mapping table for
 * how pi's `stopReason` values project onto these.
 *
 * - `spawning`: worker row created, pi session not yet running
 * - `running`: pi session is actively processing a turn
 * - `blocked_clarifying`: pi session is blocked inside a `request_clarification`
 *   tool call, waiting for the user's next voice turn
 * - `idle_partial`: user-initiated pause completed. JSONL transcript is in a
 *   clean state (last entry is an assistant "paused" ack). Resumable via
 *   `SessionManager.open()` + a fresh prompt. This is the ONLY resumable
 *   post-crash state — verified by Spike #4e.
 * - `completed`: natural completion (`stopReason: "stop"` without a pending
 *   pause flag)
 * - `failed`: pi captured an error (`stopReason: "error"`, rejected prompt
 *   promise, or clarification-bridge error)
 * - `crashed`: set by the core-startup recovery sweep for rows that were
 *   `spawning` / `running` / `blocked_clarifying` when the core died. Terminal
 *   in Phase 6 — mid-run crash recovery is out of scope.
 * - `cancelled`: user-initiated abort (`stopReason: "aborted"`, or a
 *   cancelled clarification)
 */
export type WorkerStatus =
  | 'spawning'
  | 'running'
  | 'blocked_clarifying'
  | 'idle_partial'
  | 'completed'
  | 'failed'
  | 'crashed'
  | 'cancelled';

/**
 * What kind of task a worker is executing. Legacy enum from Phase 6.
 * Phase 6b moves worker dispatch to a task-ID-based model — see
 * docs/phase6b-task-driven-execution.md (Wave 3 will rewrite this type).
 * Retained as-is until Wave 3 so existing callers compile.
 */
export type WorkerTaskType =
  | 'execute_skill' // run an existing skill (legacy — unused post-Wave 1)
  | 'promote_clarification' // write a new skill from a clarification exchange
  | 'write_skill' // author a skill from a free-form user request (legacy)
  | 'ad_hoc'; // no skill, just a task description

/**
 * A task dispatched to a worker runtime. This is runtime-neutral — the
 * `WorkerRuntime` implementation (pi-runtime, claude-code-runtime fallback)
 * decides how to turn this into an actual execution.
 */
export interface WorkerTask {
  taskType: WorkerTaskType;

  /**
   * Skill to execute. Required for `execute_skill`. Optional for the
   * authoring task types (where the skill is being created, not run).
   */
  skillName?: string;

  /**
   * Free-form task description. For `execute_skill` this is the user's
   * natural-language request that triggered the skill; for authoring tasks
   * this is the spec/prompt for the new skill.
   */
  description: string;

  /**
   * Extra structured context captured from the triggering conversation.
   * Used by promotion tasks to carry the clarification exchange into the
   * authoring prompt.
   */
  context?: Record<string, unknown>;
}

/**
 * Final result of a worker run. Populated when the worker reaches a terminal
 * status (`completed` / `failed` / `crashed` / `cancelled`).
 */
export interface WorkerResult {
  status: WorkerStatus;
  /** Present on `completed` outcomes. Natural-language summary or structured payload. */
  output?: string;
  /** Present on `failed` / `crashed` outcomes. */
  error?: {
    reason: string;
    detail?: string;
  };
}

/**
 * Callbacks the runtime invokes as a worker progresses. Decoupled from the
 * underlying pi event stream so alternate runtimes (fallback Approach A)
 * can implement the same contract.
 */
export interface WorkerCallbacks {
  /** Fired when the worker status changes. */
  onStatusChange?: (status: WorkerStatus) => void;

  /**
   * Fired when the worker emits a progress update the orchestrator should
   * surface (via voice or logs). This is the feed that feeds
   * `VoiceFanoutBridge`.
   */
  onProgress?: (message: string) => void;

  /** Fired when the worker reaches a terminal status. */
  onComplete?: (result: WorkerResult) => void;
}
