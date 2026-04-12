/**
 * Tests for GrokVoiceProvider — specifically the `interject()` method added
 * in Phase 6 for VoiceFanoutBridge. Other GrokVoiceProvider behavior is
 * exercised end-to-end by `voice-session.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
const mockClose = vi.fn();

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  send = mockSend;
  close = mockClose;
  on(_event: string, _cb: (...args: unknown[]) => void): void {
    // no-op for interject tests
  }
}

vi.mock('ws', () => {
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

// Import after mock setup so the module sees the mocked WebSocket.
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

describe('GrokVoiceProvider — interject', () => {
  const originalKey = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
    mockSend.mockClear();
    mockClose.mockClear();
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
