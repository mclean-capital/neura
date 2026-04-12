import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('os', () => ({
  platform: vi.fn(() => 'linux'),
  arch: vi.fn(() => 'x64'),
  homedir: vi.fn(() => '/home/testuser'),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => ({
    providers: {},
    routing: {
      voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
      vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
      text: { provider: 'google', model: 'gemini-2.5-flash' },
      embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
      worker: { provider: 'xai', model: 'grok-4-fast' },
    },
    autoUpdate: true,
  })),
  getNeuraHome: vi.fn(() => '/home/testuser/.neura'),
}));

// Fix CLI_VERSION to a known value for the tests
vi.mock('./version.js', () => ({
  CLI_VERSION: '1.11.0',
}));

import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { loadConfig } from './config.js';
import { checkForUpdateInBackground } from './update-check.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedSpawn = vi.mocked(spawn);
const mockedLoadConfig = vi.mocked(loadConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadConfig.mockReturnValue({
    providers: {},
    routing: {
      voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
      vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
      text: { provider: 'google', model: 'gemini-2.5-flash' },
      embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
      worker: { provider: 'xai', model: 'grok-4-fast' },
    },
    autoUpdate: true,
  });
});

describe('checkForUpdateInBackground', () => {
  it('prints notice when cache shows newer version', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '1.12.0' })
    );

    checkForUpdateInBackground();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1.12.0'));
    consoleSpy.mockRestore();
  });

  it('does not print notice when versions match', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '1.11.0' })
    );

    checkForUpdateInBackground();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not print notice when cache is older than running CLI (downgrade)', () => {
    // Regression: right after `npm install -g @mclean-capital/neura@latest`
    // bumps the user from 1.10.x → 1.11.0, the stale cache (still from the
    // pre-upgrade check) remembers 1.10.2. A naive `!==` comparison would
    // incorrectly announce "Update available: 1.11.0 → 1.10.2".
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '1.10.2' })
    );

    checkForUpdateInBackground();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('strips legacy v-prefix from pre-1.11.0 cache format', () => {
    // Pre-1.11.0 caches (written by the old GitHub-release checker)
    // stored versions as "v1.12.0". After the upgrade to the npm-based
    // checker, we should still recognize these as newer and prompt.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: 'v1.12.0' })
    );

    checkForUpdateInBackground();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1.12.0'));
    consoleSpy.mockRestore();
  });

  it('does not spawn when cache is fresh', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '1.11.0' })
    );

    checkForUpdateInBackground();

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('spawns background refresh when cache is stale', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: 0, latestVersion: '1.11.0' })
    );

    checkForUpdateInBackground();

    expect(mockedSpawn).toHaveBeenCalledOnce();
    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['--input-type=module']),
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('spawns background refresh when cache is missing', () => {
    mockedExistsSync.mockReturnValue(false);

    checkForUpdateInBackground();

    expect(mockedSpawn).toHaveBeenCalledOnce();
  });

  it('suppresses everything when autoUpdate is false', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedLoadConfig.mockReturnValue({
      providers: {},
      routing: {
        voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
        vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
        text: { provider: 'google', model: 'gemini-2.5-flash' },
        embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
        worker: { provider: 'xai', model: 'grok-4-fast' },
      },
      autoUpdate: false,
    });

    checkForUpdateInBackground();

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not crash on malformed cache JSON', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json {{{');

    expect(() => checkForUpdateInBackground()).not.toThrow();
    // Should spawn refresh since cache is unreadable
    expect(mockedSpawn).toHaveBeenCalledOnce();
  });
});
