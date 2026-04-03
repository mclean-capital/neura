import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./detect.js', () => ({
  detectPlatform: vi.fn(() => 'linux'),
}));

import { detectPlatform } from './detect.js';
import { getServiceManager, type ServiceManager } from './manager.js';

const mockedDetectPlatform = vi.mocked(detectPlatform);

const mockManager: ServiceManager = {
  isInstalled: vi.fn(() => false),
  isRunning: vi.fn(() => false),
  install: vi.fn(),
  uninstall: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  getLogPath: vi.fn(() => '/tmp/neura.log'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getServiceManager', () => {
  it('dynamically imports the windows module when platform is windows', async () => {
    mockedDetectPlatform.mockReturnValue('windows');

    // Mock the dynamic import for windows
    vi.doMock('./windows.js', () => ({ default: mockManager }));

    const manager = await getServiceManager();
    expect(manager).toBe(mockManager);
    expect(mockedDetectPlatform).toHaveBeenCalled();
  });

  it('dynamically imports the macos module when platform is macos', async () => {
    mockedDetectPlatform.mockReturnValue('macos');

    vi.doMock('./macos.js', () => ({ default: mockManager }));

    const manager = await getServiceManager();
    expect(manager).toBe(mockManager);
  });

  it('dynamically imports the linux module when platform is linux', async () => {
    mockedDetectPlatform.mockReturnValue('linux');

    vi.doMock('./linux.js', () => ({ default: mockManager }));

    const manager = await getServiceManager();
    expect(manager).toBe(mockManager);
  });

  it('returns the .default export of the imported module', async () => {
    mockedDetectPlatform.mockReturnValue('linux');

    const customManager: ServiceManager = {
      ...mockManager,
      getLogPath: vi.fn(() => '/var/log/neura.log'),
    };
    vi.doMock('./linux.js', () => ({ default: customManager }));

    const manager = await getServiceManager();
    expect(manager.getLogPath()).toBe('/var/log/neura.log');
  });
});
