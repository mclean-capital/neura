/**
 * Tests for GrokVoiceProvider — `interject()` from Phase 6 plus the
 * `response.done` batch-dispatch path (exactly one `response.create`
 * per model turn, regardless of how many parallel tool calls the model
 * emitted). Other GrokVoiceProvider behavior is exercised end-to-end
 * by `voice-session.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
const mockClose = vi.fn();
let currentMockWs: MockWebSocket | null = null;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  send = mockSend;
  close = mockClose;
  private handlers: Record<string, ((arg: unknown) => void)[]> = {};

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    currentMockWs = this;
  }

  on(event: string, cb: (arg: unknown) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }

  emit(event: string, arg: unknown): void {
    (this.handlers[event] ?? []).forEach((cb) => cb(arg));
  }
}

vi.mock('ws', () => {
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

const mockHandleToolCall = vi.fn();
vi.mock('../tools/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../tools/index.js')>();
  return {
    ...orig,
    handleToolCall: (name: string, args: Record<string, unknown>, ctx: unknown): Promise<unknown> =>
      mockHandleToolCall(name, args, ctx) as Promise<unknown>,
  };
});

// Import after mock setup so the module sees the mocked WebSocket + tools.
const { GrokVoiceProvider } = await import('./grok-voice.js');

function makeCallbacks(): import('@neura/types').VoiceProviderCallbacks {
  return {
    onAudio: vi.fn(),
    onInputTranscript: vi.fn(),
    onOutputTranscript: vi.fn(),
    onOutputTranscriptComplete: vi.fn(),
    onInterrupted: vi.fn(),
    onTurnComplete: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    onReconnected: vi.fn(),
    queryWatcher: vi.fn().mockResolvedValue('mock screen description'),
  };
}

function sentMessages(): { type: string; item?: { type?: string; call_id?: string } }[] {
  return mockSend.mock.calls.map(
    (c) =>
      JSON.parse(c[0] as string) as { type: string; item?: { type?: string; call_id?: string } }
  );
}

function emitResponseDone(
  output: unknown[],
  status: 'completed' | 'cancelled' | 'incomplete' | 'failed' = 'completed'
): void {
  currentMockWs!.emit(
    'message',
    JSON.stringify({
      type: 'response.done',
      response: { id: 'resp_1', status, output },
    })
  );
}

describe('GrokVoiceProvider — interject', () => {
  const originalKey = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
    mockSend.mockClear();
    mockClose.mockClear();
    mockHandleToolCall.mockReset();
    currentMockWs = null;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  });

  it('logs and resolves when no ws is connected', async () => {
    const provider = new GrokVoiceProvider(makeCallbacks());
    // No connect() call — provider.ws is still null.
    await expect(provider.interject('hello', { immediate: false })).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('queues a conversation.item.create for immediate: false', async () => {
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();
    await provider.interject('upload finished', { immediate: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(mockSend.mock.calls[0][0] as string) as {
      type: string;
      item: { content: { text: string }[] };
    };
    expect(payload.type).toBe('conversation.item.create');
    expect(payload.item.content[0]?.text).toContain('upload finished');
  });

  it('sends response.cancel + response.create for immediate: true', async () => {
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();
    await provider.interject('user needs to answer now', { immediate: true });

    // 3 sends: item create, response.cancel, response.create
    expect(mockSend).toHaveBeenCalledTimes(3);
    const types = mockSend.mock.calls
      .map((c) => JSON.parse(c[0] as string) as { type: string })
      .map((p) => p.type);
    expect(types).toEqual(['conversation.item.create', 'response.cancel', 'response.create']);
  });

  it('enforces 10s rate limit between ambient interjects', async () => {
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();
    await provider.interject('first', { immediate: false });
    await provider.interject('second', { immediate: false });
    // Second call should have been rate-limited.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('bypassRateLimit skips the rate limiter', async () => {
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();
    await provider.interject('first', { immediate: false });
    await provider.interject('second', { immediate: false, bypassRateLimit: true });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('tags Neura-originated content with [Neura: ...] prefix', async () => {
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();
    await provider.interject('describe_screen running', { immediate: false });
    const payload = JSON.parse(mockSend.mock.calls[0][0] as string) as {
      item: { content: { text: string }[] };
    };
    expect(payload.item.content[0]?.text).toBe('[Neura: describe_screen running]');
  });
});

describe('GrokVoiceProvider — response.done batch dispatch', () => {
  const originalKey = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
    mockSend.mockClear();
    mockClose.mockClear();
    mockHandleToolCall.mockReset();
    currentMockWs = null;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  });

  it('fires exactly one response.create for two parallel tool calls', async () => {
    mockHandleToolCall.mockResolvedValue({ ok: true });
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();

    emitResponseDone([
      { type: 'function_call', name: 'get_task', call_id: 'call_a', arguments: '{"id":"1"}' },
      { type: 'function_call', name: 'list_tasks', call_id: 'call_b', arguments: '{}' },
    ]);

    // Let the async dispatch settle.
    await new Promise((resolve) => setImmediate(resolve));

    const sent = sentMessages();
    const outputs = sent.filter((m) => m.item?.type === 'function_call_output');
    const creates = sent.filter((m) => m.type === 'response.create');

    expect(outputs).toHaveLength(2);
    expect(creates).toHaveLength(1);
    expect(outputs.map((o) => o.item?.call_id)).toEqual(['call_a', 'call_b']);
    expect(mockHandleToolCall).toHaveBeenCalledTimes(2);
  });

  it('skips dispatch when the response is cancelled', async () => {
    mockHandleToolCall.mockResolvedValue({ ok: true });
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();

    emitResponseDone(
      [{ type: 'function_call', name: 'get_task', call_id: 'call_a', arguments: '{}' }],
      'cancelled'
    );

    await new Promise((resolve) => setImmediate(resolve));

    const sent = sentMessages();
    expect(sent.some((m) => m.item?.type === 'function_call_output')).toBe(false);
    expect(sent.some((m) => m.type === 'response.create')).toBe(false);
    expect(mockHandleToolCall).not.toHaveBeenCalled();
  });

  it('emits transcript callback AND dispatches tools for mixed message + function_call response', async () => {
    mockHandleToolCall.mockResolvedValue({ ok: true });
    const cb = makeCallbacks();
    const provider = new GrokVoiceProvider(cb);
    provider.connect();

    currentMockWs!.emit(
      'message',
      JSON.stringify({
        type: 'response.done',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ transcript: 'Got it, checking now.' }],
            },
            { type: 'function_call', name: 'get_task', call_id: 'call_a', arguments: '{}' },
          ],
        },
      })
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(cb.onOutputTranscriptComplete).toHaveBeenCalledWith('Got it, checking now.');
    const sent = sentMessages();
    expect(sent.filter((m) => m.item?.type === 'function_call_output')).toHaveLength(1);
    expect(sent.filter((m) => m.type === 'response.create')).toHaveLength(1);
  });

  it('still posts all outputs + one response.create when one handler throws', async () => {
    mockHandleToolCall
      .mockResolvedValueOnce({ ok: 'first' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: 'third' });

    const cb = makeCallbacks();
    const provider = new GrokVoiceProvider(cb);
    provider.connect();

    emitResponseDone([
      { type: 'function_call', name: 'tool_a', call_id: 'call_a', arguments: '{}' },
      { type: 'function_call', name: 'tool_b', call_id: 'call_b', arguments: '{}' },
      { type: 'function_call', name: 'tool_c', call_id: 'call_c', arguments: '{}' },
    ]);

    await new Promise((resolve) => setImmediate(resolve));

    const sent = sentMessages();
    const outputs = sent.filter((m) => m.item?.type === 'function_call_output');
    const creates = sent.filter((m) => m.type === 'response.create');

    expect(outputs).toHaveLength(3);
    expect(creates).toHaveLength(1);
    expect(outputs.map((o) => o.item?.call_id)).toEqual(['call_a', 'call_b', 'call_c']);

    // onToolResult fired for all three (including the thrown one's error payload).
    expect(cb.onToolResult).toHaveBeenCalledTimes(3);
  });

  it('dedupes tool calls by call_id within a single response', async () => {
    mockHandleToolCall.mockResolvedValue({ ok: true });
    const provider = new GrokVoiceProvider(makeCallbacks());
    provider.connect();

    emitResponseDone([
      { type: 'function_call', name: 'get_task', call_id: 'call_a', arguments: '{}' },
      { type: 'function_call', name: 'get_task', call_id: 'call_a', arguments: '{}' },
    ]);

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockHandleToolCall).toHaveBeenCalledTimes(1);
    const sent = sentMessages();
    expect(sent.filter((m) => m.item?.type === 'function_call_output')).toHaveLength(1);
    expect(sent.filter((m) => m.type === 'response.create')).toHaveLength(1);
  });
});
