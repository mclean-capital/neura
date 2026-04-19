/**
 * Phase 6b — task_comments CRUD.
 *
 * Every worker → orchestrator protocol event is persisted as a task_comment
 * row (progress, heartbeat, clarification_request, approval_request, result,
 * error, etc.), plus orchestrator/user/system-authored companion comments.
 * Tickets (task rows + comments) are the durable state of truth; the
 * ClarificationBridge is just a live-transport optimization on top.
 *
 * See docs/phase6b-task-driven-execution.md §Schema Changes.
 */

import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type {
  TaskCommentAuthor,
  TaskCommentEntry,
  TaskCommentType,
  TaskCommentUrgency,
} from '@neura/types';
import { mapTaskComment, type TaskCommentRow } from './mappers.js';

/** Hard upper bound on content size. Enforced in `insertComment` — over-cap
 * content must be written to disk by the caller and passed via
 * `attachmentPath` with a summary in `content`. */
export const TASK_COMMENT_CONTENT_MAX_BYTES = 32 * 1024;

export interface InsertCommentOptions {
  taskId: string;
  type: TaskCommentType;
  author: TaskCommentAuthor;
  content: string;
  attachmentPath?: string | null;
  urgency?: TaskCommentUrgency | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert a task_comment row. Enforces the 32 KB content cap — callers
 * that need to attach longer output should write it to an attachment
 * file first and pass `attachmentPath` with a truncated summary in
 * `content`.
 */
export async function insertComment(
  db: PGlite,
  opts: InsertCommentOptions
): Promise<TaskCommentEntry> {
  if (Buffer.byteLength(opts.content, 'utf8') > TASK_COMMENT_CONTENT_MAX_BYTES) {
    throw new Error(
      `task comment content exceeds ${TASK_COMMENT_CONTENT_MAX_BYTES} bytes; ` +
        `write to disk and pass attachment_path with a summary in content`
    );
  }

  const id = crypto.randomUUID();
  const result = await db.query<TaskCommentRow>(
    `INSERT INTO task_comments (
       id, task_id, type, author, content, attachment_path, urgency, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      opts.taskId,
      opts.type,
      opts.author,
      opts.content,
      opts.attachmentPath ?? null,
      opts.urgency ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ]
  );
  return mapTaskComment(result.rows[0]);
}

export interface ListCommentsOptions {
  taskId: string;
  type?: TaskCommentType | TaskCommentType[];
  since?: string; // ISO timestamp
  limit?: number;
}

export async function listComments(
  db: PGlite,
  opts: ListCommentsOptions
): Promise<TaskCommentEntry[]> {
  const limit = opts.limit ?? 500;
  const filters: string[] = ['task_id = $1'];
  const values: unknown[] = [opts.taskId];
  let idx = 2;

  if (opts.type !== undefined) {
    const types = Array.isArray(opts.type) ? opts.type : [opts.type];
    const placeholders = types.map(() => `$${idx++}`).join(', ');
    filters.push(`type IN (${placeholders})`);
    values.push(...types);
  }
  if (opts.since) {
    filters.push(`created_at > $${idx++}`);
    values.push(opts.since);
  }

  const result = await db.query<TaskCommentRow>(
    `SELECT * FROM task_comments
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at ASC
     LIMIT $${idx}`,
    [...values, limit]
  );
  return result.rows.map((r) => mapTaskComment(r));
}

/**
 * Prune old heartbeat comments from the same worker. Called after a new
 * non-heartbeat comment lands from the worker — heartbeat semantics are
 * "I'm alive," so we only need the most recent one to drive lease checks.
 *
 * Returns the number of rows deleted.
 */
export async function pruneHeartbeats(
  db: PGlite,
  taskId: string,
  author: TaskCommentAuthor
): Promise<number> {
  const result = await db.query<{ id: string }>(
    `DELETE FROM task_comments
     WHERE task_id = $1 AND type = 'heartbeat' AND author = $2
     RETURNING id`,
    [taskId, author]
  );
  return result.rows.length;
}

/**
 * Count unresolved `*_request` comments on a task. Used by the orchestrator
 * to decide if the handler should reject a new `complete_task` attempt
 * while a request is still outstanding (backstop for prompt discipline).
 */
export async function countOpenRequests(db: PGlite, taskId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT as count FROM task_comments
     WHERE task_id = $1
       AND type IN ('clarification_request', 'approval_request')
       AND id NOT IN (
         -- requests with a matching response comment are considered resolved
         SELECT (metadata->>'resolves_comment_id')::text FROM task_comments
         WHERE task_id = $1
           AND type IN ('clarification_response', 'approval_response')
           AND metadata ? 'resolves_comment_id'
       )`,
    [taskId]
  );
  return Number(result.rows[0]?.count ?? 0);
}
