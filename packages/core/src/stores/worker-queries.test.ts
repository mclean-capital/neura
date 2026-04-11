/**
 * Tests for worker-queries.ts — CRUD + recovery sweep against a real
 * in-memory PGlite instance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { WorkerTask } from '@neura/types';
import { runMigrations } from './migrations.js';
import {
  createWorker,
  updateWorker,
  getWorker,
  listWorkers,
  sweepCrashedWorkers,
  deleteWorker,
  recordSkillUsage,
  listSkillUsage,
} from './worker-queries.js';

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create('memory://', { extensions: { vector } });
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
});

function makeTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    taskType: 'execute_skill',
    skillName: 'red-test-triage',
    description: 'triage failing tests',
    ...overrides,
  };
}

describe('createWorker / getWorker', () => {
  it('inserts a row in spawning state and returns its id', async () => {
    const workerId = await createWorker(db, makeTask());
    expect(workerId).toBeTruthy();
    expect(typeof workerId).toBe('string');

    const row = await getWorker(db, workerId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('spawning');
    expect(row?.taskType).toBe('execute_skill');
    expect(row?.taskSpec.skillName).toBe('red-test-triage');
    expect(row?.sessionFile).toBeNull();
    expect(row?.result).toBeNull();
  });

  it('returns null for unknown ids', async () => {
    const row = await getWorker(db, '00000000-0000-0000-0000-000000000000');
    expect(row).toBeNull();
  });
});

describe('updateWorker', () => {
  it('transitions status and bumps last_progress_at', async () => {
    const workerId = await createWorker(db, makeTask());
    const before = await getWorker(db, workerId);
    // Wait a millisecond so the timestamp comparison is meaningful.
    await new Promise((r) => setTimeout(r, 5));
    await updateWorker(db, workerId, { status: 'running' });
    const after = await getWorker(db, workerId);

    expect(after?.status).toBe('running');
    expect(new Date(after!.lastProgressAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.lastProgressAt).getTime()
    );
  });

  it('persists session_file and session_id after dispatch', async () => {
    const workerId = await createWorker(db, makeTask());
    await updateWorker(db, workerId, {
      status: 'running',
      sessionId: 'sess-123',
      sessionFile: '/tmp/sessions/abc.jsonl',
    });
    const row = await getWorker(db, workerId);
    expect(row?.sessionId).toBe('sess-123');
    expect(row?.sessionFile).toBe('/tmp/sessions/abc.jsonl');
  });

  it('writes result payload on completion', async () => {
    const workerId = await createWorker(db, makeTask());
    await updateWorker(db, workerId, {
      status: 'completed',
      result: { status: 'completed', output: 'created task wk-1' },
    });
    const row = await getWorker(db, workerId);
    expect(row?.status).toBe('completed');
    expect(row?.result).toEqual({ status: 'completed', output: 'created task wk-1' });
  });

  it('writes error payload on failure', async () => {
    const workerId = await createWorker(db, makeTask());
    await updateWorker(db, workerId, {
      status: 'failed',
      error: { reason: 'llm_exhausted', detail: 'max retries' },
    });
    const row = await getWorker(db, workerId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toEqual({ reason: 'llm_exhausted', detail: 'max retries' });
  });

  it('is a no-op when no fields are supplied', async () => {
    const workerId = await createWorker(db, makeTask());
    await updateWorker(db, workerId, {});
    const row = await getWorker(db, workerId);
    expect(row?.status).toBe('spawning');
  });
});

describe('listWorkers', () => {
  it('returns all rows sorted by last_progress_at desc', async () => {
    const id1 = await createWorker(db, makeTask({ description: 'first' }));
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await createWorker(db, makeTask({ description: 'second' }));

    const list = await listWorkers(db);
    expect(list).toHaveLength(2);
    // Most recent first.
    expect(list[0]?.workerId).toBe(id2);
    expect(list[1]?.workerId).toBe(id1);
  });

  it('filters by single status', async () => {
    const running = await createWorker(db, makeTask());
    await updateWorker(db, running, { status: 'running' });
    const idle = await createWorker(db, makeTask());
    await updateWorker(db, idle, { status: 'idle_partial' });

    const runningOnly = await listWorkers(db, { status: 'running' });
    expect(runningOnly).toHaveLength(1);
    expect(runningOnly[0]?.workerId).toBe(running);
  });

  it('filters by multiple statuses', async () => {
    const running = await createWorker(db, makeTask());
    await updateWorker(db, running, { status: 'running' });
    const blocked = await createWorker(db, makeTask());
    await updateWorker(db, blocked, { status: 'blocked_clarifying' });
    const done = await createWorker(db, makeTask());
    await updateWorker(db, done, { status: 'completed' });

    const active = await listWorkers(db, {
      status: ['running', 'blocked_clarifying'],
    });
    expect(active.map((r) => r.workerId).sort()).toEqual([running, blocked].sort());
  });
});

describe('sweepCrashedWorkers', () => {
  it('marks spawning/running/blocked_clarifying as crashed (terminal)', async () => {
    const spawning = await createWorker(db, makeTask()); // stays in spawning
    const running = await createWorker(db, makeTask());
    await updateWorker(db, running, { status: 'running' });
    const blocked = await createWorker(db, makeTask());
    await updateWorker(db, blocked, { status: 'blocked_clarifying' });

    const result = await sweepCrashedWorkers(db, () => true);

    expect(result.markedCrashedMidRun).toBe(3);
    for (const id of [spawning, running, blocked]) {
      const row = await getWorker(db, id);
      expect(row?.status).toBe('crashed');
      expect(row?.error?.reason).toBe('core_restarted');
    }
  });

  it('preserves idle_partial rows whose session_file still exists', async () => {
    const idleId = await createWorker(db, makeTask());
    await updateWorker(db, idleId, {
      status: 'idle_partial',
      sessionFile: '/tmp/sessions/clean.jsonl',
    });

    const result = await sweepCrashedWorkers(db, (path) => path === '/tmp/sessions/clean.jsonl');
    expect(result.resumable).toBe(1);
    expect(result.markedCrashedMissingFile).toBe(0);

    const row = await getWorker(db, idleId);
    expect(row?.status).toBe('idle_partial');
    expect(row?.sessionFile).toBe('/tmp/sessions/clean.jsonl');
  });

  it('marks idle_partial rows with missing session_file as crashed', async () => {
    const idleId = await createWorker(db, makeTask());
    await updateWorker(db, idleId, {
      status: 'idle_partial',
      sessionFile: '/tmp/sessions/missing.jsonl',
    });

    const result = await sweepCrashedWorkers(db, () => false);
    expect(result.markedCrashedMissingFile).toBe(1);
    expect(result.resumable).toBe(0);

    const row = await getWorker(db, idleId);
    expect(row?.status).toBe('crashed');
    expect(row?.error?.reason).toBe('session_file_missing');
  });

  it('marks idle_partial rows with null session_file as crashed', async () => {
    const idleId = await createWorker(db, makeTask());
    await updateWorker(db, idleId, { status: 'idle_partial' });
    // No session_file set.

    const result = await sweepCrashedWorkers(db, () => true);
    expect(result.markedCrashedMissingFile).toBe(1);

    const row = await getWorker(db, idleId);
    expect(row?.status).toBe('crashed');
    expect(row?.error?.reason).toBe('session_file_missing');
  });

  it('leaves terminal states untouched (completed, failed, cancelled, crashed)', async () => {
    const completed = await createWorker(db, makeTask());
    await updateWorker(db, completed, { status: 'completed' });
    const failed = await createWorker(db, makeTask());
    await updateWorker(db, failed, { status: 'failed' });
    const cancelled = await createWorker(db, makeTask());
    await updateWorker(db, cancelled, { status: 'cancelled' });

    await sweepCrashedWorkers(db, () => true);

    expect((await getWorker(db, completed))?.status).toBe('completed');
    expect((await getWorker(db, failed))?.status).toBe('failed');
    expect((await getWorker(db, cancelled))?.status).toBe('cancelled');
  });
});

describe('deleteWorker', () => {
  it('removes a worker row', async () => {
    const workerId = await createWorker(db, makeTask());
    await deleteWorker(db, workerId);
    expect(await getWorker(db, workerId)).toBeNull();
  });
});

describe('skill usage', () => {
  it('records first-use with count 1', async () => {
    await recordSkillUsage(db, 'red-test-triage');
    const list = await listSkillUsage(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.skillName).toBe('red-test-triage');
    expect(list[0]?.useCount).toBe(1);
  });

  it('increments count on subsequent uses via upsert', async () => {
    await recordSkillUsage(db, 'red-test-triage');
    await recordSkillUsage(db, 'red-test-triage');
    await recordSkillUsage(db, 'red-test-triage');
    const list = await listSkillUsage(db);
    expect(list[0]?.useCount).toBe(3);
  });

  it('tracks multiple skills independently, sorted MRU', async () => {
    await recordSkillUsage(db, 'skill-a');
    await new Promise((r) => setTimeout(r, 5));
    await recordSkillUsage(db, 'skill-b');
    await new Promise((r) => setTimeout(r, 5));
    await recordSkillUsage(db, 'skill-a'); // skill-a is now MRU

    const list = await listSkillUsage(db);
    expect(list).toHaveLength(2);
    expect(list[0]?.skillName).toBe('skill-a');
    expect(list[1]?.skillName).toBe('skill-b');
  });
});
