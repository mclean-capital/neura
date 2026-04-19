import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type {
  TaskContext,
  TaskSource,
  WorkItemEntry,
  WorkItemPriority,
  WorkItemStatus,
} from '@neura/types';
import { mapWorkItem, type WorkItemRow } from './mappers.js';

// --- Work items ---

export async function getOpenWorkItems(db: PGlite, limit = 50): Promise<WorkItemEntry[]> {
  const result = await db.query<WorkItemRow>(
    `SELECT * FROM work_items
     WHERE status IN ('pending', 'awaiting_dispatch', 'in_progress', 'awaiting_clarification', 'awaiting_approval', 'paused')
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
       due_at ASC NULLS LAST,
       created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((r) => mapWorkItem(r));
}

export async function getWorkItems(
  db: PGlite,
  options?: { status?: string; limit?: number }
): Promise<WorkItemEntry[]> {
  const limit = options?.limit ?? 100;
  const status = options?.status;

  let query: string;
  let params: unknown[];

  if (status && status !== 'all') {
    query = `SELECT * FROM work_items WHERE status = $1
             ORDER BY created_at DESC LIMIT $2`;
    params = [status, limit];
  } else {
    query = `SELECT * FROM work_items
             ORDER BY created_at DESC LIMIT $1`;
    params = [limit];
  }

  const result = await db.query<WorkItemRow>(query, params);
  return result.rows.map((r) => mapWorkItem(r));
}

export async function getWorkItem(db: PGlite, id: string): Promise<WorkItemEntry | null> {
  const result = await db.query<WorkItemRow>('SELECT * FROM work_items WHERE id = $1', [id]);
  return result.rows.length > 0 ? mapWorkItem(result.rows[0]) : null;
}

export async function createWorkItem(
  db: PGlite,
  title: string,
  priority: WorkItemPriority,
  options?: {
    description?: string;
    dueAt?: string;
    parentId?: string;
    sourceSessionId?: string;
    // Phase 6b fields (all optional on creation; workers populate later).
    goal?: string;
    context?: TaskContext;
    relatedSkills?: string[];
    repoPath?: string;
    baseBranch?: string;
    source?: TaskSource;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO work_items (
       id, title, priority, description, due_at, parent_id, source_session_id,
       goal, context, related_skills, repo_path, base_branch, source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      title,
      priority,
      options?.description ?? null,
      options?.dueAt ?? null,
      options?.parentId ?? null,
      options?.sourceSessionId ?? null,
      options?.goal ?? null,
      options?.context ? JSON.stringify(options.context) : null,
      JSON.stringify(options?.relatedSkills ?? []),
      options?.repoPath ?? null,
      options?.baseBranch ?? null,
      options?.source ?? 'user',
    ]
  );
  return id;
}

/**
 * Fields the caller may update via {@link updateWorkItem}. Excludes
 * system-managed columns (version, lease_expires_at, completed_at,
 * updated_at — those are maintained by the DB layer).
 */
export interface UpdateWorkItemFields {
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  title?: string;
  description?: string | null;
  dueAt?: string | null;
  goal?: string | null;
  context?: TaskContext | null;
  relatedSkills?: string[];
  repoPath?: string | null;
  baseBranch?: string | null;
  workerId?: string | null;
  leaseExpiresAt?: string | null;
}

/**
 * Error thrown when an optimistic-lock version check fails. Caller should
 * re-read the task and decide whether to retry or abort.
 */
export class VersionConflictError extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedVersion: number
  ) {
    super(`version conflict on work_item ${id} (expected ${expectedVersion})`);
    this.name = 'VersionConflictError';
  }
}

/**
 * Update a work item. Increments `version` on every call. Pass
 * `expectVersion` to enforce optimistic locking — the caller should have
 * read the current version first and pass it here to prevent races
 * between concurrent `update_task` calls (worker + orchestrator).
 *
 * Returns the new version on success. Throws {@link VersionConflictError}
 * if `expectVersion` was supplied and the row's version has moved.
 */
export async function updateWorkItem(
  db: PGlite,
  id: string,
  updates: UpdateWorkItemFields,
  opts?: { expectVersion?: number }
): Promise<number> {
  const sets: string[] = ['updated_at = NOW()', 'version = version + 1'];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.title !== undefined) {
    sets.push(`title = $${paramIdx++}`);
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${paramIdx++}`);
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${paramIdx++}`);
    values.push(updates.status);
    if (
      updates.status === 'done' ||
      updates.status === 'cancelled' ||
      updates.status === 'failed'
    ) {
      sets.push('completed_at = NOW()');
    }
  }
  if (updates.priority !== undefined) {
    sets.push(`priority = $${paramIdx++}`);
    values.push(updates.priority);
  }
  if (updates.dueAt !== undefined) {
    sets.push(`due_at = $${paramIdx++}`);
    values.push(updates.dueAt);
  }
  if (updates.goal !== undefined) {
    sets.push(`goal = $${paramIdx++}`);
    values.push(updates.goal);
  }
  if (updates.context !== undefined) {
    sets.push(`context = $${paramIdx++}`);
    values.push(updates.context === null ? null : JSON.stringify(updates.context));
  }
  if (updates.relatedSkills !== undefined) {
    sets.push(`related_skills = $${paramIdx++}`);
    values.push(JSON.stringify(updates.relatedSkills));
  }
  if (updates.repoPath !== undefined) {
    sets.push(`repo_path = $${paramIdx++}`);
    values.push(updates.repoPath);
  }
  if (updates.baseBranch !== undefined) {
    sets.push(`base_branch = $${paramIdx++}`);
    values.push(updates.baseBranch);
  }
  if (updates.workerId !== undefined) {
    sets.push(`worker_id = $${paramIdx++}`);
    values.push(updates.workerId);
  }
  if (updates.leaseExpiresAt !== undefined) {
    sets.push(`lease_expires_at = $${paramIdx++}`);
    values.push(updates.leaseExpiresAt);
  }

  // Build the WHERE clause — include version guard if provided.
  let whereClause = `WHERE id = $${paramIdx++}`;
  values.push(id);
  if (opts?.expectVersion !== undefined) {
    whereClause += ` AND version = $${paramIdx}`;
    values.push(opts.expectVersion);
  }

  const result = await db.query<{ version: number }>(
    `UPDATE work_items SET ${sets.join(', ')} ${whereClause} RETURNING version`,
    values
  );

  if (result.rows.length === 0) {
    if (opts?.expectVersion !== undefined) {
      throw new VersionConflictError(id, opts.expectVersion);
    }
    throw new Error(`work_item ${id} not found`);
  }

  return result.rows[0].version;
}

export async function deleteWorkItem(db: PGlite, id: string): Promise<void> {
  await db.query('DELETE FROM work_items WHERE id = $1', [id]);
}
