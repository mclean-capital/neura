import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@neura/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

type MessageHandler = (msg: ServerMessage) => void;

export function useWebSocket(url: string) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Set<MessageHandler>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  const connectWs = useCallback(() => {
    const existing = wsRef.current;
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) {
      return;
    }

    // Clear any pending reconnect timer (guards against StrictMode double-mount)
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }

    intentionalCloseRef.current = false;
    setStatus('connecting');

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      attemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        for (const handler of handlersRef.current) {
          handler(msg);
        }
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onerror = () => {
      setStatus('error');
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!intentionalCloseRef.current) {
        setStatus('disconnected');
        // Auto-reconnect with backoff
        attemptsRef.current++;
        const delay = Math.min(1000 * Math.pow(2, attemptsRef.current - 1), 16_000);
        reconnectTimerRef.current = setTimeout(connectWs, delay);
      } else {
        setStatus('disconnected');
      }
    };
  }, [url]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const sendMessage = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  // Clean up on unmount only — no auto-connect
  useEffect(() => {
    return disconnect;
  }, [disconnect]);

  return { status, connect: connectWs, disconnect, sendMessage, subscribe };
}
