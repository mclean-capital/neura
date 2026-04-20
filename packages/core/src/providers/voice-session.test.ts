import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionCallbacks } from './voice-session.js';

// Track mock WebSocket instances and their event handlers
const mockSend = vi.fn();
const mockClose = vi.fn();

let onOpenCb: (() => void) | null = null;
let onMessageCb: ((data: unknown) => void) | null = null;

// Use a class so it works with `new WebSocket(...)`
class MockWebSocket {
  static OPEN = 1;
  readyState = 1;
  send = mockSend;
  close = mockClose;

  on(event: string, cb: (...args: unknown[]) => void) {
    if (event === 'open') onOpenCb = cb as () => void;
    if (event === 'message') onMessageCb = cb as (data: unknown) => void;
    // error and close callbacks are registered but not invoked in unit tests
  }
}

vi.mock('ws', () => {
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

// Must import after mock setup
const { createVoiceSession } = await import('./voice-session.js');

function makeMockCallbacks(): SessionCallbacks {
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
    queryWatcher: vi.fn().mockResolvedValue('mock vision response'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  onOpenCb = null;
  onMessageCb = null;
  mockSend.mockClear();
  mockClose.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.XAI_API_KEY;
});

describe('createVoiceSession', () => {
  describe('missing API key', () => {
    it('calls onError and onClose when XAI_API_KEY is not set', () => {
      delete process.env.XAI_API_KEY;
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();

      expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('XAI_API_KEY'));
      expect(cb.onClose).toHaveBeenCalled();
    });
  });

  describe('connection lifecycle', () => {
    it('sends session.update on open', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(sent.type).toBe('session.update');
      expect(sent.session.voice).toBe('eve');
      expect(sent.session.tools).toBeDefined();
    });

    it('close() prevents reconnect attempts', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      session.close();
      // Should not trigger reconnect
      expect(cb.onError).not.toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('dispatches audio delta to onAudio', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      onMessageCb?.(JSON.stringify({ type: 'response.output_audio.delta', delta: 'abc123' }));

      expect(cb.onAudio).toHaveBeenCalledWith('abc123');
    });

    it('dispatches output transcript delta', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      onMessageCb?.(
        JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hello' })
      );

      expect(cb.onOutputTranscript).toHaveBeenCalledWith('Hello');
    });

    it('dispatches input transcript completed', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      onMessageCb?.(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'What do you see?',
        })
      );

      expect(cb.onInputTranscript).toHaveBeenCalledWith('What do you see?');
    });

    it('dispatches speech started as interrupted', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      onMessageCb?.(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));

      expect(cb.onInterrupted).toHaveBeenCalled();
    });

    it('dispatches response.done as turnComplete', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      onMessageCb?.(JSON.stringify({ type: 'response.done', response: {} }));

      expect(cb.onTurnComplete).toHaveBeenCalled();
    });

    it('dispatches error messages', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      onMessageCb?.(JSON.stringify({ type: 'error', error: { message: 'Rate limited' } }));

      expect(cb.onError).toHaveBeenCalledWith('Rate limited');
    });
  });

  describe('sendAudio and sendText', () => {
    it('sendAudio sends audio buffer message', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();
      mockSend.mockClear();

      session.sendAudio('base64data');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(sent.type).toBe('input_audio_buffer.append');
      expect(sent.audio).toBe('base64data');
    });

    it('sendText sends message and triggers response', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();
      mockSend.mockClear();

      session.sendText('Hello Eve');

      expect(mockSend).toHaveBeenCalledTimes(2);
      const itemCreate = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(itemCreate.type).toBe('conversation.item.create');
      expect(itemCreate.item.content[0].text).toBe('Hello Eve');

      const responseCreate = JSON.parse(mockSend.mock.calls[1][0] as string);
      expect(responseCreate.type).toBe('response.create');
    });
  });

  describe('function call handling', () => {
    it('dispatches tool call, awaits result, and sends output back', async () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      (cb.queryWatcher as ReturnType<typeof vi.fn>).mockResolvedValue('I see a cat on the desk');
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();
      mockSend.mockClear();

      // Function calls are now dispatched on `response.done` (batch
      // dispatch) rather than on per-call `response.function_call_arguments.done`.
      // `response.done` is the authoritative source — it carries the
      // finalized `output` array with a single `status === 'completed'`
      // gate, so the provider runs all calls as one batch and fires
      // exactly one follow-up `response.create`.
      onMessageCb?.(
        JSON.stringify({
          type: 'response.done',
          response: {
            id: 'resp_1',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                name: 'describe_camera',
                arguments: '{"focus":"the cat","detail":"brief"}',
                call_id: 'call_123',
              },
            ],
          },
        })
      );

      // dispatchFunctionCalls is async — flush microtasks
      await vi.advanceTimersToNextTimerAsync();

      expect(cb.onToolCall).toHaveBeenCalledWith('describe_camera', {
        focus: 'the cat',
        detail: 'brief',
      });
      expect(cb.onToolResult).toHaveBeenCalledWith(
        'describe_camera',
        expect.objectContaining({ result: expect.any(String) })
      );

      // Should send function_call_output + exactly one response.create back to ws.
      expect(mockSend).toHaveBeenCalledTimes(2);
      const output = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(output.type).toBe('conversation.item.create');
      expect(output.item.type).toBe('function_call_output');
      expect(output.item.call_id).toBe('call_123');

      const responseCreate = JSON.parse(mockSend.mock.calls[1][0] as string);
      expect(responseCreate.type).toBe('response.create');
    });
  });

  describe('reconnect behavior', () => {
    it('calls onReconnected when reconnecting with transcript context', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();

      // Simulate a transcript entry
      onMessageCb?.(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'Hello',
        })
      );

      // Trigger open again (simulates reconnect with existing transcript)
      mockSend.mockClear();
      onOpenCb?.();

      expect(cb.onReconnected).toHaveBeenCalled();
      const sent = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(sent.session.instructions).toContain('Session resumed');
    });
  });

  describe('sendSystemEvent', () => {
    it('sends system context message', () => {
      process.env.XAI_API_KEY = 'test-key';
      const cb = makeMockCallbacks();
      const session = createVoiceSession(cb);

      session.connect();
      onOpenCb?.();
      mockSend.mockClear();

      session.sendSystemEvent('Camera is now active');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(sent.type).toBe('conversation.item.create');
      expect(sent.item.content[0].text).toContain('[System: Camera is now active]');
    });
  });
});
