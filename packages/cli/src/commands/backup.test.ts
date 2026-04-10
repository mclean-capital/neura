import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backupCommand, restoreCommand } from './backup.js';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ port: 3002 })),
}));

vi.mock('../health.js', () => ({
  checkHealth: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { checkHealth } = await import('../health.js');
const { confirm } = await import('@inquirer/prompts');
const mockedCheckHealth = vi.mocked(checkHealth);
const mockedConfirm = vi.mocked(confirm);

let consoleSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    /* noop */
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

describe('backupCommand', () => {
  it('exits 1 when core is not running', async () => {
    mockedCheckHealth.mockResolvedValue(null);

    await backupCommand();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('prints backup path on success', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', path: '/home/user/.neura/memory-backup.json' }),
    });

    await backupCommand();

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3002/backup', {
      method: 'POST',
      headers: {},
      signal: expect.any(AbortSignal),
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('memory-backup.json'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on HTTP error', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('backup not available'),
    });

    await backupCommand();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('exits 1 when fetch throws (e.g. timeout)', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    await backupCommand();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });
});

describe('restoreCommand', () => {
  it('exits 1 when core is not running', async () => {
    mockedCheckHealth.mockResolvedValue(null);

    await restoreCommand({ force: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('prints imported/skipped on success', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', imported: 12, skipped: 3 }),
    });

    await restoreCommand({ force: true });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3002/restore', {
      method: 'POST',
      headers: {},
      signal: expect.any(AbortSignal),
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Restore complete'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('12'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('3'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on HTTP error', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    await restoreCommand({ force: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('exits 1 when fetch throws (e.g. timeout)', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    await restoreCommand({ force: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('cancels when user declines confirmation', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockedConfirm.mockResolvedValue(false);

    await restoreCommand({});

    expect(mockedConfirm).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('skips confirmation with --force', async () => {
    mockedCheckHealth.mockResolvedValue({ status: 'ok', uptime: 100, port: 3002 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', imported: 5, skipped: 0 }),
    });

    await restoreCommand({ force: true });

    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });
});
