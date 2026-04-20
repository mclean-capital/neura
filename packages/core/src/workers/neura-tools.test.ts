/**
 * Tests for neura-tools.ts.
 *
 * Focus: the adapter layer correctly shuttles calls between pi's
 * `AgentTool` shape and Neura's existing tool handlers, converts results,
 * and propagates errors via `throw` (pi's contract).
 *
 * We do NOT re-test the underlying Neura tool logic here — that's covered
 * by tool-router.test.ts and the existing tool-specific tests. The mocks
 * are minimal handlers that let us assert the adapter's shape conversion.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ToolCallContext } from '../tools/types.js';
import { buildNeuraTools, NEURA_TOOL_NAMES, type NeuraAgentTool } from './neura-tools.js';

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    queryWatcher: vi.fn().mockResolvedValue('a brief description'),
    memoryTools: {
      storeFact: vi.fn().mockResolvedValue('fact-1'),
      recall: vi.fn().mockResolvedValue([{ content: 'hello', category: 'general', tags: ['a'] }]),
      storePreference: vi.fn().mockResolvedValue(undefined),
      invalidateFact: vi.fn().mockResolvedValue('fact-1'),
      getTimeline: vi.fn().mockResolvedValue([]),
      getMemoryStats: vi.fn().mockResolvedValue({ totalFacts: 1 }),
    },
    taskTools: {
      createTask: vi.fn().mockResolvedValue('task-1'),
      listTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockResolvedValue(null),
      listTaskComments: vi.fn().mockResolvedValue([]),
      getWorkerSessionFile: vi.fn().mockResolvedValue(null),
      updateTask: vi.fn().mockResolvedValue(true),
      deleteTask: vi.fn().mockResolvedValue(true),
    },
    enterMode: vi.fn(),
    ...overrides,
  };
}

function getTool(tools: NeuraAgentTool[], name: string): NeuraAgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found in build output`);
  return t;
}

describe('buildNeuraTools', () => {
  it('returns a tool for every name in NEURA_TOOL_NAMES', () => {
    const tools = buildNeuraTools(makeCtx());
    const built = new Set(tools.map((t) => t.name));
    for (const name of NEURA_TOOL_NAMES) {
      expect(built.has(name)).toBe(true);
    }
    expect(tools.length).toBe(NEURA_TOOL_NAMES.length);
  });

  it('every tool has label + description + parameters + execute', () => {
    const tools = buildNeuraTools(makeCtx());
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.parameters).toBeDefined();
      expect(typeof t.execute).toBe('function');
    }
  });
});

describe('workers do not get vision tools', () => {
  // Vision (describe_screen, describe_camera) is deliberately excluded
  // from the worker tool set — it's an orchestrator concern. See the
  // file header comment in neura-tools.ts for the rationale.
  it('buildNeuraTools omits describe_screen', () => {
    const tools = buildNeuraTools(makeCtx());
    expect(tools.find((t) => t.name === 'describe_screen')).toBeUndefined();
  });

  it('buildNeuraTools omits describe_camera', () => {
    const tools = buildNeuraTools(makeCtx());
    expect(tools.find((t) => t.name === 'describe_camera')).toBeUndefined();
  });

  it('NEURA_TOOL_NAMES does not include vision tool names', () => {
    expect(NEURA_TOOL_NAMES).not.toContain('describe_screen');
    expect(NEURA_TOOL_NAMES).not.toContain('describe_camera');
  });
});

describe('time adapter', () => {
  it('get_current_time returns a structured time object', async () => {
    const tool = getTool(buildNeuraTools(makeCtx()), 'get_current_time');
    const result = await tool.execute('call-1', {});
    expect(result.content[0]?.type).toBe('text');
    // Details should be the raw object with time / date / timezone keys.
    const details = result.details as { time: string; date: string; timezone: string };
    expect(details.time).toBeTruthy();
    expect(details.date).toBeTruthy();
    expect(details.timezone).toBeTruthy();
  });
});

describe('memory adapter', () => {
  it('remember_fact calls storeFact and returns structured success', async () => {
    const storeFact = vi.fn().mockResolvedValue('fact-1');
    const ctx = makeCtx({
      memoryTools: {
        storeFact,
        recall: vi.fn(),
        storePreference: vi.fn(),
        invalidateFact: vi.fn(),
        getTimeline: vi.fn(),
        getMemoryStats: vi.fn(),
      },
    });
    const tool = getTool(buildNeuraTools(ctx), 'remember_fact');
    const result = await tool.execute('call-1', {
      content: 'user likes tea',
      category: 'personal',
      tags: 'drinks,preferences',
    });
    expect(storeFact).toHaveBeenCalledWith('user likes tea', 'personal', ['drinks', 'preferences']);
    expect((result.details as { stored: boolean; id: string }).stored).toBe(true);
  });

  it('recall_memory returns facts from the handler', async () => {
    const recall = vi
      .fn()
      .mockResolvedValue([{ content: 'hello', category: 'general', tags: ['a'] }]);
    const ctx = makeCtx({
      memoryTools: {
        storeFact: vi.fn(),
        recall,
        storePreference: vi.fn(),
        invalidateFact: vi.fn(),
        getTimeline: vi.fn(),
        getMemoryStats: vi.fn(),
      },
    });
    const tool = getTool(buildNeuraTools(ctx), 'recall_memory');
    const result = await tool.execute('call-1', { query: 'tea' });
    expect(recall).toHaveBeenCalledWith('tea');
    const details = result.details as { facts: { content: string }[] };
    expect(details.facts[0]?.content).toBe('hello');
  });

  it('returns an error tool result when memoryTools is not provided', async () => {
    const ctx = makeCtx({ memoryTools: undefined });
    const tool = getTool(buildNeuraTools(ctx), 'remember_fact');
    await expect(tool.execute('call-1', { content: 'x' })).rejects.toThrow(
      /Memory system not available/
    );
  });
});

describe('task adapter', () => {
  it('create_task forwards title and options', async () => {
    const createTask = vi.fn().mockResolvedValue('task-1');
    const ctx = makeCtx({
      taskTools: {
        createTask,
        listTasks: vi.fn(),
        getTask: vi.fn(),
        listTaskComments: vi.fn().mockResolvedValue([]),
        getWorkerSessionFile: vi.fn().mockResolvedValue(null),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
      },
    });
    const tool = getTool(buildNeuraTools(ctx), 'create_task');
    await tool.execute('call-1', {
      title: 'Ship phase 6',
      priority: 'high',
      description: 'the big one',
    });
    expect(createTask).toHaveBeenCalledWith(
      'Ship phase 6',
      'high',
      expect.objectContaining({ description: 'the big one' })
    );
  });

  it('list_tasks forwards status filter', async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      taskTools: {
        createTask: vi.fn(),
        listTasks,
        getTask: vi.fn(),
        listTaskComments: vi.fn().mockResolvedValue([]),
        getWorkerSessionFile: vi.fn().mockResolvedValue(null),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
      },
    });
    const tool = getTool(buildNeuraTools(ctx), 'list_tasks');
    await tool.execute('call-1', { status: 'pending' });
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
  });
});

describe('presence adapter', () => {
  it('enter_mode triggers the context callback after the current turn', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeCtx();
      const tool = getTool(buildNeuraTools(ctx), 'enter_mode');
      const result = await tool.execute('call-1', { mode: 'passive' });
      expect(result.details).toMatchObject({ mode: 'passive', transitioned: true });
      // The callback is deferred via setTimeout(..., 0) so the tool result
      // can flow back to the voice provider before the session tears down.
      expect(ctx.enterMode).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(ctx.enterMode).toHaveBeenCalledWith('passive');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('error propagation', () => {
  it('throws when the underlying handler returns an error (pi contract)', async () => {
    const ctx = makeCtx({
      taskTools: {
        createTask: vi.fn().mockRejectedValue(new Error('db offline')),
        listTasks: vi.fn(),
        getTask: vi.fn(),
        listTaskComments: vi.fn().mockResolvedValue([]),
        getWorkerSessionFile: vi.fn().mockResolvedValue(null),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
      },
    });
    const tool = getTool(buildNeuraTools(ctx), 'create_task');
    await expect(tool.execute('call-1', { title: 'x' })).rejects.toThrow(/db offline/);
  });
});
