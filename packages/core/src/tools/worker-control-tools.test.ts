/**
 * Tests for worker-control-tools.ts — the Grok-facing pause / resume
 * / cancel tools that route through the WorkerControlHandler.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ToolCallContext, WorkerControlHandler } from './types.js';
import {
  handleWorkerControlTool,
  isWorkerControlTool,
  workerControlToolDefs,
} from './worker-control-tools.js';

function makeCtx(overrides: Partial<WorkerControlHandler> = {}): ToolCallContext {
  const workerControl: WorkerControlHandler = {
    pauseWorker: vi.fn().mockResolvedValue({ paused: true, workerId: 'wk-1' }),
    resumeWorker: vi.fn().mockResolvedValue({ resumed: true, workerId: 'wk-1' }),
    cancelWorker: vi.fn().mockResolvedValue({ cancelled: true, workerId: 'wk-1' }),
    listActive: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  return {
    queryWatcher: vi.fn().mockResolvedValue(''),
    workerControl,
  };
}

describe('workerControlToolDefs', () => {
  it('exposes exactly 4 tools: pause, resume, cancel, list_active', () => {
    const names = workerControlToolDefs.map((d) => d.name).sort();
    expect(names).toEqual([
      'cancel_worker',
      'list_active_workers',
      'pause_worker',
      'resume_worker',
    ]);
  });

  it('every tool has a pushy description teaching the model when to call it', () => {
    for (const def of workerControlToolDefs) {
      expect(def.description.length).toBeGreaterThan(100);
      expect(def.parameters).toBeDefined();
    }
  });
});

describe('isWorkerControlTool', () => {
  it('returns true for every tool in the set', () => {
    for (const def of workerControlToolDefs) {
      expect(isWorkerControlTool(def.name)).toBe(true);
    }
  });

  it('returns false for tools in other groups', () => {
    expect(isWorkerControlTool('remember_fact')).toBe(false);
    expect(isWorkerControlTool('list_skills')).toBe(false);
  });
});

describe('handleWorkerControlTool', () => {
  it('returns null for tools outside the control set', async () => {
    const result = await handleWorkerControlTool('list_skills', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('returns error when workerControl is not available', async () => {
    const ctx: ToolCallContext = {
      queryWatcher: vi.fn().mockResolvedValue(''),
    };
    const result = await handleWorkerControlTool('pause_worker', {}, ctx);
    expect(result).toEqual({ error: 'Worker control not available' });
  });

  describe('pause_worker', () => {
    it('calls pauseWorker with no workerId when args.worker_id is omitted', async () => {
      const pauseMock = vi.fn().mockResolvedValue({ paused: true, workerId: 'wk-42' });
      const ctx = makeCtx({ pauseWorker: pauseMock });
      const result = await handleWorkerControlTool('pause_worker', {}, ctx);
      expect(pauseMock).toHaveBeenCalledWith(undefined);
      // workerId is deliberately stripped from the voice-facing result
      // so the TTS doesn't narrate UUIDs. Internal handler still gets
      // the id via the "most recent" resolution inside pauseWorker.
      expect(result).toEqual({
        result: { paused: true },
      });
    });

    it('forwards an explicit worker_id', async () => {
      const pauseMock = vi.fn().mockResolvedValue({ paused: true, workerId: 'wk-99' });
      const ctx = makeCtx({ pauseWorker: pauseMock });
      await handleWorkerControlTool('pause_worker', { worker_id: 'wk-99' }, ctx);
      expect(pauseMock).toHaveBeenCalledWith('wk-99');
    });
  });

  describe('resume_worker', () => {
    it('forwards both worker_id and optional message', async () => {
      const resumeMock = vi.fn().mockResolvedValue({ resumed: true, workerId: 'wk-1' });
      const ctx = makeCtx({ resumeWorker: resumeMock });
      await handleWorkerControlTool(
        'resume_worker',
        { worker_id: 'wk-1', message: "I'm back" },
        ctx
      );
      expect(resumeMock).toHaveBeenCalledWith('wk-1', "I'm back");
    });

    it('omits message when not provided', async () => {
      const resumeMock = vi.fn().mockResolvedValue({ resumed: true, workerId: 'wk-1' });
      const ctx = makeCtx({ resumeWorker: resumeMock });
      await handleWorkerControlTool('resume_worker', {}, ctx);
      expect(resumeMock).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('cancel_worker', () => {
    it('forwards worker_id to cancelWorker', async () => {
      const cancelMock = vi.fn().mockResolvedValue({ cancelled: true, workerId: 'wk-1' });
      const ctx = makeCtx({ cancelWorker: cancelMock });
      await handleWorkerControlTool('cancel_worker', { worker_id: 'wk-1' }, ctx);
      expect(cancelMock).toHaveBeenCalledWith('wk-1');
    });
  });

  describe('list_active_workers', () => {
    it('returns the list wrapped in count + workers, without workerIds', async () => {
      const listMock = vi.fn().mockResolvedValue([
        {
          workerId: 'wk-1',
          status: 'running',
          skillName: 'red-test-triage',
          startedAt: '2026-04-11T00:00:00Z',
        },
      ]);
      const ctx = makeCtx({ listActive: listMock });
      const result = await handleWorkerControlTool('list_active_workers', {}, ctx);
      // workerId is intentionally omitted from the voice-facing list —
      // the TTS would otherwise read "w k one" letter by letter.
      // pause/resume/cancel default to "most recent" so the voice flow
      // never needs the id.
      expect(result).toEqual({
        result: {
          count: 1,
          workers: [
            {
              status: 'running',
              skillName: 'red-test-triage',
              startedAt: '2026-04-11T00:00:00Z',
            },
          ],
        },
      });
    });
  });

  describe('error propagation', () => {
    it('converts thrown handler errors into a tool error result', async () => {
      const pauseMock = vi.fn().mockRejectedValue(new Error('runtime dead'));
      const ctx = makeCtx({ pauseWorker: pauseMock });
      const result = await handleWorkerControlTool('pause_worker', {}, ctx);
      expect(result).toBeDefined();
      expect((result as { error: string }).error).toContain('runtime dead');
    });
  });
});
