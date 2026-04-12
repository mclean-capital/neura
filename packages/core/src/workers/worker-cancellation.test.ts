/**
 * Tests for worker-cancellation.ts.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { WorkerRuntime } from './worker-runtime.js';
import { WorkerCancellation } from './worker-cancellation.js';

interface MockRuntimeBundle {
  runtime: WorkerRuntime;
  abortMock: Mock;
}

function makeRuntime(): MockRuntimeBundle {
  const abortMock: Mock = vi.fn().mockResolvedValue(undefined);
  const runtime: WorkerRuntime = {
    dispatch: vi.fn(),
    resume: vi.fn(),
    steer: vi.fn(),
    abort: abortMock,
    waitForIdle: vi.fn(),
    hasWorker: vi.fn().mockReturnValue(true),
  };
  return { runtime, abortMock };
}

describe('WorkerCancellation', () => {
  let bundle: MockRuntimeBundle;
  let wc: WorkerCancellation;

  beforeEach(() => {
    bundle = makeRuntime();
    wc = new WorkerCancellation({ runtime: bundle.runtime });
  });

  it('starts with zero active workers', () => {
    expect(wc.activeCount).toBe(0);
  });

  it('register increments the active set', () => {
    wc.register('worker-1');
    wc.register('worker-2');
    expect(wc.activeCount).toBe(2);
  });

  it('unregister removes from the active set', () => {
    wc.register('worker-1');
    wc.unregister('worker-1');
    expect(wc.activeCount).toBe(0);
  });

  it('cancel calls runtime.abort with the worker id', async () => {
    wc.register('worker-1');
    await wc.cancel('worker-1');
    expect(bundle.abortMock).toHaveBeenCalledWith('worker-1');
    expect(wc.activeCount).toBe(0);
  });

  it('cancel fires onWorkerAborted callback after abort', async () => {
    const abortedIds: string[] = [];
    const wc2 = new WorkerCancellation({
      runtime: bundle.runtime,
      onWorkerAborted: (id) => {
        abortedIds.push(id);
      },
    });
    wc2.register('worker-1');
    await wc2.cancel('worker-1');
    expect(abortedIds).toEqual(['worker-1']);
  });

  it('cancel is safe on unknown worker ids (idempotent)', async () => {
    await expect(wc.cancel('does-not-exist')).resolves.toBeUndefined();
  });

  it('cancelAll aborts every registered worker', async () => {
    wc.register('worker-1');
    wc.register('worker-2');
    wc.register('worker-3');
    await wc.cancelAll();
    expect(bundle.abortMock).toHaveBeenCalledTimes(3);
    expect(wc.activeCount).toBe(0);
  });

  it('cancelAll swallows runtime.abort errors and continues', async () => {
    const failingBundle = makeRuntime();
    const failingAbort: Mock = vi.fn().mockImplementation((id: string) => {
      if (id === 'worker-2') return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });
    failingBundle.runtime.abort = failingAbort;
    const wc2 = new WorkerCancellation({ runtime: failingBundle.runtime });
    wc2.register('worker-1');
    wc2.register('worker-2');
    wc2.register('worker-3');
    await expect(wc2.cancelAll()).resolves.toBeUndefined();
    expect(wc2.activeCount).toBe(0);
  });

  it('swallows onWorkerAborted callback errors', async () => {
    const wc2 = new WorkerCancellation({
      runtime: bundle.runtime,
      onWorkerAborted: () => {
        throw new Error('callback boom');
      },
    });
    wc2.register('worker-1');
    await expect(wc2.cancel('worker-1')).resolves.toBeUndefined();
  });
});
