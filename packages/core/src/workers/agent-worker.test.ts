/**
 * Tests for agent-worker.ts.
 *
 * Uses an in-memory PGlite for real worker-queries writes, plus a mock
 * `WorkerRuntime` so we can drive dispatch/resume/abort behavior without
 * needing a real pi session. `PiRuntime` itself is covered by the
 * integration spikes (#4c, #4d, #4e) plus the coverage that its
 * dependencies (neura-tools, voice-fanout-bridge, worker-queries,
 * skill-registry) already have.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { WorkerCallbacks, WorkerResult, WorkerStatus, WorkerTask } from '@neura/types';
import { runMigrations } from '../stores/migrations.js';
import { createWorker, getWorker, updateWorker } from '../stores/worker-queries.js';
import { createWorkItem, getWorkItem } from '../stores/work-item-queries.js';
import { AgentWorker, buildCanonicalWorkerPrompt } from './agent-worker.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResumeParams, WorkerHandle, WorkerRuntime } from './worker-runtime.js';

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create('memory://', { extensions: { vector } });
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
});

interface DispatchRecord {
  task: WorkerTask;
  callbacks: WorkerCallbacks;
  resolveDone: (result: WorkerResult) => void;
  handle: WorkerHandle;
}

interface MockRuntimeBundle {
  runtime: WorkerRuntime;
  dispatched: DispatchRecord[];
  resumeCalls: ResumeParams[];
  mocks: {
    dispatch: Mock;
    resume: Mock;
    steer: Mock;
    abort: Mock;
    waitForIdle: Mock;
  };
}

/**
 * Mock runtime that records dispatches and lets tests drive lifecycle
 * via exposed resolvers. Matches the full WorkerRuntime contract.
 */
function makeMockRuntime(): MockRuntimeBundle {
  const dispatched: DispatchRecord[] = [];
  const resumeCalls: ResumeParams[] = [];

  const dispatchMock: Mock = vi.fn(
    (task: WorkerTask, callbacks: WorkerCallbacks, workerId: string) => {
      let resolveDone!: (result: WorkerResult) => void;
      const done = new Promise<WorkerResult>((resolve) => {
        resolveDone = resolve;
      });
      // B1 regression: the runtime must echo the caller-provided
      // workerId back on the handle. Any downstream control-path
      // lookup by workerId uses this same id, so handle.workerId and
      // the id the caller holds MUST match.
      const handle: WorkerHandle = {
        workerId,
        sessionId: `sess-${dispatched.length}`,
        sessionFile: `/tmp/sess-${dispatched.length}.jsonl`,
        done,
      };
      dispatched.push({ task, callbacks, resolveDone, handle });
      return Promise.resolve(handle);
    }
  );

  const resumeMock: Mock = vi.fn((params: ResumeParams) => {
    resumeCalls.push(params);
    let resolveDone!: (result: WorkerResult) => void;
    const done = new Promise<WorkerResult>((resolve) => {
      resolveDone = resolve;
    });
    const handle: WorkerHandle = {
      workerId: params.workerId,
      sessionId: `resumed-${params.workerId}`,
      sessionFile: params.sessionFile,
      done,
    };
    // Auto-resolve resume as completed so tests don't hang.
    queueMicrotask(() => resolveDone({ status: 'completed' }));
    return Promise.resolve(handle);
  });

  const steerMock: Mock = vi.fn().mockResolvedValue(undefined);
  const abortMock: Mock = vi.fn().mockResolvedValue(undefined);
  const waitForIdleMock: Mock = vi.fn().mockResolvedValue(undefined);

  const runtime: WorkerRuntime = {
    dispatch: dispatchMock,
    resume: resumeMock,
    steer: steerMock,
    abort: abortMock,
    waitForIdle: waitForIdleMock,
    hasWorker: vi.fn().mockReturnValue(true),
  };

  return {
    runtime,
    dispatched,
    resumeCalls,
    mocks: {
      dispatch: dispatchMock,
      resume: resumeMock,
      steer: steerMock,
      abort: abortMock,
      waitForIdle: waitForIdleMock,
    },
  };
}

