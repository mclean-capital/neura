import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type { WorkItemEntry, WorkItemPriority } from '@neura/types';
import { mapWorkItem } from './mappers.js';

// --- Work items ---

export async function getOpenWorkItems(db: PGlite, limit = 50): Promise<WorkItemEntry[]> {
  const result = await db.query<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    due_at: string | null;
    parent_id: string | null;
    source_session_id: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>(
    `SELECT * FROM work_items
     WHERE status IN ('pending', 'in_progress')
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

  const result = await db.query<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    due_at: string | null;
    parent_id: string | null;
    source_session_id: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>(query, params);
  return result.rows.map((r) => mapWorkItem(r));
}

export async function getWorkItem(db: PGlite, id: string): Promise<WorkItemEntry | null> {
  const result = await db.query<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    due_at: string | null;
    parent_id: string | null;
    source_session_id: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>('SELECT * FROM work_items WHERE id = $1', [id]);
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
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO work_items (id, title, priority, description, due_at, parent_id, source_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      title,
      priority,
      options?.description ?? null,
      options?.dueAt ?? null,
      options?.parentId ?? null,
      options?.sourceSessionId ?? null,
    ]
  );
  return id;
}

export async function updateWorkItem(
  db: PGlite,
  id: string,
  updates: Partial<Pick<WorkItemEntry, 'status' | 'priority' | 'title' | 'description' | 'dueAt'>>
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
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

  values.push(id);
  await db.query(`UPDATE work_items SET ${sets.join(', ')} WHERE id = $${paramIdx}`, values);
}

export async function deleteWorkItem(db: PGlite, id: string): Promise<void> {
  await db.query('DELETE FROM work_items WHERE id = $1', [id]);
}
