import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolDefs, handleToolCall } from './tools.js';

describe('toolDefs', () => {
  it('defines exactly 3 tools', () => {
    expect(toolDefs).toHaveLength(3);
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
});