const task = (overrides: Partial<WorkerTask> = {}): WorkerTask => ({
  taskType: 'execute_skill',
  skillName: 'red-test-triage',
  description: 'triage failing tests',
  ...overrides,
});

describe('AgentWorker — dispatch', () => {
  it('creates a workers row and persists runtime session metadata', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    const handle = await worker.dispatch(task());

    // DB row exists, in running state, with session_id/session_file set.
    const row = await getWorker(db, handle.workerId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('running');
    expect(row?.sessionId).toBe('sess-0');
    expect(row?.sessionFile).toBe('/tmp/sess-0.jsonl');
    expect(row?.taskSpec.skillName).toBe('red-test-triage');

    // Runtime was called with the same task.
    expect(bundle.dispatched).toHaveLength(1);
  });

  it('registers the worker with the cancellation coordinator', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    await worker.dispatch(task());
    expect(worker.activeCount).toBe(1);
  });

  it('forwards status transitions to the caller callbacks', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const statusEvents: WorkerStatus[] = [];
    await worker.dispatch(task(), {
      onStatusChange: (s) => statusEvents.push(s),
    });
    // Simulate the runtime firing a status transition.
    bundle.dispatched[0].callbacks.onStatusChange!('running');
    // Give the wrapped callback a tick to propagate.
    await new Promise((r) => setTimeout(r, 5));
    expect(statusEvents).toContain('running');
  });

  it('persists terminal result via onComplete callback', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const handle = await worker.dispatch(task());

    bundle.dispatched[0].callbacks.onComplete!({ status: 'completed', output: 'ok' });
    // Wait for the async persist to resolve.
    await new Promise((r) => setTimeout(r, 20));

    const row = await getWorker(db, handle.workerId);
    expect(row?.status).toBe('completed');
    expect(row?.result).toEqual({ status: 'completed', output: 'ok' });
  });

  it('persists failure with error details', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const handle = await worker.dispatch(task());

    bundle.dispatched[0].callbacks.onComplete!({
      status: 'failed',
      error: { reason: 'llm_exhausted', detail: 'retries' },
    });
    await new Promise((r) => setTimeout(r, 20));

    const row = await getWorker(db, handle.workerId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toEqual({ reason: 'llm_exhausted', detail: 'retries' });
  });

  it('unregisters from cancellation after done resolves', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const handle = await worker.dispatch(task());
    expect(worker.activeCount).toBe(1);

    bundle.dispatched[0].resolveDone({ status: 'completed' });
    await handle.done;
    // Micro-task flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(worker.activeCount).toBe(0);
  });

  it('B1: passes the db-assigned workerId to runtime.dispatch', async () => {
    // Regression for the PR-review blocker: agent-worker must hand the
    // runtime the SAME id the orchestrator holds, so every later
    // steer/cancel/waitForIdle/hasWorker lookup by workerId resolves
    // correctly. Before the fix, the runtime minted its own uuid and
    // keyed the active map under it, then returned a different id to
    // agent-worker, which returned yet another id (the db id) to
    // callers — so every control-path call missed the active map.
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    const handle = await worker.dispatch(task());

    // The runtime received the caller-side id as its third argument.
    const dispatchCall = bundle.mocks.dispatch.mock.calls[0];
    expect(dispatchCall?.[2]).toBe(handle.workerId);
    // And the handle echoed it back (mock runtime enforces this contract).
    expect(bundle.dispatched[0]?.handle.workerId).toBe(handle.workerId);
  });
});

