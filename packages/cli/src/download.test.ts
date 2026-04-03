import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('os', () => ({
  platform: vi.fn(() => 'linux'),
  arch: vi.fn(() => 'x64'),
}));

vi.mock('./config.js', () => ({
  getNeuraHome: vi.fn(() => '/home/testuser/.neura'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { existsSync } from 'fs';
import { platform, arch } from 'os';
import { getNeuraHome } from './config.js';
import { getLatestVersion, downloadCore, hasCoreBinary, getCoreBinaryPath } from './download.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedPlatform = vi.mocked(platform);
const mockedArch = vi.mocked(arch);
const mockedGetNeuraHome = vi.mocked(getNeuraHome);

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform.mockReturnValue('linux');
  mockedArch.mockReturnValue('x64');
  mockedGetNeuraHome.mockReturnValue('/home/testuser/.neura');
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

describe('downloadCore', () => {
  it('throws with a clear error (placeholder)', () => {
    expect(() => downloadCore('v1.0.0')).toThrow('Core binary download is not yet available');
  });

  it('error message includes build-from-source instructions', () => {
    expect(() => downloadCore('v1.0.0')).toThrow('run core directly from source');
  });
});

describe('hasCoreBinary', () => {
  it('checks the correct path on Linux', () => {
    mockedPlatform.mockReturnValue('linux');
    mockedExistsSync.mockReturnValue(true);

    expect(hasCoreBinary()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.neura[/\\]core[/\\]neura-core$/)
    );
  });

  it('checks for .exe on Windows', () => {
    mockedPlatform.mockReturnValue('win32');
    mockedExistsSync.mockReturnValue(false);

    expect(hasCoreBinary()).toBe(false);
    expect(mockedExistsSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.neura[/\\]core[/\\]neura-core\.exe$/)
    );
  });

  it('returns false when binary does not exist', () => {
    mockedExistsSync.mockReturnValue(false);

    expect(hasCoreBinary()).toBe(false);
  });
});

describe('getCoreBinaryPath', () => {
  it('returns path without extension on Linux', () => {
    mockedPlatform.mockReturnValue('linux');

    const path = getCoreBinaryPath();

    expect(path).toMatch(/\.neura[/\\]core[/\\]neura-core$/);
    expect(path).not.toMatch(/\.exe$/);
  });

  it('returns path with .exe on Windows', () => {
    mockedPlatform.mockReturnValue('win32');

    const path = getCoreBinaryPath();

    expect(path).toMatch(/\.neura[/\\]core[/\\]neura-core\.exe$/);
  });

  it('returns path without extension on macOS', () => {
    mockedPlatform.mockReturnValue('darwin');

    const path = getCoreBinaryPath();

    expect(path).toMatch(/\.neura[/\\]core[/\\]neura-core$/);
    expect(path).not.toMatch(/\.exe$/);
  });
});
