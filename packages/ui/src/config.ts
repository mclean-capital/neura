import type { UIConfig } from '@neura/types';

function defaultWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3002/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export const config: UIConfig = {
  wsUrl: (import.meta.env.VITE_WS_URL as string | undefined) ?? defaultWsUrl(),
};
