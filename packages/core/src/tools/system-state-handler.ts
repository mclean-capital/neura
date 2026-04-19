/**
 * Phase 6b — SystemStateHandler.
 *
 * Single-shot query that surfaces what needs the orchestrator's attention:
 * active workers, tasks blocked on user input, recent completions, upcoming
 * deadlines, and pending proactive items. Called opportunistically by the
 * orchestrator at conversation start and after long pauses.
 *
 * No caching — the source tables are local (PGlite) and sub-ms to query.
 * See docs/phase6b-task-driven-execution.md §get_system_state.
 */

import type { PGlite } from '@electric-sql/pglite';
import type {
  DataStore,
  SystemStateSnapshot,
  TaskCommentUrgency,
  TaskSummary,
  WorkItemEntry,
} from '@neura/types';
import { mapWorkItem, type WorkItemRow } from '../stores/mappers.js';
import type { SystemStateHandler } from './types.js';

/** Non-terminal worker statuses — what `activeWorkers` counts. */
const ACTIVE_WORKER_STATUSES = [
  'spawning',
  'running',
  'blocked_clarifying',
  'idle_partial',
] as const;

/** Maximum upcoming-deadline window (minutes). */
const DEADLINE_WINDOW_MIN = 30;
/** Maximum recent-completion window (minutes). */
const RECENT_WINDOW_MIN = 30;

const URGENCY_RANK: Record<TaskCommentUrgency, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

async function maxOpenUrgency(db: PGlite, taskId: string): Promise<TaskCommentUrgency | undefined> {
  const result = await db.query<{ urgency: TaskCommentUrgency | null }>(
    `SELECT urgency FROM task_comments
     WHERE task_id = $1
       AND type IN ('clarification_request', 'approval_request')
       AND id NOT IN (
         SELECT (metadata->>'resolves_comment_id')::text FROM task_comments
         WHERE task_id = $1
           AND type IN ('clarification_response', 'approval_response')
           AND metadata ? 'resolves_comment_id'
       )`,
    [taskId]
  );
  let best: TaskCommentUrgency | undefined;
  for (const row of result.rows) {
    if (!row.urgency) continue;
    if (!best || URGENCY_RANK[row.urgency] > URGENCY_RANK[best]) {
      best = row.urgency;
    }
  }
  return best;
}

async function toSummary(db: PGlite, item: WorkItemEntry): Promise<TaskSummary> {
  const urgency = await maxOpenUrgency(db, item.id);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    source: item.source,
    goal: item.goal,
    dueAt: item.dueAt,
    leaseExpiresAt: item.leaseExpiresAt,
    updatedAt: item.updatedAt,
    version: item.version,
    ...(urgency ? { urgency } : {}),
  };
}

export interface BuildSystemStateHandlerOptions {
  store: DataStore;
  db: PGlite;
}

export function buildSystemStateHandler(
  options: BuildSystemStateHandlerOptions
): SystemStateHandler {
  const { db } = options;

  return {
    async getSystemState(): Promise<SystemStateSnapshot> {
      // Active workers — count rows in non-terminal statuses.
      const activeWorkerRow = await db.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT as count FROM workers
         WHERE status IN (${ACTIVE_WORKER_STATUSES.map((_, i) => `$${i + 1}`).join(', ')})`,
        [...ACTIVE_WORKER_STATUSES]
      );
      const activeWorkers = Number(activeWorkerRow.rows[0]?.count ?? 0);

      // Attention required — tasks explicitly blocked on user.
      const attentionRes = await db.query<WorkItemRow>(
        `SELECT * FROM work_items
         WHERE status IN ('awaiting_clarification', 'awaiting_approval')
         ORDER BY updated_at DESC
         LIMIT 50`
      );
      const attentionRequired = await Promise.all(
        attentionRes.rows.map((r) => toSummary(db, mapWorkItem(r)))
      );

      // Recent completions — done in the last RECENT_WINDOW_MIN minutes.
      // Use a SQL-side INTERVAL to avoid the TIMESTAMP vs TIMESTAMPTZ mismatch
      // between our schema's `completed_at`/`due_at` (TIMESTAMP, no tz) and a
      // JS ISO string param (interpreted as UTC). Keeping both sides inside
      // PGlite sidesteps the coercion gap.
      const recentRes = await db.query<WorkItemRow>(
        `SELECT * FROM work_items
         WHERE status = 'done'
           AND completed_at > NOW() - INTERVAL '${RECENT_WINDOW_MIN} minutes'
         ORDER BY completed_at DESC
         LIMIT 50`
      );
      const recentCompletions = await Promise.all(
        recentRes.rows.map((r) => toSummary(db, mapWorkItem(r)))
      );

      // Upcoming deadlines — due_at within DEADLINE_WINDOW_MIN, non-terminal.
      const deadlineRes = await db.query<WorkItemRow>(
        `SELECT * FROM work_items
         WHERE due_at IS NOT NULL
           AND due_at <= NOW() + INTERVAL '${DEADLINE_WINDOW_MIN} minutes'
           AND status NOT IN ('done', 'cancelled', 'failed')
         ORDER BY due_at ASC
         LIMIT 50`
      );
      const upcomingDeadlines = await Promise.all(
        deadlineRes.rows.map((r) => toSummary(db, mapWorkItem(r)))
      );

      // Pending proactive — system-generated tasks still awaiting surfacing.
      const proactiveRes = await db.query<WorkItemRow>(
        `SELECT * FROM work_items
         WHERE source IN ('system_proactive', 'discovery_loop')
           AND status IN ('pending', 'awaiting_dispatch')
         ORDER BY created_at ASC
         LIMIT 50`
      );
      const pendingProactive = await Promise.all(
        proactiveRes.rows.map((r) => toSummary(db, mapWorkItem(r)))
      );

      return {
        activeWorkers,
        attentionRequired,
        recentCompletions,
        upcomingDeadlines,
        pendingProactive,
        lastStateFetchAt: new Date().toISOString(),
      };
    },
  };
}
