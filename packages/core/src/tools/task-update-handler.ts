/**
 * Phase 6b — Shared update_task invariant layer.
 *
 * Both the orchestrator (websocket.ts) and every worker (per-session tools
 * built in lifecycle.ts) post to the same `update_task` tool. This module is
 * the single place where the handler-level backstops from
 * docs/phase6b-task-driven-execution.md §Concurrency live:
 *
 *   1. Author scoping — workers cannot author as `user` or `orchestrator`.
 *   2. Cross-task writes — a worker can only touch its own task
 *      (`task.worker_id === worker.id`).
 *   3. Transition matrix — workers !→ `cancelled`; orchestrator !→ `done`;
 *      terminal statuses (`done`/`failed`/`cancelled`) are frozen.
 *   4. Completion gate — rejecting `status: 'done'` while an unresolved
 *      `*_request` comment sits on the task (workers must wait for the
 *      orchestrator to relay the response, or switch to `fail_task`).
 *
 * Callers resolve the task by id or title themselves, then hand the resolved
 * `WorkItemEntry` plus the `UpdateTaskPayload` to `applyTaskUpdate`. Field
 * updates and status transitions go through `updateWorkItem` (with optional
 * `expectVersion`); comment appends go through `insertComment`.
 */

import type { PGlite } from '@electric-sql/pglite';
import type {
  DataStore,
  TaskCommentEntry,
  TaskCommentType,
  WorkItemEntry,
  WorkItemStatus,
} from '@neura/types';
import { insertComment, countOpenRequests } from '../stores/task-comment-queries.js';
import {
  getWorkItem,
  updateWorkItem,
  type UpdateWorkItemFields,
} from '../stores/work-item-queries.js';
import type { UpdateTaskPayload } from './types.js';

/**
 * Author identity for an `update_task` call. `worker:<id>` originates from a
 * running worker session; `orchestrator` from a voice session; `system` from
 * internal code (migrations, discovery loop, tests).
 */
export type TaskUpdateActor = `worker:${string}` | 'orchestrator' | 'system';

/** Terminal statuses — no further transitions allowed. */
const TERMINAL_STATUSES = new Set<WorkItemStatus>(['done', 'cancelled', 'failed']);

/** Status transitions workers are allowed to make (from → to). */
const WORKER_ALLOWED_FROM: Record<WorkItemStatus, Set<WorkItemStatus>> = {
  pending: new Set(['in_progress', 'failed']),
  awaiting_dispatch: new Set(['in_progress', 'failed']),
  in_progress: new Set(['awaiting_clarification', 'awaiting_approval', 'paused', 'done', 'failed']),
  awaiting_clarification: new Set(['in_progress', 'failed']),
  awaiting_approval: new Set(['in_progress', 'failed']),
  paused: new Set(['in_progress', 'failed']),
  done: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

/** Status transitions the orchestrator is allowed to make (from → to). */
const ORCHESTRATOR_ALLOWED_FROM: Record<WorkItemStatus, Set<WorkItemStatus>> = {
  pending: new Set(['awaiting_dispatch', 'in_progress', 'cancelled', 'paused']),
  awaiting_dispatch: new Set(['pending', 'in_progress', 'cancelled', 'paused']),
  in_progress: new Set(['awaiting_clarification', 'awaiting_approval', 'paused', 'cancelled']),
  awaiting_clarification: new Set(['in_progress', 'cancelled', 'paused']),
  awaiting_approval: new Set(['in_progress', 'cancelled', 'paused']),
  paused: new Set(['in_progress', 'cancelled']),
  done: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

/** Comment types workers are allowed to author. */
const WORKER_ALLOWED_COMMENT_TYPES = new Set<TaskCommentType>([
  'progress',
  'heartbeat',
  'clarification_request',
  'approval_request',
  'error',
  'result',
]);

export class InvalidUpdateError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'cross_task_write'
      | 'forbidden_transition'
      | 'open_request_blocks_completion'
      | 'worker_author_spoofing'
      | 'terminal_locked'
      | 'unknown_actor'
  ) {
    super(message);
    this.name = 'InvalidUpdateError';
  }
}

function parseActor(actor: TaskUpdateActor): {
  kind: 'worker' | 'orchestrator' | 'system';
  workerId?: string;
} {
  if (actor === 'orchestrator' || actor === 'system') return { kind: actor };
  if (actor.startsWith('worker:')) {
    const workerId = actor.slice('worker:'.length);
    if (!workerId) {
      throw new InvalidUpdateError(`invalid worker actor: "${actor}"`, 'unknown_actor');
    }
    return { kind: 'worker', workerId };
  }
  throw new InvalidUpdateError(`unrecognized actor: "${actor}"`, 'unknown_actor');
}

function assertTransition(
  from: WorkItemStatus,
  to: WorkItemStatus,
  actorKind: 'worker' | 'orchestrator' | 'system'
): void {
  if (from === to) return; // idempotent self-transitions are fine
  if (TERMINAL_STATUSES.has(from)) {
    throw new InvalidUpdateError(
      `task is terminal (${from}); no transitions allowed`,
      'terminal_locked'
    );
  }
  // System actor has free rein (used for migrations, crash sweep, etc.).
  if (actorKind === 'system') return;

  const table = actorKind === 'worker' ? WORKER_ALLOWED_FROM : ORCHESTRATOR_ALLOWED_FROM;
  const allowed = table[from];
  if (!allowed.has(to)) {
    throw new InvalidUpdateError(
      `${actorKind} cannot transition ${from} → ${to}`,
      'forbidden_transition'
    );
  }
}

