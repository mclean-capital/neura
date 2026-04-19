/**
 * Tests for task-comment-queries.ts — the Phase 6b comments CRUD.
 *
 * Uses an in-memory PGlite via the PgliteStore facade. Comments are tied to
 * a work_item (FK CASCADE), so every test creates a parent task first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import crypto from 'crypto';
import { runMigrations } from './migrations.js';
import {
  insertComment,
  listComments,
  pruneHeartbeats,
  countOpenRequests,
  TASK_COMMENT_CONTENT_MAX_BYTES,
} from './task-comment-queries.js';

describe('task-comment-queries', () => {
  let db: PGlite;
  let taskId: string;

  beforeEach(async () => {
    db = await PGlite.create({ extensions: { vector } });
    await runMigrations(db);

    // Seed a work_item to anchor comments to.
    taskId = crypto.randomUUID();
    await db.query(`INSERT INTO work_items (id, title, priority) VALUES ($1, $2, $3)`, [
      taskId,
      'Test task',
      'medium',
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('insertComment', () => {
    it('inserts a progress comment and returns the entry', async () => {
      const comment = await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:abc-123',
        content: 'Halfway done',
      });

      expect(comment.taskId).toBe(taskId);
      expect(comment.type).toBe('progress');
      expect(comment.author).toBe('worker:abc-123');
      expect(comment.content).toBe('Halfway done');
      expect(comment.urgency).toBeNull();
      expect(comment.metadata).toBeNull();
      expect(comment.attachmentPath).toBeNull();
      expect(comment.createdAt).toBeTruthy();
    });

    it('inserts a clarification_request with urgency + metadata', async () => {
      const comment = await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:abc-123',
        content: 'Which branch should I push to?',
        urgency: 'high',
        metadata: { topic: 'git-branch-selection' },
      });

      expect(comment.type).toBe('clarification_request');
      expect(comment.urgency).toBe('high');
      expect(comment.metadata).toEqual({ topic: 'git-branch-selection' });
    });

    it('supports attachment_path for overflow content', async () => {
      const comment = await insertComment(db, {
        taskId,
        type: 'error',
        author: 'worker:abc-123',
        content: 'Traceback summary (first 10 lines)…',
        attachmentPath: '/tmp/worker/abc-123/_attachments/traceback-1.txt',
      });

      expect(comment.attachmentPath).toBe('/tmp/worker/abc-123/_attachments/traceback-1.txt');
    });

    it('rejects content exceeding the 32 KB cap', async () => {
      const big = 'a'.repeat(TASK_COMMENT_CONTENT_MAX_BYTES + 1);
      await expect(
        insertComment(db, { taskId, type: 'progress', author: 'worker:1', content: big })
      ).rejects.toThrow(/exceeds/);
    });

    it('accepts content exactly at the 32 KB cap', async () => {
      const exact = 'a'.repeat(TASK_COMMENT_CONTENT_MAX_BYTES);
      const comment = await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: exact,
      });
      expect(Buffer.byteLength(comment.content)).toBe(TASK_COMMENT_CONTENT_MAX_BYTES);
    });

    it('rejects insertion for an unknown task_id (FK enforced)', async () => {
      await expect(
        insertComment(db, {
          taskId: 'does-not-exist',
          type: 'progress',
          author: 'worker:1',
          content: 'orphan',
        })
      ).rejects.toThrow();
    });
  });

  describe('listComments', () => {
    it('returns comments in chronological order', async () => {
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: 'first',
      });
      // Small delay so timestamps differ enough for ordering
      await new Promise((r) => setTimeout(r, 5));
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: 'second',
      });
      await new Promise((r) => setTimeout(r, 5));
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: 'third',
      });

      const comments = await listComments(db, { taskId });
      expect(comments).toHaveLength(3);
      expect(comments[0].content).toBe('first');
      expect(comments[1].content).toBe('second');
      expect(comments[2].content).toBe('third');
    });

    it('filters by single comment type', async () => {
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: 'p',
      });
      await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:1',
        content: 'q',
      });
      await insertComment(db, {
        taskId,
        type: 'result',
        author: 'worker:1',
        content: 'done',
      });

      const requests = await listComments(db, { taskId, type: 'clarification_request' });
      expect(requests).toHaveLength(1);
      expect(requests[0].content).toBe('q');
    });

    it('filters by multiple comment types', async () => {
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: 'p',
      });
      await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:1',
        content: 'q',
      });
      await insertComment(db, {
        taskId,
        type: 'approval_request',
        author: 'worker:1',
        content: 'a',
      });

      const requests = await listComments(db, {
        taskId,
        type: ['clarification_request', 'approval_request'],
      });
      expect(requests).toHaveLength(2);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await insertComment(db, {
          taskId,
          type: 'progress',
          author: 'worker:1',
          content: `msg ${i}`,
        });
      }
      const limited = await listComments(db, { taskId, limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it('cascades delete when parent task is deleted', async () => {
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:1',
        content: 'orphan-to-be',
      });

      await db.query('DELETE FROM work_items WHERE id = $1', [taskId]);

      const comments = await listComments(db, { taskId });
      expect(comments).toHaveLength(0);
    });
  });

  describe('pruneHeartbeats', () => {
    it('deletes only heartbeat comments from the named author', async () => {
      await insertComment(db, {
        taskId,
        type: 'heartbeat',
        author: 'worker:alpha',
        content: 'alive',
      });
      await insertComment(db, {
        taskId,
        type: 'heartbeat',
        author: 'worker:alpha',
        content: 'still alive',
      });
      await insertComment(db, {
        taskId,
        type: 'heartbeat',
        author: 'worker:beta',
        content: 'unrelated',
      });
      await insertComment(db, {
        taskId,
        type: 'progress',
        author: 'worker:alpha',
        content: 'keep-me',
      });

      const pruned = await pruneHeartbeats(db, taskId, 'worker:alpha');
      expect(pruned).toBe(2);

      const remaining = await listComments(db, { taskId });
      expect(remaining).toHaveLength(2);
      expect(remaining.some((c) => c.author === 'worker:beta' && c.type === 'heartbeat')).toBe(
        true
      );
      expect(remaining.some((c) => c.author === 'worker:alpha' && c.type === 'progress')).toBe(
        true
      );
    });
  });

  describe('countOpenRequests', () => {
    it('counts unresolved clarification_request + approval_request comments', async () => {
      await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:1',
        content: 'q1',
      });
      await insertComment(db, {
        taskId,
        type: 'approval_request',
        author: 'worker:1',
        content: 'approve?',
      });

      expect(await countOpenRequests(db, taskId)).toBe(2);
    });

    it('excludes requests with a matching response comment', async () => {
      const clarifyReq = await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:1',
        content: 'q1',
      });
      await insertComment(db, {
        taskId,
        type: 'clarification_response',
        author: 'orchestrator',
        content: 'use main',
        metadata: { resolves_comment_id: clarifyReq.id },
      });

      expect(await countOpenRequests(db, taskId)).toBe(0);
    });

    it('returns 0 on a task with no comments at all', async () => {
      expect(await countOpenRequests(db, taskId)).toBe(0);
    });

    it('ignores orchestrator responses that point at a nonexistent request id', async () => {
      await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:1',
        content: 'real question',
      });
      // A malformed response that points at an id that doesn't exist on
      // this task (e.g. from a prior session or a bug). Must not
      // accidentally "resolve" the unrelated real request.
      await insertComment(db, {
        taskId,
        type: 'clarification_response',
        author: 'orchestrator',
        content: 'dangling answer',
        metadata: { resolves_comment_id: crypto.randomUUID() },
      });

      expect(await countOpenRequests(db, taskId)).toBe(1);
    });

    it('scopes resolution lookup to the current task — cross-task response ids do not resolve', async () => {
      // Create a second task with its own request + response.
      const otherTaskId = crypto.randomUUID();
      await db.query(`INSERT INTO work_items (id, title, priority) VALUES ($1, $2, $3)`, [
        otherTaskId,
        'Other task',
        'medium',
      ]);
      const otherReq = await insertComment(db, {
        taskId: otherTaskId,
        type: 'clarification_request',
        author: 'worker:other',
        content: 'other question',
      });

      // On our original task, have a request and then a malformed response
      // that references the OTHER task's request id.
      await insertComment(db, {
        taskId,
        type: 'clarification_request',
        author: 'worker:1',
        content: 'q1',
      });
      await insertComment(db, {
        taskId,
        type: 'clarification_response',
        author: 'orchestrator',
        content: 'cross-task leak attempt',
        metadata: { resolves_comment_id: otherReq.id },
      });

      // The original task's request should still count as open.
      // (countOpenRequests's subquery scopes to task_id = $1, so the
      // cross-task response is invisible.)
      expect(await countOpenRequests(db, taskId)).toBe(1);

      // The other task's request should also still be open — the only
      // response in the system references it from the wrong task.
      expect(await countOpenRequests(db, otherTaskId)).toBe(1);
    });
  });
});
