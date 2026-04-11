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
import { AgentWorker } from './agent-worker.js';
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

  const dispatchMock: Mock = vi.fn((task: WorkerTask, callbacks: WorkerCallbacks) => {
    let resolveDone!: (result: WorkerResult) => void;
    const done = new Promise<WorkerResult>((resolve) => {
      resolveDone = resolve;
    });
    const handle: WorkerHandle = {
      workerId: `runtime-${dispatched.length}`,
      sessionId: `sess-${dispatched.length}`,
      sessionFile: `/tmp/sess-${dispatched.length}.jsonl`,
      done,
    };
    dispatched.push({ task, callbacks, resolveDone, handle });
    return Promise.resolve(handle);
  });

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
