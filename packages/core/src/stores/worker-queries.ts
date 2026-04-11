/**
 * Phase 6 — Worker table queries
 *
 * PGlite CRUD surface for the `workers` table. The schema is declared in
 * `migrations.ts`. This file owns the lifecycle state transitions:
 *
 *   spawn → spawning
 *   start → running
 *   pause → idle_partial (after the pause steer lands)
 *   request_clarification → blocked_clarifying
 *   resume → running
 *   natural stop → completed
 *   error → failed
 *   abort → cancelled
 *   core restart sweep → crashed (for anything mid-execution)
 *
 * The recovery sweep is the load-bearing piece for restart-safe resume.
 * On Neura core startup, `sweepCrashedWorkers()` marks every
 * spawning / running / blocked_clarifying row as `crashed` (terminal),
 * and leaves `idle_partial` rows alone — those are the only rows the
 * orchestrator can reopen via SessionManager.open() per Spike #4e.
 */

import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type { WorkerStatus, WorkerTask, WorkerResult } from '@neura/types';
import { Logger } from '@neura/utils/logger';

const log = new Logger('worker-queries');

/** Shape returned by the `workers` SELECT queries. */
interface WorkerRow {
  worker_id: string;
  task_type: string;
  task_spec: WorkerTask;
  status: WorkerStatus;
  started_at: string;
  last_progress_at: string;
  result_json: WorkerResult | null;
  error_json: { reason: string; detail?: string } | null;
  session_id: string | null;
  session_file: string | null;
}

/** Projection exposed to the rest of the core (camel-case, typed status). */
export interface WorkerEntry {
  workerId: string;
  taskType: string;
  taskSpec: WorkerTask;
  status: WorkerStatus;
  startedAt: string;
  lastProgressAt: string;
  result: WorkerResult | null;
  error: { reason: string; detail?: string } | null;
  sessionId: string | null;
  sessionFile: string | null;
}

function mapRow(row: WorkerRow): WorkerEntry {
  return {
    workerId: row.worker_id,
    taskType: row.task_type,
    taskSpec: row.task_spec,
    status: row.status,
    startedAt: row.started_at,
    lastProgressAt: row.last_progress_at,
    result: row.result_json,
    error: row.error_json,
    sessionId: row.session_id,
    sessionFile: row.session_file,
  };
}

/**
 * Insert a new worker row in the `spawning` state. Caller provides the
 * task spec; the runtime immediately transitions to `running` once the pi
 * AgentSession is constructed and the first `session.prompt()` fires.
 *
 * Returns the generated worker id.
 */
export async function createWorker(db: PGlite, task: WorkerTask): Promise<string> {
  const workerId = crypto.randomUUID();
  await db.query(
    `INSERT INTO workers (worker_id, task_type, task_spec, status)
     VALUES ($1, $2, $3, 'spawning')`,
    [workerId, task.taskType, JSON.stringify(task)]
  );
  return workerId;
}

/**
 * Fields the runtime may update on an existing worker row. `status`
 * updates also bump `last_progress_at` so the progress-stall watchdog
 * has fresh data.
 */
export interface WorkerUpdate {
  status?: WorkerStatus;
  sessionId?: string;
  sessionFile?: string;
  result?: WorkerResult;
  error?: { reason: string; detail?: string };
}

/**
 * Update a worker row. Every field is optional — only the supplied ones
 * are written. Any `status` update also refreshes `last_progress_at`.
 */
export async function updateWorker(
  db: PGlite,
  workerId: string,
  update: WorkerUpdate
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (update.status !== undefined) {
    sets.push(`status = $${paramIdx++}`);
    values.push(update.status);
    sets.push('last_progress_at = NOW()');
  }
  if (update.sessionId !== undefined) {
    sets.push(`session_id = $${paramIdx++}`);
    values.push(update.sessionId);
  }
  if (update.sessionFile !== undefined) {
    sets.push(`session_file = $${paramIdx++}`);
    values.push(update.sessionFile);
  }
  if (update.result !== undefined) {
    sets.push(`result_json = $${paramIdx++}`);
    values.push(JSON.stringify(update.result));
  }
  if (update.error !== undefined) {
    sets.push(`error_json = $${paramIdx++}`);
    values.push(JSON.stringify(update.error));
  }

  if (sets.length === 0) return;

  values.push(workerId);
  await db.query(`UPDATE workers SET ${sets.join(', ')} WHERE worker_id = $${paramIdx}`, values);
}

