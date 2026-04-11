import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
import { hasCoreBinary, getCoreBinaryPath, getInstalledCoreVersion } from './download.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCoreBinaryPath', () => {
  it('resolves server.bundled.mjs relative to this package', () => {
    const path = getCoreBinaryPath();
    // The path should end in core/server.bundled.mjs and should NOT be
    // inside ~/.neura anymore (that was the pre-1.11.0 layout).
    expect(path).toMatch(/core[/\\]server\.bundled\.mjs$/);
    expect(path).not.toMatch(/\.neura[/\\]core[/\\]server/);
  });
});

describe('hasCoreBinary', () => {
  it('returns true when the bundled core exists', () => {
    mockedExistsSync.mockReturnValue(true);
    expect(hasCoreBinary()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(
      expect.stringMatching(/core[/\\]server\.bundled\.mjs$/)
    );
  });

  it('returns false when the bundled core is missing', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(hasCoreBinary()).toBe(false);
  });
});

describe('getInstalledCoreVersion', () => {
  it('reads version from version.txt next to the bundle', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('1.11.0\n');

    expect(getInstalledCoreVersion()).toBe('1.11.0');
    expect(mockedExistsSync).toHaveBeenCalledWith(expect.stringMatching(/core[/\\]version\.txt$/));
  });

  it('returns null when version.txt does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(getInstalledCoreVersion()).toBeNull();
  });
});
