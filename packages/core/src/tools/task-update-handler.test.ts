/**
 * Tests for the shared update_task invariant layer. Covers the four
 * handler-level backstops from docs/phase6b-task-driven-execution.md
 * §Concurrency → Handler-level backstops.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { runMigrations } from '../stores/migrations.js';
import { createWorkItem, getWorkItem, updateWorkItem } from '../stores/work-item-queries.js';
import { insertComment } from '../stores/task-comment-queries.js';
import { applyTaskUpdate, InvalidUpdateError, resolveTask } from './task-update-handler.js';
import type { DataStore, WorkItemEntry } from '@neura/types';

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create('memory://', { extensions: { vector } });
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
});

async function makeTask(
  opts: {
    title?: string;
    status?: string;
    workerId?: string | null;
  } = {}
): Promise<WorkItemEntry> {
  const id = await createWorkItem(db, opts.title ?? 'Test task', 'medium', {});
  const updates: Parameters<typeof updateWorkItem>[2] = {};
  if (opts.status || opts.workerId !== undefined) {
    await updateWorkItem(db, id, {
      ...(opts.status
        ? { status: opts.status as Parameters<typeof updateWorkItem>[2]['status'] }
        : {}),
      ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}),
    });
  }
  void updates;
  const row = await getWorkItem(db, id);
  if (!row) throw new Error('failed to create test task');
  return row;
}

describe('applyTaskUpdate — transition matrix', () => {
  it('orchestrator can move pending → awaiting_dispatch', async () => {
    const task = await makeTask();
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { status: 'awaiting_dispatch' },
      actor: 'orchestrator',
    });
    expect(result.task.status).toBe('awaiting_dispatch');
  });

  it('orchestrator cannot transition to done (worker-only)', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { status: 'done' },
        actor: 'orchestrator',
      })
    ).rejects.toThrow(/cannot transition/);
  });

  it('worker cannot transition to cancelled (orchestrator-only)', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { status: 'cancelled' },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(/cannot transition/);
  });

  it('worker may transition in_progress → done when no open requests exist', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { status: 'done' },
      actor: 'worker:w-1',
    });
    expect(result.task.status).toBe('done');
  });

  it('terminal statuses are frozen — no transitions allowed', async () => {
    const task = await makeTask({ status: 'done', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { status: 'in_progress' },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(/terminal/);
  });

  it('system actor bypasses the transition matrix', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { status: 'done' },
      actor: 'system',
    });
    expect(result.task.status).toBe('done');
  });
});

describe('applyTaskUpdate — cross-task write guard', () => {
  it('worker cannot update a task owned by another worker', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { comment: { type: 'progress', content: 'sneaky update' } },
        actor: 'worker:w-2',
      })
    ).rejects.toThrow(/cannot update task/);
  });

  it('worker cannot update an undispatched task (worker_id is null)', async () => {
    const task = await makeTask();
    expect(task.workerId).toBeNull();
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { comment: { type: 'progress', content: 'hijack' } },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(InvalidUpdateError);
  });

  it('orchestrator can update any task regardless of worker_id', async () => {
    const task = await makeTask({ workerId: 'w-1' });
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { comment: { type: 'progress', content: 'orchestrator note' } },
      actor: 'orchestrator',
    });
    expect(result.comment?.author).toBe('orchestrator');
  });
});

describe('applyTaskUpdate — worker field allow-list', () => {
  it('rejects worker attempts to rewrite workerId (no self-reassignment)', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { fields: { workerId: 'attacker' } },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(/cannot mutate field 'workerId'/);
  });

  it('rejects worker attempts to rewrite goal / title / priority', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { fields: { goal: 'rewritten' } },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(/cannot mutate field 'goal'/);
  });

  it('allows worker to refresh leaseExpiresAt', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    const newLease = new Date(Date.now() + 5 * 60_000).toISOString();
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { fields: { leaseExpiresAt: newLease } },
      actor: 'worker:w-1',
    });
    expect(result.task.leaseExpiresAt).toBeTruthy();
  });

  it('orchestrator can mutate any field', async () => {
    const task = await makeTask({ workerId: 'w-1' });
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { fields: { goal: 'orch rewrite', priority: 'high' } },
      actor: 'orchestrator',
    });
    expect(result.task.goal).toBe('orch rewrite');
    expect(result.task.priority).toBe('high');
  });
});

describe('applyTaskUpdate — author-spoofing guard', () => {
  it('worker cannot author a clarification_response comment', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { comment: { type: 'clarification_response', content: 'fake answer' } },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(/cannot author/);
  });

  it('worker can author clarification_request (part of 6-verb protocol)', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    const result = await applyTaskUpdate({
      db,
      task,
      payload: {
        status: 'awaiting_clarification',
        comment: { type: 'clarification_request', content: 'which branch?' },
      },
      actor: 'worker:w-1',
    });
    expect(result.comment?.type).toBe('clarification_request');
    expect(result.comment?.author).toBe('worker:w-1');
  });
});

describe('applyTaskUpdate — completion gate', () => {
  it('rejects status: done when an unresolved clarification_request exists', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await insertComment(db, {
      taskId: task.id,
      type: 'clarification_request',
      author: 'worker:w-1',
      content: 'which file?',
      urgency: 'normal',
    });
    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { status: 'done', comment: { type: 'result', content: 'done' } },
        actor: 'worker:w-1',
      })
    ).rejects.toThrow(/unresolved request/);
  });

  it('accepts status: done once the request has a matching response', async () => {
    const task = await makeTask({ status: 'awaiting_clarification', workerId: 'w-1' });
    const req = await insertComment(db, {
      taskId: task.id,
      type: 'clarification_request',
      author: 'worker:w-1',
      content: 'which file?',
      urgency: 'normal',
    });
    await insertComment(db, {
      taskId: task.id,
      type: 'clarification_response',
      author: 'orchestrator',
      content: 'the main one',
      metadata: { resolves_comment_id: req.id },
    });

    // Worker goes back to in_progress then to done.
    const toRunning = await applyTaskUpdate({
      db,
      task,
      payload: { status: 'in_progress' },
      actor: 'worker:w-1',
    });
    const result = await applyTaskUpdate({
      db,
      task: toRunning.task,
      payload: { status: 'done', comment: { type: 'result', content: 'finished' } },
      actor: 'worker:w-1',
    });
    expect(result.task.status).toBe('done');
  });

  it('worker can fail_task (status: failed) even with open requests', async () => {
    const task = await makeTask({ status: 'in_progress', workerId: 'w-1' });
    await insertComment(db, {
      taskId: task.id,
      type: 'approval_request',
      author: 'worker:w-1',
      content: 'destructive op?',
      urgency: 'high',
    });
    const result = await applyTaskUpdate({
      db,
      task,
      payload: { status: 'failed', comment: { type: 'error', content: 'cannot proceed' } },
      actor: 'worker:w-1',
    });
    expect(result.task.status).toBe('failed');
  });
});

describe('applyTaskUpdate — optimistic lock passthrough', () => {
  it('passes expectVersion to updateWorkItem', async () => {
    const task = await makeTask({ workerId: 'w-1' });
    const stale = task.version;

    // Another writer bumps version.
    await updateWorkItem(db, task.id, { goal: 'changed' });

    const refreshed = (await getWorkItem(db, task.id))!;
    expect(refreshed.version).toBeGreaterThan(stale);

    await expect(
      applyTaskUpdate({
        db,
        task,
        payload: { fields: { goal: 'mine' }, expectVersion: stale },
        actor: 'orchestrator',
      })
    ).rejects.toThrow(/version conflict/);
  });
});

describe('resolveTask', () => {
  it('finds a task by id', async () => {
    const task = await makeTask({ title: 'Unique title' });
    const fakeStore = {
      getWorkItem: (id: string) => getWorkItem(db, id),
      getWorkItems: () => Promise.resolve([]),
    } as unknown as DataStore;
    const found = await resolveTask(fakeStore, task.id);
    expect(found?.id).toBe(task.id);
  });

  it('falls back to fuzzy title match', async () => {
    const task = await makeTask({ title: 'Ship phase 6b' });
    const fakeStore = {
      getWorkItem: () => Promise.resolve(null),
      getWorkItems: () => Promise.resolve([task]),
    } as unknown as DataStore;
    const found = await resolveTask(fakeStore, 'phase 6b');
    expect(found?.id).toBe(task.id);
  });
});
