export interface HealthResponse {
  status: string;
  uptime: number;
  port: number;
}

/**
 * Probe the core health endpoint. Returns the response or null if unreachable.
 */
export async function checkHealth(port: number): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/**
 * Wait for core to become healthy, polling at intervals.
 */
export async function waitForHealthy(
  port: number,
  timeoutMs = 15_000,
  intervalMs = 500
): Promise<HealthResponse | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(port);
    if (health) return health;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