describe('AgentWorker — resume', () => {
  it('throws for unknown worker ids', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    await expect(worker.resume('does-not-exist', 'continue')).rejects.toThrow(/unknown worker/);
  });

  it('throws when the workers row has no session_file', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const workerId = await createWorker(db, task());
    // Note: no sessionFile set.
    await expect(worker.resume(workerId, 'continue')).rejects.toThrow(/no session_file/);
  });

  it('calls runtime.resume with the persisted session_file', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const workerId = await createWorker(db, task());
    await updateWorker(db, workerId, {
      status: 'idle_partial',
      sessionFile: '/tmp/my-session.jsonl',
    });

    await worker.resume(workerId, 'continue the task');

    expect(bundle.resumeCalls).toHaveLength(1);
    expect(bundle.resumeCalls[0]?.sessionFile).toBe('/tmp/my-session.jsonl');
    expect(bundle.resumeCalls[0]?.resumePrompt).toBe('continue the task');
  });
});

describe('AgentWorker — cancel', () => {
  it('calls runtime.abort and marks the row cancelled', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    const handle = await worker.dispatch(task());

    await worker.cancel(handle.workerId);
    expect(bundle.mocks.abort).toHaveBeenCalledWith(handle.workerId);

    const row = await getWorker(db, handle.workerId);
    expect(row?.status).toBe('cancelled');
  });

  it('cancelAll aborts every registered worker', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    await worker.dispatch(task());
    await worker.dispatch(task());
    await worker.dispatch(task());
    expect(worker.activeCount).toBe(3);

    await worker.cancelAll();
    expect(bundle.mocks.abort).toHaveBeenCalledTimes(3);
    expect(worker.activeCount).toBe(0);
  });
});

describe('AgentWorker — recoverFromCrash', () => {
  it('marks stale running workers as crashed', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    // Pre-seed a running worker as if the core just restarted.
    const orphanId = await createWorker(db, task());
    await updateWorker(db, orphanId, { status: 'running' });

    await worker.recoverFromCrash();

    const row = await getWorker(db, orphanId);
    expect(row?.status).toBe('crashed');
    expect(row?.error?.reason).toBe('core_restarted');
  });
});

describe('AgentWorker — steer / waitForIdle', () => {
  it('steer forwards to runtime', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    await worker.steer('worker-1', 'PAUSE');
    expect(bundle.mocks.steer).toHaveBeenCalledWith('worker-1', 'PAUSE');
  });

  it('waitForIdle forwards to runtime', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });
    await worker.waitForIdle('worker-1');
    expect(bundle.mocks.waitForIdle).toHaveBeenCalledWith('worker-1');
  });
});

describe('AgentWorker — getMostRecentPausedWorker (C1)', () => {
  // Regression for PR-review concern C1: `resume_worker` without an
  // explicit id must land on a paused (`idle_partial`) worker, not
  // whichever non-terminal worker is most recent. Before the fix, a
  // running worker could be ahead of a paused one in the ordering
  // and `resume_worker` would try to reopen a live session or fail
  // with "no session_file".

  it('returns null when no workers are paused', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    // A running worker exists but none are paused.
    const runningId = await createWorker(db, task());
    await updateWorker(db, runningId, { status: 'running' });

    const paused = await worker.getMostRecentPausedWorker();
    expect(paused).toBeNull();
  });

  it('skips running workers and picks the most recent idle_partial', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    // Two workers: one running (most recent overall), one paused.
    const pausedId = await createWorker(db, task({ skillName: 'paused-skill' }));
    await updateWorker(db, pausedId, {
      status: 'idle_partial',
      sessionFile: '/tmp/paused.jsonl',
    });

    const runningId = await createWorker(db, task({ skillName: 'running-skill' }));
    await updateWorker(db, runningId, { status: 'running' });

    // getMostRecentActiveWorker returns any non-terminal — likely the
    // running one (newer). getMostRecentPausedWorker must skip it and
    // return the paused one regardless of recency ordering.
    const paused = await worker.getMostRecentPausedWorker();
    expect(paused?.workerId).toBe(pausedId);
    expect(paused?.status).toBe('idle_partial');
  });

  it('picks the most recent idle_partial when multiple are paused', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    const firstId = await createWorker(db, task({ skillName: 'first' }));
    await updateWorker(db, firstId, {
      status: 'idle_partial',
      sessionFile: '/tmp/first.jsonl',
    });

    // Small delay so the second worker has a strictly later startedAt.
    await new Promise((r) => setTimeout(r, 10));

    const secondId = await createWorker(db, task({ skillName: 'second' }));
    await updateWorker(db, secondId, {
      status: 'idle_partial',
      sessionFile: '/tmp/second.jsonl',
    });

    const paused = await worker.getMostRecentPausedWorker();
    expect(paused?.workerId).toBe(secondId);
  });
});

