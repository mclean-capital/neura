import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolDefs, handleToolCall, type ToolCallContext } from './tools.js';

describe('toolDefs', () => {
  it('defines exactly 15 tools', () => {
    expect(toolDefs).toHaveLength(15);
  });

  it('each tool has the required structure', () => {
    for (const tool of toolDefs) {
      expect(tool.type).toBe('function');
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters.type).toBe('object');
    }
  });

  it('contains the expected tool names', () => {
    const names = toolDefs.map((t) => t.name);
    expect(names).toContain('describe_camera');
    expect(names).toContain('describe_screen');
    expect(names).toContain('get_current_time');
    expect(names).toContain('remember_fact');
    expect(names).toContain('recall_memory');
    expect(names).toContain('update_preference');
    expect(names).toContain('enter_mode');
    expect(names).toContain('create_task');
    expect(names).toContain('list_tasks');
    expect(names).toContain('get_task');
    expect(names).toContain('update_task');
    expect(names).toContain('delete_task');
    expect(names).toContain('invalidate_fact');
    expect(names).toContain('get_timeline');
    expect(names).toContain('memory_stats');
  });
});

describe('handleToolCall', () => {
  const queryWatcher = vi.fn((_prompt: string, _source: 'camera' | 'screen') =>
    Promise.resolve('')
  );

  const ctx: ToolCallContext = { queryWatcher };

  beforeEach(() => {
    queryWatcher.mockClear();
  });

  it('describe_camera calls queryWatcher with camera source', async () => {
    queryWatcher.mockResolvedValue('I see a cat');

    const result = await handleToolCall(
      'describe_camera',
      { focus: 'the cat', detail: 'brief' },
      ctx
    );

    expect(queryWatcher).toHaveBeenCalledOnce();
    const [prompt, source] = queryWatcher.mock.calls[0];
    expect(source).toBe('camera');
    expect(prompt).toContain('camera');
    expect(prompt).toContain('Focus on: the cat');
    expect(prompt).toContain('brief');
    expect(result).toEqual({ result: 'I see a cat' });
  });

  it('describe_camera with no args uses default prompt', async () => {
    queryWatcher.mockResolvedValue('Room view');

    await handleToolCall('describe_camera', {}, ctx);

    const [prompt, source] = queryWatcher.mock.calls[0];
    expect(source).toBe('camera');
    expect(prompt).toContain('Describe what you see from the camera');
  });

  it('describe_screen with detailed uses thorough prompt', async () => {
    queryWatcher.mockResolvedValue('Code editor open');

    await handleToolCall('describe_screen', { detail: 'detailed' }, ctx);

    const [prompt, source] = queryWatcher.mock.calls[0];
    expect(source).toBe('screen');
    expect(prompt).toContain('thorough, detailed');
  });

  it('get_current_time returns time/date/timezone', async () => {
    const result = await handleToolCall('get_current_time', {}, ctx);

    expect(result).toHaveProperty('result');
    const inner = result.result as Record<string, unknown>;
    expect(inner).toHaveProperty('time');
    expect(inner).toHaveProperty('date');
    expect(inner).toHaveProperty('timezone');
  });

  it('unknown tool returns error', async () => {
    const result = await handleToolCall('nonexistent_tool', {}, ctx);

    expect(result).toEqual({ error: 'Unknown tool: nonexistent_tool' });
  });

  describe('memory tools', () => {
    const memoryTools = {
      storeFact: vi.fn(() => Promise.resolve('fact-id-123')),
      recall: vi.fn(() =>
        Promise.resolve([
          {
            id: '1',
            content: 'User lives in Seattle',
            category: 'personal' as const,
            tags: ['location'],
            sourceSessionId: null,
            confidence: 0.8,
            accessCount: 0,
            lastAccessedAt: null,
            createdAt: '',
            updatedAt: '',
            expiresAt: null,
          },
        ])
      ),
      storePreference: vi.fn(() => Promise.resolve()),
      invalidateFact: vi.fn(() => Promise.resolve('fact-id-456')),
      getTimeline: vi.fn(() => Promise.resolve([])),
      getMemoryStats: vi.fn(() =>
        Promise.resolve({
          totalFacts: 10,
          activeFacts: 8,
          expiredFacts: 2,
          topCategories: { general: 5, project: 3 },
          totalEntities: 3,
          totalRelationships: 2,
          oldestFact: '2026-01-01',
          newestFact: '2026-04-08',
          totalTranscriptsIndexed: 50,
          storageEstimate: '10 facts',
        })
      ),
    };

    const memCtx: ToolCallContext = { queryWatcher, memoryTools };

    beforeEach(() => {
      memoryTools.storeFact.mockClear();
      memoryTools.recall.mockClear();
      memoryTools.storePreference.mockClear();
    });

    it('remember_fact stores a fact', async () => {
      const result = await handleToolCall(
        'remember_fact',
        { content: 'User lives in Seattle', category: 'personal', tags: 'location, city' },
        memCtx
      );

      expect(memoryTools.storeFact).toHaveBeenCalledWith('User lives in Seattle', 'personal', [
        'location',
        'city',
      ]);
      expect(result).toEqual({ result: { stored: true, id: 'fact-id-123' } });
    });

    it('remember_fact defaults to general category', async () => {
      await handleToolCall('remember_fact', { content: 'Important fact' }, memCtx);

      expect(memoryTools.storeFact).toHaveBeenCalledWith('Important fact', 'general', []);
    });

    it('recall_memory searches facts', async () => {
      const result = await handleToolCall(
        'recall_memory',
        { query: 'where does user live' },
        memCtx
      );

      expect(memoryTools.recall).toHaveBeenCalledWith('where does user live');
      const inner = result.result as { facts: unknown[] };
      expect(inner.facts).toHaveLength(1);
    });

    it('update_preference stores preference', async () => {
      const result = await handleToolCall(
        'update_preference',
        { preference: 'Be more concise', category: 'response_style' },
        memCtx
      );

      expect(memoryTools.storePreference).toHaveBeenCalledWith('Be more concise', 'response_style');
      expect(result).toEqual({ result: { stored: true } });
    });

    it('memory tools return error when handler not available', async () => {
      const result = await handleToolCall('remember_fact', { content: 'test' }, ctx);
      expect(result).toEqual({ error: 'Memory system not available' });
    });
  });

  describe('task tools', () => {
    it('task tools return error when handler not available', async () => {
      const result = await handleToolCall('create_task', { title: 'test' }, ctx);
      expect(result).toEqual({ error: 'Task system not available' });
    });
  });
});
