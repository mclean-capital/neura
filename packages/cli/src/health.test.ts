import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkHealth, waitForHealthy } from './health.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('checkHealth', () => {
  it('returns parsed JSON on 200 response', async () => {
    const healthData = { status: 'ok', uptime: 12345, port: 3002 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(healthData),
    });

    const result = await checkHealth(3002);

    expect(result).toEqual(healthData);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3002/health', {
      signal: expect.any(AbortSignal),
    });
  });

  it('returns null on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await checkHealth(3002);

    expect(result).toBeNull();
  });

  it('returns null on connection refused (fetch throws)', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    const result = await checkHealth(3002);

    expect(result).toBeNull();
  });

  it('returns null on timeout (fetch throws AbortError)', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const result = await checkHealth(3002);

    expect(result).toBeNull();
  });
});

describe('waitForHealthy', () => {
  it('resolves when health check succeeds on first attempt', async () => {
    const healthData = { status: 'ok', uptime: 100, port: 3002 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(healthData),
    });

    const result = await waitForHealthy(3002, 5000, 100);

    expect(result).toEqual(healthData);
  });

  it('resolves when health check succeeds after initial failures', async () => {
    const healthData = { status: 'ok', uptime: 200, port: 3002 };

    // Fail twice, then succeed
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(healthData),
      });

    const result = await waitForHealthy(3002, 5000, 50);

    expect(result).toEqual(healthData);
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns null after timeout', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const result = await waitForHealthy(3002, 200, 50);

    expect(result).toBeNull();
  });
});