describe('AgentWorker — dispatchForTask (Phase 6b)', () => {
  let worktreeBase: string;

  beforeEach(() => {
    worktreeBase = mkdtempSync(join(tmpdir(), 'neura-wt-'));
  });

  afterEach(() => {
    if (existsSync(worktreeBase)) {
      rmSync(worktreeBase, { recursive: true, force: true });
    }
  });

  it('creates a worktree dir, links worker to task, and sets status=in_progress', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });

    const taskId = await createWorkItem(db, 'Ship phase 6b', 'high', {
      goal: 'Land Wave 3 Pass 2',
      context: {
        acceptanceCriteria: ['tests green', 'no regressions'],
        constraints: ['no schema changes'],
      },
    });

    const handle = await worker.dispatchForTask(taskId);

    // Worker row was created and linked.
    const row = await getWorker(db, handle.workerId);
    expect(row?.status).toBe('running');

    // Worktree dir exists under the configured base.
    const worktreePath = join(worktreeBase, handle.workerId);
    expect(existsSync(worktreePath)).toBe(true);

    // Task row has worker_id + status=in_progress mirrored.
    const taskRow = await getWorkItem(db, taskId);
    expect(taskRow?.workerId).toBe(handle.workerId);
    expect(taskRow?.status).toBe('in_progress');

    // Runtime was called with a cwd that points at the worktree.
    expect(bundle.dispatched).toHaveLength(1);
    expect(bundle.dispatched[0].task.cwd).toBe(worktreePath);
    expect(bundle.dispatched[0].task.taskId).toBe(taskId);
  });

  it('throws when the task id does not exist', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    await expect(worker.dispatchForTask('missing-task')).rejects.toThrow(/unknown task/);
  });

  it('writes worker_id to the task BEFORE runtime.dispatch is called (race fix)', async () => {
    // Regression guard for review finding #2: ordering of updateWorkItem
    // and runtime.dispatch. The worker's first tool call can arrive the
    // instant session.prompt() kicks off; if work_items.worker_id was
    // still null at that moment, the invariant layer's cross-task-write
    // guard would reject the update. Task row must carry worker_id at
    // the moment `runtime.dispatch` is called.
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const taskId = await createWorkItem(db, 'Race check', 'medium', {});
    // Spy into the dispatch mock: the default implementation records the
    // call and pushes onto `bundle.dispatched`. We capture the task row
    // at the exact moment the mock was invoked, inside a wrapper.
    const origDispatch = bundle.runtime.dispatch.bind(bundle.runtime);
    let taskWorkerIdAtDispatch: string | null | undefined;
    bundle.runtime.dispatch = async (t, cb, workerId) => {
      const row = await getWorkItem(db, taskId);
      taskWorkerIdAtDispatch = row?.workerId ?? null;
      return origDispatch(t, cb, workerId);
    };
    await worker.dispatchForTask(taskId);
    expect(taskWorkerIdAtDispatch).toBeTruthy();
    // And it should match the workerId the dispatch was called with.
    expect(taskWorkerIdAtDispatch).toBe(bundle.dispatched[0].handle.workerId);
  });

  it('refuses to redispatch a terminal task', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const { updateWorkItem: uwi } = await import('../stores/work-item-queries.js');
    const taskId = await createWorkItem(db, 'done task', 'medium', {});
    await uwi(db, taskId, { status: 'done' });
    await expect(worker.dispatchForTask(taskId)).rejects.toThrow(/terminal/);
  });

  it('refuses to redispatch a task with a live worker', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const { updateWorkItem: uwi } = await import('../stores/work-item-queries.js');
    const taskId = await createWorkItem(db, 'live task', 'medium', {});
    // Seed a live worker row and link it to the task.
    const prior = await createWorker(db, task());
    await updateWorker(db, prior, { status: 'running' });
    await uwi(db, taskId, { status: 'in_progress', workerId: prior });
    await expect(worker.dispatchForTask(taskId)).rejects.toThrow(/already has live worker/);
  });

  it('mirrors failed worker status back onto the task', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const taskId = await createWorkItem(db, 'work it', 'medium', {});
    await worker.dispatchForTask(taskId);
    // Fire the runtime's onComplete with a failed result.
    bundle.dispatched[0].callbacks.onComplete!({
      status: 'failed',
      error: { reason: 'boom' },
    });
    await new Promise((r) => setTimeout(r, 30));

    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('failed');
  });

  it('does NOT overwrite a worker-set `done` status on completion', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const taskId = await createWorkItem(db, 'finish me', 'medium', {});
    await worker.dispatchForTask(taskId);

    // Simulate the worker's `complete_task` having already transitioned
    // the row to `done` via applyTaskUpdate.
    const { updateWorkItem: uwi } = await import('../stores/work-item-queries.js');
    await uwi(db, taskId, { status: 'done' });

    // Runtime now emits completion. Mirror path should be a no-op.
    bundle.dispatched[0].callbacks.onComplete!({ status: 'completed' });
    await new Promise((r) => setTimeout(r, 30));

    const row = await getWorkItem(db, taskId);
    expect(row?.status).toBe('done'); // still `done`, not overwritten
  });

  it('refreshes task.leaseExpiresAt when the runtime fires onAlive (no heartbeat needed)', async () => {
    // The runtime observes pi events (turn_start, tool_execution_*, etc.)
    // and fires `callbacks.onAlive` throttled. The dispatcher must bump
    // work_items.leaseExpiresAt in response so crash-recovery knows the
    // worker is alive — without this the lease could expire during long
    // tool calls and trip the crash sweep falsely.
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const taskId = await createWorkItem(db, 'Lease refresh', 'medium', {});
    await worker.dispatchForTask(taskId);

    const before = await getWorkItem(db, taskId);
    expect(before?.leaseExpiresAt).toBeNull();

    // Fire onAlive as pi would.
    bundle.dispatched[0].callbacks.onAlive!();
    await new Promise((r) => setTimeout(r, 30));

    const after = await getWorkItem(db, taskId);
    expect(after?.leaseExpiresAt).toBeTruthy();
    expect(Date.parse(after!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it('skips lease refresh on terminal tasks (trailing pi events must not bump done rows)', async () => {
    // Pi emits agent_end / tool_execution_end after the worker has
    // already called complete_task. Without the terminal-state guard
    // those trailing events would rewrite leaseExpiresAt on a `done`
    // row, inflating version and triggering spurious expect_version
    // conflicts on the orchestrator's next edit.
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const taskId = await createWorkItem(db, 'Terminal guard', 'medium', {});
    await worker.dispatchForTask(taskId);

    // Transition the task to `done` via the worker-protocol path.
    const { updateWorkItem: uwi } = await import('../stores/work-item-queries.js');
    await uwi(db, taskId, { status: 'done' });

    const before = await getWorkItem(db, taskId);
    const versionBefore = before!.version;
    expect(before?.status).toBe('done');

    // A stray onAlive from pi now should be a no-op.
    bundle.dispatched[0].callbacks.onAlive!();
    await new Promise((r) => setTimeout(r, 30));

    const after = await getWorkItem(db, taskId);
    expect(after?.leaseExpiresAt).toBeNull();
    expect(after?.version).toBe(versionBefore);
  });

  it('wires onAlive on the resume path so resumed workers still refresh lease', async () => {
    // Resume is a separate code path from dispatchForTask. Without
    // explicit wiring, a paused-then-resumed worker would run without
    // bumping leaseExpiresAt — latent bug that would bite the moment
    // crash-recovery starts honoring the lease.
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({
      db,
      runtime: bundle.runtime,
      worktreeBasePath: worktreeBase,
    });
    const taskId = await createWorkItem(db, 'Resume path', 'medium', {});
    const dispatched = await worker.dispatchForTask(taskId);

    // Simulate pause: session_file is on the worker row after dispatch.
    await worker.resume(dispatched.workerId, 'continue');

    // Resume uses the most recent dispatch record (the resume mock
    // fires onComplete immediately, so look at the resume call
    // directly) — in practice, pi's event stream bumps the lease
    // through the new wrapped onAlive. Assert by firing onAlive from
    // the resume wrapper.
    const resumeRecord = bundle.resumeCalls[0];
    expect(resumeRecord).toBeTruthy();
    resumeRecord.callbacks.onAlive!();
    await new Promise((r) => setTimeout(r, 30));

    const after = await getWorkItem(db, taskId);
    expect(after?.leaseExpiresAt).toBeTruthy();
  });
});

describe('buildCanonicalWorkerPrompt', () => {
  it('includes goal, acceptance criteria, and task id', () => {
    const prompt = buildCanonicalWorkerPrompt({
      id: 'task-xyz',
      title: 'Do the thing',
      description: null,
      status: 'pending',
      priority: 'medium',
      dueAt: null,
      parentId: null,
      sourceSessionId: null,
      createdAt: '',
      updatedAt: '',
      completedAt: null,
      goal: 'thing is done',
      context: {
        acceptanceCriteria: ['test A', 'test B'],
        constraints: ['no side effects'],
        references: ['https://example.com'],
      },
      relatedSkills: ['how-to-thing'],
      repoPath: null,
      baseBranch: null,
      workerId: null,
      source: 'user',
      version: 0,
      leaseExpiresAt: null,
    });
    expect(prompt).toContain('Do the thing');
    expect(prompt).toContain('thing is done');
    expect(prompt).toContain('test A');
    expect(prompt).toContain('no side effects');
    expect(prompt).toContain('how-to-thing');
    expect(prompt).toContain('task-xyz');
  });
});

describe('AgentWorker — setStatus (C2)', () => {
  // Regression for PR-review concern C2: the clarification bridge
  // was constructed without onBlock/onUnblock wiring, so workers
  // waiting on a user clarification stayed marked `running` and
  // `list_active_workers` couldn't distinguish them from
  // freshly-dispatched workers. The fix adds `AgentWorker.setStatus`
  // as the wiring point — the bridge calls it via closure. This
  // test pins the setStatus half; the clarification-bridge unit tests
  // already cover that onBlock/onUnblock fire at the right moments.

  it('writes the given status to the workers table', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    const workerId = await createWorker(db, task());
    await worker.setStatus(workerId, 'blocked_clarifying');

    const row = await getWorker(db, workerId);
    expect(row?.status).toBe('blocked_clarifying');
  });

  it('round-trips blocked_clarifying → running via successive setStatus calls', async () => {
    const bundle = makeMockRuntime();
    const worker = new AgentWorker({ db, runtime: bundle.runtime });

    const workerId = await createWorker(db, task());
    await updateWorker(db, workerId, { status: 'running' });

    // onBlock would fire here in production.
    await worker.setStatus(workerId, 'blocked_clarifying');
    expect((await getWorker(db, workerId))?.status).toBe('blocked_clarifying');

    // onUnblock would fire here in production.
    await worker.setStatus(workerId, 'running');
    expect((await getWorker(db, workerId))?.status).toBe('running');
  });
});
