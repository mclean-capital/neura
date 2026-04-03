/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  getNeuraHome: vi.fn(() => '/home/testuser/.neura'),
}));

// Mock chalk to pass through strings without ANSI codes
vi.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
}));

import { loadConfig, getConfigValue, setConfigValue, getNeuraHome } from '../config.js';
import {
  configListCommand,
  configGetCommand,
  configSetCommand,
  configPathCommand,
} from './config.js';

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedGetConfigValue = vi.mocked(getConfigValue);
const mockedSetConfigValue = vi.mocked(setConfigValue);
const mockedGetNeuraHome = vi.mocked(getNeuraHome);

let consoleSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    /* noop */
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

describe('configListCommand', () => {
  it('outputs all config fields', () => {
    mockedLoadConfig.mockReturnValue({
      port: 3002,
      voice: 'eve',
      apiKeys: { xai: 'xai-abcdefghijklmnop', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });

    configListCommand();

    const output = consoleSpy.mock.calls.map((c: string[]) => c[0] ?? '').join('\n');
    expect(output).toContain('port');
    expect(output).toContain('3002');
    expect(output).toContain('voice');
    expect(output).toContain('eve');
    expect(output).toContain('apiKeys.xai');
    expect(output).toContain('apiKeys.google');
    expect(output).toContain('service.autoStart');
    expect(output).toContain('service.logLevel');
  });

  it('redacts API keys that are set (shows first 8 chars + ...)', () => {
    mockedLoadConfig.mockReturnValue({
      port: 3002,
      voice: 'eve',
      apiKeys: { xai: 'xai-abcdefghijklmnop', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });

    configListCommand();

    const output = consoleSpy.mock.calls.map((c: string[]) => c[0] ?? '').join('\n');
    expect(output).toContain('xai-abcd...');
    // The full key should NOT appear
    expect(output).not.toContain('xai-abcdefghijklmnop');
  });

  it('shows (not set) for empty API keys', () => {
    mockedLoadConfig.mockReturnValue({
      port: 3002,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });

    configListCommand();

    const output = consoleSpy.mock.calls.map((c: string[]) => c[0] ?? '').join('\n');
    expect(output).toContain('(not set)');
  });
});

describe('configGetCommand', () => {
  it('outputs the value for a valid key', () => {
    mockedGetConfigValue.mockReturnValue('3002');

    configGetCommand('port');

    expect(consoleSpy).toHaveBeenCalledWith('3002');
  });

  it('redacts API keys (shows first 8 chars + ...)', () => {
    mockedGetConfigValue.mockReturnValue('xai-abcdefghijklmnop12345');

    configGetCommand('apiKeys.xai');

    expect(consoleSpy).toHaveBeenCalledWith('xai-abcd...');
  });

  it('redacts Google API key too', () => {
    mockedGetConfigValue.mockReturnValue('AIzaSyB-long-google-key');

    configGetCommand('apiKeys.google');

    expect(consoleSpy).toHaveBeenCalledWith('AIzaSyB-...');
  });

  it('exits with error for missing keys', () => {
    mockedGetConfigValue.mockReturnValue(undefined);

    configGetCommand('nonexistent.key');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('configSetCommand', () => {
  it('calls setConfigValue and prints confirmation', () => {
    configSetCommand('port', '4000');

    expect(mockedSetConfigValue).toHaveBeenCalledWith('port', '4000');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Set port'));
  });
});

describe('configPathCommand', () => {
  it('outputs the neura home path', () => {
    mockedGetNeuraHome.mockReturnValue('/home/testuser/.neura');

    configPathCommand();

    expect(consoleSpy).toHaveBeenCalledWith('/home/testuser/.neura');
  });
});
