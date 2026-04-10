import type { UIConfig } from '@neura/types';

function defaultWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3002/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * Extract auth token from URL query param, sessionStorage, or Vite env var.
 * If found in URL, store in sessionStorage and strip from the address bar.
 */
function resolveAuthToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;

  // 1. Check URL query param (set by `neura open`)
  const url = new URL(window.location.href);
  const urlToken = url.searchParams.get('token');
  if (urlToken) {
    sessionStorage.setItem('neura_auth_token', urlToken);
    // Strip token from URL bar to avoid leaking in screenshots/bookmarks
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return urlToken;
  }

  // 2. Check sessionStorage (persisted from previous page load)
  const stored = sessionStorage.getItem('neura_auth_token');
  if (stored) return stored;

  // 3. Check Vite env var (dev mode)
  const envToken = import.meta.env.VITE_AUTH_TOKEN as string | undefined;
  if (envToken) return envToken;

  return undefined;
}

export const config: UIConfig = {
  wsUrl: (import.meta.env.VITE_WS_URL as string | undefined) ?? defaultWsUrl(),
  authToken: resolveAuthToken(),
};
