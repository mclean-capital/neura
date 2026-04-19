/**
 * Tests for the Phase 6b SystemStateHandler. Covers the five shape
 * categories it surfaces (activeWorkers, attentionRequired,
 * recentCompletions, upcomingDeadlines, pendingProactive).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PgliteStore } from '../stores/index.js';
import { createWorkItem, updateWorkItem } from '../stores/work-item-queries.js';
import { insertComment } from '../stores/task-comment-queries.js';
import { buildSystemStateHandler } from './system-state-handler.js';

async function seedWorkerRow(db: PGlite, status: string): Promise<string> {
  const workerId = `w-${Math.random().toString(36).slice(2, 10)}`;
  await db.query(
    `INSERT INTO workers (worker_id, task_type, task_spec, status)
     VALUES ($1, 'ad_hoc', '{"taskType":"ad_hoc","description":"x"}', $2)`,
    [workerId, status]
  );
  return workerId;
}

let store: PgliteStore;
let db: PGlite;

beforeEach(async () => {
  store = await PgliteStore.create();
  db = store.getRawDb();
});

afterEach(async () => {
  await store.close();
});

describe('SystemStateHandler.getSystemState', () => {
  it('returns zero counts on an empty DB', async () => {
    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();
    expect(snapshot.activeWorkers).toBe(0);
    expect(snapshot.attentionRequired).toEqual([]);
    expect(snapshot.recentCompletions).toEqual([]);
    expect(snapshot.upcomingDeadlines).toEqual([]);
    expect(snapshot.pendingProactive).toEqual([]);
    expect(snapshot.lastStateFetchAt).toBeTruthy();
  });

  it('counts non-terminal workers as activeWorkers', async () => {
    await seedWorkerRow(db, 'running');
    await seedWorkerRow(db, 'spawning');
    await seedWorkerRow(db, 'completed'); // terminal — excluded
    await seedWorkerRow(db, 'crashed'); // terminal — excluded
    await seedWorkerRow(db, 'blocked_clarifying');
    await seedWorkerRow(db, 'idle_partial');

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();
    expect(snapshot.activeWorkers).toBe(4);
  });

  it('surfaces awaiting_clarification and awaiting_approval tasks', async () => {
    const idA = await createWorkItem(db, 'Ask user A', 'medium', {});
    await updateWorkItem(db, idA, { status: 'awaiting_clarification' });

    const idB = await createWorkItem(db, 'Destructive op', 'high', {});
    await updateWorkItem(db, idB, { status: 'awaiting_approval' });

    // A non-waiting task — should NOT appear in attentionRequired.
    await createWorkItem(db, 'Other', 'low', {});

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();

    const titles = snapshot.attentionRequired.map((t) => t.title).sort();
    expect(titles).toEqual(['Ask user A', 'Destructive op']);
  });

  it('attaches max urgency from unresolved request comments', async () => {
    const id = await createWorkItem(db, 'Ask', 'medium', {});
    await updateWorkItem(db, id, { status: 'awaiting_clarification' });

    await insertComment(db, {
      taskId: id,
      type: 'clarification_request',
      author: 'worker:w-1',
      content: 'q1',
      urgency: 'normal',
    });
    await insertComment(db, {
      taskId: id,
      type: 'clarification_request',
      author: 'worker:w-1',
      content: 'q2',
      urgency: 'high',
    });

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();
    expect(snapshot.attentionRequired).toHaveLength(1);
    expect(snapshot.attentionRequired[0].urgency).toBe('high');
  });

  it('ignores urgency from resolved requests', async () => {
    const id = await createWorkItem(db, 'Ask', 'medium', {});
    await updateWorkItem(db, id, { status: 'awaiting_clarification' });

    const req = await insertComment(db, {
      taskId: id,
      type: 'clarification_request',
      author: 'worker:w-1',
      content: 'q',
      urgency: 'critical',
    });
    await insertComment(db, {
      taskId: id,
      type: 'clarification_response',
      author: 'orchestrator',
      content: 'a',
      metadata: { resolves_comment_id: req.id },
    });

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();
    expect(snapshot.attentionRequired[0].urgency).toBeUndefined();
  });

  it('includes recently-done tasks in recentCompletions', async () => {
    const id = await createWorkItem(db, 'Done recently', 'medium', {});
    await updateWorkItem(db, id, { status: 'done' });

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();
    expect(snapshot.recentCompletions).toHaveLength(1);
    expect(snapshot.recentCompletions[0].status).toBe('done');
  });

  it('includes near-deadline non-terminal tasks in upcomingDeadlines', async () => {
    const dueSoon = new Date(Date.now() + 10 * 60_000).toISOString();
    const dueLater = new Date(Date.now() + 90 * 60_000).toISOString();

    const a = await createWorkItem(db, 'Due soon', 'high', { dueAt: dueSoon });
    await createWorkItem(db, 'Due later', 'low', { dueAt: dueLater });

    // Terminal task with a near deadline — excluded.
    const c = await createWorkItem(db, 'Already done', 'medium', { dueAt: dueSoon });
    await updateWorkItem(db, c, { status: 'done' });

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();

    const ids = snapshot.upcomingDeadlines.map((t) => t.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(c);
    expect(snapshot.upcomingDeadlines).toHaveLength(1);
  });

  it('includes system_proactive tasks in pendingProactive', async () => {
    await createWorkItem(db, 'User task', 'medium', { source: 'user' });
    await createWorkItem(db, 'Proactive reminder', 'medium', {
      source: 'system_proactive',
    });
    await createWorkItem(db, 'Discovery hit', 'high', { source: 'discovery_loop' });

    const handler = buildSystemStateHandler({ store, db });
    const snapshot = await handler.getSystemState();
    const titles = snapshot.pendingProactive.map((t) => t.title).sort();
    expect(titles).toEqual(['Discovery hit', 'Proactive reminder']);
  });
});
