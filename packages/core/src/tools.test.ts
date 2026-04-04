import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolDefs, handleToolCall } from './tools.js';

describe('toolDefs', () => {
  it('defines exactly 6 tools', () => {
    expect(toolDefs).toHaveLength(6);
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
  });
});

describe('handleToolCall', () => {
  const queryWatcher = vi.fn((_prompt: string, _source: 'camera' | 'screen') =>
    Promise.resolve('')
  );

  beforeEach(() => {
    queryWatcher.mockClear();
  });

  it('describe_camera calls queryWatcher with camera source', async () => {
    queryWatcher.mockResolvedValue('I see a cat');

    const result = await handleToolCall(
      'describe_camera',
      { focus: 'the cat', detail: 'brief' },
      queryWatcher
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

    await handleToolCall('describe_camera', {}, queryWatcher);

    const [prompt, source] = queryWatcher.mock.calls[0];
    expect(source).toBe('camera');
    expect(prompt).toContain('Describe what you see from the camera');
  });

  it('describe_screen with detailed uses thorough prompt', async () => {
    queryWatcher.mockResolvedValue('Code editor open');

    await handleToolCall('describe_screen', { detail: 'detailed' }, queryWatcher);

    const [prompt, source] = queryWatcher.mock.calls[0];
    expect(source).toBe('screen');
    expect(prompt).toContain('thorough, detailed');
  });

  it('get_current_time returns time/date/timezone', async () => {
    const result = await handleToolCall('get_current_time', {}, queryWatcher);

    expect(result).toHaveProperty('result');
    const inner = result.result as Record<string, unknown>;
    expect(inner).toHaveProperty('time');
    expect(inner).toHaveProperty('date');
    expect(inner).toHaveProperty('timezone');
  });

  it('unknown tool returns error', async () => {
    const result = await handleToolCall('nonexistent_tool', {}, queryWatcher);

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
    };

    beforeEach(() => {
      memoryTools.storeFact.mockClear();
      memoryTools.recall.mockClear();
      memoryTools.storePreference.mockClear();
    });

    it('remember_fact stores a fact', async () => {
      const result = await handleToolCall(
        'remember_fact',
        { content: 'User lives in Seattle', category: 'personal', tags: 'location, city' },
        queryWatcher,
        memoryTools
      );

      expect(memoryTools.storeFact).toHaveBeenCalledWith('User lives in Seattle', 'personal', [
        'location',
        'city',
      ]);
      expect(result).toEqual({ result: { stored: true, id: 'fact-id-123' } });
    });

    it('remember_fact defaults to general category', async () => {
      await handleToolCall(
        'remember_fact',
        { content: 'Important fact' },
        queryWatcher,
        memoryTools
      );

      expect(memoryTools.storeFact).toHaveBeenCalledWith('Important fact', 'general', []);
    });

    it('recall_memory searches facts', async () => {
      const result = await handleToolCall(
        'recall_memory',
        { query: 'where does user live' },
        queryWatcher,
        memoryTools
      );

      expect(memoryTools.recall).toHaveBeenCalledWith('where does user live');
      const inner = result.result as { facts: unknown[] };
      expect(inner.facts).toHaveLength(1);
    });

    it('update_preference stores preference', async () => {
      const result = await handleToolCall(
        'update_preference',
        { preference: 'Be more concise', category: 'response_style' },
        queryWatcher,
        memoryTools
      );

      expect(memoryTools.storePreference).toHaveBeenCalledWith('Be more concise', 'response_style');
      expect(result).toEqual({ result: { stored: true } });
    });

    it('memory tools return error when handler not available', async () => {
      const result = await handleToolCall('remember_fact', { content: 'test' }, queryWatcher);
      expect(result).toEqual({ error: 'Memory system not available' });
    });
  });
});
