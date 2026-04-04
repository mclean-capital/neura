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
  loadConfig: vi.fn(() => ({ autoUpdate: true })),
  getNeuraHome: vi.fn(() => '/home/testuser/.neura'),
}));

vi.mock('./download.js', () => ({
  getInstalledCoreVersion: vi.fn(() => '1.0.0'),
}));

import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { loadConfig } from './config.js';
import { getInstalledCoreVersion } from './download.js';
import { checkForUpdateInBackground } from './update-check.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedSpawn = vi.mocked(spawn);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedGetInstalledVersion = vi.mocked(getInstalledCoreVersion);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadConfig.mockReturnValue({
    port: 0,
    voice: 'eve',
    apiKeys: { xai: '', google: '' },
    service: { autoStart: true, logLevel: 'info' },
    autoUpdate: true,
  });
  mockedGetInstalledVersion.mockReturnValue('1.0.0');
});

describe('checkForUpdateInBackground', () => {
  it('prints notice when cache shows newer version', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: 'v2.0.0' })
    );

    checkForUpdateInBackground();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
    consoleSpy.mockRestore();
  });

  it('does not print notice when versions match', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: 'v1.0.0' })
    );

    checkForUpdateInBackground();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not spawn when cache is fresh', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: 'v1.0.0' })
    );

    checkForUpdateInBackground();

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('spawns background refresh when cache is stale', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ lastCheckedAt: 0, latestVersion: 'v1.0.0' })
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
      port: 0,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' },
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

  it('does nothing when no version is installed', () => {
    mockedGetInstalledVersion.mockReturnValue(null);

    checkForUpdateInBackground();

    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
