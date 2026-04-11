import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', () => ({
  platform: vi.fn(() => 'linux'),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { platform } from 'os';
import { detectPlatform, getPlatformLabel } from './detect.js';

const mockedPlatform = vi.mocked(platform);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectPlatform', () => {
  it('returns "windows" for win32', () => {
    mockedPlatform.mockReturnValue('win32');
    expect(detectPlatform()).toBe('windows');
  });

  it('returns "macos" for darwin', () => {
    mockedPlatform.mockReturnValue('darwin');
    expect(detectPlatform()).toBe('macos');
  });

  it('returns "linux" for linux', () => {
    mockedPlatform.mockReturnValue('linux');
    expect(detectPlatform()).toBe('linux');
  });

  it('returns "linux" for unknown platforms (default case)', () => {
    mockedPlatform.mockReturnValue('freebsd' as NodeJS.Platform);
    expect(detectPlatform()).toBe('linux');
  });
});

describe('getPlatformLabel', () => {
  it('returns Windows label', () => {
    mockedPlatform.mockReturnValue('win32');
    expect(getPlatformLabel()).toBe('Windows Scheduled Task (user logon)');
  });

  it('returns macOS label', () => {
    mockedPlatform.mockReturnValue('darwin');
    expect(getPlatformLabel()).toBe('launchd Agent');
  });

  it('returns Linux label', () => {
    mockedPlatform.mockReturnValue('linux');
    expect(getPlatformLabel()).toBe('systemd User Service');
  });
});
