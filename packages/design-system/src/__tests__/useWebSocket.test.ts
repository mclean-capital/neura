import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useWebSocket } from '../hooks/useWebSocket.js';

interface MockWSInstance {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockWsInstances: MockWSInstance[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn().mockImplementation(() => {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose(new CloseEvent('close'));
  });

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this as unknown as MockWSInstance);
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen(new Event('open'));
  }

  simulateMessage(data: unknown) {
    if (this.onmessage) this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateError() {
    if (this.onerror) this.onerror(new Event('error'));
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose(new CloseEvent('close'));
  }
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  mockWsInstances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.WebSocket = OriginalWebSocket;
});

function latestWs(): MockWebSocket & MockWSInstance {
  return mockWsInstances[mockWsInstances.length - 1] as unknown as MockWebSocket & MockWSInstance;
}

describe('useWebSocket', () => {
  it('starts disconnected', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));
    expect(result.current.status).toBe('disconnected');
  });

  it('transitions to connecting then connected', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.connect();
    });
    expect(result.current.status).toBe('connecting');

    act(() => {
      latestWs().simulateOpen();
    });
    expect(result.current.status).toBe('connected');
  });

  it('transitions to error on ws error', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.connect();
    });

    act(() => {
      latestWs().simulateError();
    });
    expect(result.current.status).toBe('error');
  });

  it('disconnect sets status to disconnected without auto-reconnect', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });
    expect(result.current.status).toBe('connected');

    act(() => {
      result.current.disconnect();
    });
    expect(result.current.status).toBe('disconnected');

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(mockWsInstances).toHaveLength(1);
  });

  it('transitions to failed after exceeding max reconnect attempts', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });

    // Exhaust all 10 reconnect attempts
    for (let i = 0; i < 11; i++) {
      act(() => {
        latestWs().simulateClose();
      });
      if (i < 10) {
        // Advance past the backoff delay to trigger next reconnect
        act(() => {
          vi.advanceTimersByTime(20_000);
        });
      }
    }

    expect(result.current.status).toBe('failed');
  });

  it('auto-reconnects on unintentional close', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });

    act(() => {
      latestWs().simulateClose();
    });
    expect(result.current.status).toBe('disconnected');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mockWsInstances).toHaveLength(2);
  });

  it('sendMessage sends JSON when connected', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });

    act(() => {
      result.current.sendMessage({ type: 'audio', data: 'abc' });
    });

    expect(latestWs().send).toHaveBeenCalledWith(JSON.stringify({ type: 'audio', data: 'abc' }));
  });

  it('sendMessage is a no-op when disconnected', () => {
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.sendMessage({ type: 'audio', data: 'abc' });
    });

    expect(mockWsInstances).toHaveLength(0);
  });

  it('subscribe receives parsed messages', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.subscribe(handler);
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });

    act(() => {
      latestWs().simulateMessage({ type: 'inputTranscript', text: 'Hello' });
    });

    expect(handler).toHaveBeenCalledWith({ type: 'inputTranscript', text: 'Hello' });
  });

  it('unsubscribe stops receiving messages', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    let unsub: () => void;
    act(() => {
      unsub = result.current.subscribe(handler);
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });

    act(() => {
      unsub();
    });

    act(() => {
      latestWs().simulateMessage({ type: 'inputTranscript', text: 'Hello' });
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles malformed messages without throwing', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket('ws://localhost:3002/ws'));

    act(() => {
      result.current.subscribe(handler);
      result.current.connect();
    });
    act(() => {
      latestWs().simulateOpen();
    });

    act(() => {
      const ws = latestWs();
      if (ws.onmessage) ws.onmessage(new MessageEvent('message', { data: 'not-json' }));
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
