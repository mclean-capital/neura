import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), end: vi.fn() })),
  chmodSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  renameSync: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    platform: vi.fn(() => 'linux'),
    arch: vi.fn(() => 'x64'),
  };
});

vi.mock('./config.js', () => ({
  getNeuraHome: vi.fn(() => '/home/testuser/.neura'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { existsSync, readFileSync, rmSync } from 'fs';
import { platform, arch } from 'os';
import {
  getLatestVersion,
  getPlatformTarget,
  hasCoreBinary,
  getCoreBinaryPath,
  getInstalledCoreVersion,
  downloadCore,
} from './download.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedPlatform = vi.mocked(platform);
const mockedArch = vi.mocked(arch);

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform.mockReturnValue('linux');
  mockedArch.mockReturnValue('x64');
});

describe('getLatestVersion', () => {
  it('parses tag_name from GitHub API response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tag_name: 'v1.2.3' }),
    });

    const version = await getLatestVersion();

    expect(version).toBe('v1.2.3');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.github.com/repos/mclean-capital/neura/releases/latest'),
      expect.objectContaining({
        headers: { Accept: 'application/vnd.github.v3+json' },
      })
    );
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(getLatestVersion()).rejects.toThrow('GitHub API error: 404');
  });
});

describe('getPlatformTarget', () => {
  it('detects linux x64', () => {
    mockedPlatform.mockReturnValue('linux');
    mockedArch.mockReturnValue('x64');
    expect(getPlatformTarget()).toEqual({ os: 'linux', arch: 'x64', ext: '' });
  });

  it('detects darwin arm64', () => {
    mockedPlatform.mockReturnValue('darwin');
    mockedArch.mockReturnValue('arm64');
    expect(getPlatformTarget()).toEqual({ os: 'darwin', arch: 'arm64', ext: '' });
  });

  it('detects windows with .exe extension', () => {
    mockedPlatform.mockReturnValue('win32');
    mockedArch.mockReturnValue('x64');
    expect(getPlatformTarget()).toEqual({ os: 'windows', arch: 'x64', ext: '.exe' });
  });
});

describe('hasCoreBinary', () => {
  it('checks for server.bundled.mjs', () => {
    mockedExistsSync.mockReturnValue(true);

    expect(hasCoreBinary()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.neura[/\\]core[/\\]server\.bundled\.mjs$/)
    );
  });

  it('returns false when bundle does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(hasCoreBinary()).toBe(false);
  });
});

describe('getCoreBinaryPath', () => {
  it('returns path to server.bundled.mjs', () => {
    const path = getCoreBinaryPath();
    expect(path).toMatch(/\.neura[/\\]core[/\\]server\.bundled\.mjs$/);
  });
});

describe('getInstalledCoreVersion', () => {
  it('reads version from version.txt', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('1.0.0\n');

    expect(getInstalledCoreVersion()).toBe('1.0.0');
  });

  it('returns null when version.txt does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(getInstalledCoreVersion()).toBeNull();
  });
});

describe('downloadCore', () => {
  const mockedRmSync = vi.mocked(rmSync);

  it('throws helpful message when release exists but asset is missing (404)', async () => {
    // First fetch: download asset → 404
    // Second fetch: check if release exists → 200
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tag_name: 'v1.3.0' }) });

    await expect(downloadCore('v1.3.0')).rejects.toThrow('not yet available');

    // Staging directory should be cleaned up even on error
    expect(mockedRmSync).toHaveBeenCalledWith(
      expect.stringContaining('neura-update-'),
      expect.objectContaining({ recursive: true, force: true })
    );
  });

  it('throws generic error when release does not exist (404)', async () => {
    // First fetch: download asset → 404
    // Second fetch: check release → also 404
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(downloadCore('v9.9.9')).rejects.toThrow('Download failed: 404');

    // Staging directory should be cleaned up even on error
    expect(mockedRmSync).toHaveBeenCalledWith(
      expect.stringContaining('neura-update-'),
      expect.objectContaining({ recursive: true, force: true })
    );
  });
});