/** Read a single worker by id, or null if it doesn't exist. */
export async function getWorker(db: PGlite, workerId: string): Promise<WorkerEntry | null> {
  const result = await db.query<WorkerRow>('SELECT * FROM workers WHERE worker_id = $1', [
    workerId,
  ]);
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

/**
 * List workers optionally filtered by status. Ordered by most recently
 * active first so the orchestrator can surface "resumable sessions" in
 * an obvious order.
 */
export async function listWorkers(
  db: PGlite,
  options?: { status?: WorkerStatus | readonly WorkerStatus[]; limit?: number }
): Promise<WorkerEntry[]> {
  const limit = options?.limit ?? 100;

  if (!options?.status) {
    const result = await db.query<WorkerRow>(
      'SELECT * FROM workers ORDER BY last_progress_at DESC LIMIT $1',
      [limit]
    );
    return result.rows.map(mapRow);
  }

  // Normalize status filter to an array so both single-value and
  // multi-value filters share the same parameter handling.
  const statusArr = Array.isArray(options.status) ? options.status : [options.status];
  const placeholders = statusArr.map((_, i) => `$${i + 1}`).join(', ');
  const result = await db.query<WorkerRow>(
    `SELECT * FROM workers WHERE status IN (${placeholders})
     ORDER BY last_progress_at DESC LIMIT $${statusArr.length + 1}`,
    [...statusArr, limit]
  );
  return result.rows.map(mapRow);
}

/**
 * Mid-execution crash recovery sweep. Run once at core startup, before
 * any worker code touches the table.
 *
 * For each row in `spawning`, `running`, or `blocked_clarifying`:
 *   - Mark the row terminal-`crashed` with reason `core_restarted`. Mid-run
 *     crash recovery is out of scope for Phase 6 — the JSONL may have a
 *     partial tool result or incomplete assistant message that pi cannot
 *     resume from.
 *
 * For each row in `idle_partial`:
 *   - If `session_file` is null or the file does not exist on disk, mark
 *     the row `crashed` with reason `session_file_missing`.
 *   - Otherwise leave the row alone — it's resumable via
 *     SessionManager.open() + a fresh prompt.
 *
 * Returns a summary of what the sweep did for logging.
 */
export interface RecoverySweepResult {
  markedCrashedMidRun: number;
  markedCrashedMissingFile: number;
  resumable: number;
}

export async function sweepCrashedWorkers(
  db: PGlite,
  fileExists: (path: string) => boolean
): Promise<RecoverySweepResult> {
  // Mid-run: terminal crashed for spawning/running/blocked_clarifying.
  const midRunResult = await db.query<{ worker_id: string }>(
    `UPDATE workers
     SET status = 'crashed',
         error_json = $1::jsonb,
         last_progress_at = NOW()
     WHERE status IN ('spawning', 'running', 'blocked_clarifying')
     RETURNING worker_id`,
    [JSON.stringify({ reason: 'core_restarted' })]
  );
  const midRunCount = midRunResult.rows.length;

  // Idle partial: check each session_file for existence on disk.
  const idleRows = await db.query<WorkerRow>(`SELECT * FROM workers WHERE status = 'idle_partial'`);

  let missingFileCount = 0;
  let resumable = 0;
  for (const row of idleRows.rows) {
    if (!row.session_file || !fileExists(row.session_file)) {
      await db.query(
        `UPDATE workers
         SET status = 'crashed',
             error_json = $1::jsonb,
             last_progress_at = NOW()
         WHERE worker_id = $2`,
        [JSON.stringify({ reason: 'session_file_missing' }), row.worker_id]
      );
      missingFileCount++;
    } else {
      resumable++;
    }
  }

  const summary: RecoverySweepResult = {
    markedCrashedMidRun: midRunCount,
    markedCrashedMissingFile: missingFileCount,
    resumable,
  };
  log.info('recovery sweep complete', { ...summary });
  return summary;
}

/** Hard-delete a worker row. Used by tests and by cleanup jobs. */
export async function deleteWorker(db: PGlite, workerId: string): Promise<void> {
  await db.query('DELETE FROM workers WHERE worker_id = $1', [workerId]);
}

// ────────────────────────────────────────────────────────────────────
// Skill usage MRU mirror
// ────────────────────────────────────────────────────────────────────

/**
 * Record that a skill was used. Increments `use_count` and refreshes
 * `last_used_at`. Called by `skill-registry.notifyUsed()` via an
 * `onSkillUsed` callback wired at server startup — keeps the registry
 * store-agnostic.
 */
export async function recordSkillUsage(db: PGlite, skillName: string): Promise<void> {
  await db.query(
    `INSERT INTO skill_usage (skill_name, last_used_at, use_count)
     VALUES ($1, NOW(), 1)
     ON CONFLICT (skill_name)
     DO UPDATE SET last_used_at = NOW(), use_count = skill_usage.use_count + 1`,
    [skillName]
  );
}

export interface SkillUsageEntry {
  skillName: string;
  lastUsedAt: string;
  useCount: number;
}

/** Get the MRU-sorted list of recorded skill usage. */
export async function listSkillUsage(db: PGlite): Promise<SkillUsageEntry[]> {
  const result = await db.query<{
    skill_name: string;
    last_used_at: string;
    use_count: number;
  }>('SELECT * FROM skill_usage ORDER BY last_used_at DESC');
  return result.rows.map((r) => ({
    skillName: r.skill_name,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
  }));
}
