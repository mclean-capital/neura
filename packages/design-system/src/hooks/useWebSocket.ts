import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@neura/types';
import type { ConnectionStatus } from '../types/index.js';

const MAX_RECONNECT_ATTEMPTS = 10;

type MessageHandler = (msg: ServerMessage) => void;

export function useWebSocket(url: string, authToken?: string) {
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

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }

    intentionalCloseRef.current = false;
    setStatus('connecting');

    // Append auth token as query param if provided
    let wsUrl = url;
    if (authToken) {
      const sep = url.includes('?') ? '&' : '?';
      wsUrl = `${url}${sep}token=${encodeURIComponent(authToken)}`;
    }

    const ws = new WebSocket(wsUrl);
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
        attemptsRef.current++;
        if (attemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
          setStatus('failed');
          return;
        }
        setStatus('disconnected');
        const delay = Math.min(1000 * Math.pow(2, attemptsRef.current - 1), 16_000);
        reconnectTimerRef.current = setTimeout(connectWs, delay);
      } else {
        setStatus('disconnected');
      }
    };
  }, [url, authToken]);

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

  useEffect(() => {
    return disconnect;
  }, [disconnect]);

  return { status, connect: connectWs, disconnect, sendMessage, subscribe };
}