export interface ApplyTaskUpdateArgs {
  db: PGlite;
  task: WorkItemEntry;
  payload: UpdateTaskPayload;
  actor: TaskUpdateActor;
  /** Overrides `now()` for deterministic tests. */
  now?: () => Date;
}

export interface ApplyTaskUpdateResult {
  task: WorkItemEntry;
  version: number;
  comment?: TaskCommentEntry;
}

/**
 * Apply a validated update to a task. Enforces author scoping, cross-task
 * writes, the transition matrix, and the completion gate. Performs the
 * field/status update then appends the optional comment. Returns the
 * refreshed task + new version + the inserted comment (if any).
 *
 * Caller is responsible for resolving the target task (by id or title) and
 * for supplying the correct `actor`. The handler does not read session/auth
 * state — that's above its pay grade.
 */
export async function applyTaskUpdate(args: ApplyTaskUpdateArgs): Promise<ApplyTaskUpdateResult> {
  const { db, task, payload, actor } = args;
  const who = parseActor(actor);

  // 1. Cross-task write guard (worker only). A worker may only update a
  //    task whose `worker_id` matches its own id. Fresh, undispatched tasks
  //    (worker_id = null) are off-limits to workers too — the dispatch
  //    handler runs as `system` and is the only path that assigns
  //    `worker_id` on a pending row.
  if (who.kind === 'worker') {
    if (task.workerId !== who.workerId) {
      throw new InvalidUpdateError(
        `worker ${who.workerId} cannot update task ${task.id} (owned by ${task.workerId ?? 'none'})`,
        'cross_task_write'
      );
    }
  }

  // 2. Transition-matrix check (when status change requested).
  if (payload.status !== undefined) {
    assertTransition(task.status, payload.status, who.kind);
  }

  // 3. Comment-author scoping (workers can only author a limited set).
  if (payload.comment && who.kind === 'worker') {
    if (!WORKER_ALLOWED_COMMENT_TYPES.has(payload.comment.type)) {
      throw new InvalidUpdateError(
        `worker cannot author ${payload.comment.type} comments`,
        'worker_author_spoofing'
      );
    }
  }

  // 4. Completion gate — refuse `status: done` while an unresolved
  //    *_request comment sits on the task. The worker should either wait
  //    for the response or switch to `fail_task` (status: failed).
  if (payload.status === 'done') {
    const open = await countOpenRequests(db, task.id);
    if (open > 0) {
      throw new InvalidUpdateError(
        `cannot complete task with ${open} unresolved request(s); wait for response or fail instead`,
        'open_request_blocks_completion'
      );
    }
  }

  // ── Perform the update ────────────────────────────────────────────────
  const updates: UpdateWorkItemFields = {};
  if (payload.status !== undefined) updates.status = payload.status;
  if (payload.fields) {
    const f = payload.fields;
    if (f.title !== undefined) updates.title = f.title;
    if (f.priority !== undefined) updates.priority = f.priority;
    if (f.description !== undefined) updates.description = f.description;
    if (f.dueAt !== undefined) updates.dueAt = f.dueAt;
    if (f.goal !== undefined) updates.goal = f.goal;
    if (f.context !== undefined) updates.context = f.context;
    if (f.relatedSkills !== undefined) updates.relatedSkills = f.relatedSkills;
    if (f.repoPath !== undefined) updates.repoPath = f.repoPath;
    if (f.baseBranch !== undefined) updates.baseBranch = f.baseBranch;
    if (f.workerId !== undefined) updates.workerId = f.workerId;
    if (f.leaseExpiresAt !== undefined) updates.leaseExpiresAt = f.leaseExpiresAt;
  }

  let version = task.version;
  if (Object.keys(updates).length > 0) {
    version = await updateWorkItem(
      db,
      task.id,
      updates,
      payload.expectVersion !== undefined ? { expectVersion: payload.expectVersion } : undefined
    );
  }

  // ── Append comment (if any) ───────────────────────────────────────────
  let comment: TaskCommentEntry | undefined;
  if (payload.comment) {
    comment = await insertComment(db, {
      taskId: task.id,
      type: payload.comment.type,
      author: actor,
      content: payload.comment.content,
      attachmentPath: payload.comment.attachmentPath ?? null,
      urgency: payload.comment.urgency ?? null,
      metadata: payload.comment.metadata ?? null,
    });
  }

  // Refresh the task row for the caller. `updateWorkItem` already bumped
  // `updated_at`; re-reading keeps consumers from assembling stale snapshots.
  const refreshed = await getWorkItem(db, task.id);
  if (!refreshed) {
    // Row should exist — we just updated it. If it vanished, something
    // upstream raced us; surface as a generic error so the caller retries.
    throw new Error(`task ${task.id} disappeared mid-update`);
  }

  return { task: refreshed, version, ...(comment ? { comment } : {}) };
}

/**
 * Resolve a task by id or by fuzzy title match. Matches the pre-Pass-2
 * behavior embedded in websocket.ts. Callers use this to find the target
 * row before handing it to {@link applyTaskUpdate}.
 */
export async function resolveTask(
  store: DataStore,
  idOrTitle: string
): Promise<WorkItemEntry | null> {
  const byId = await store.getWorkItem(idOrTitle);
  if (byId) return byId;
  const all = await store.getWorkItems({ limit: 200 });
  const lower = idOrTitle.toLowerCase();
  return all.find((t) => t.title.toLowerCase().includes(lower)) ?? null;
}
