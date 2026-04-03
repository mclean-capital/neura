/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-base-to-string */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  platform: vi.fn(() => 'linux'),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir, platform } from 'os';
import {
  getNeuraHome,
  getConfigPath,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
} from './config.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedChmodSync = vi.mocked(chmodSync);
const mockedHomedir = vi.mocked(homedir);
const mockedPlatform = vi.mocked(platform);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEURA_HOME;
  mockedHomedir.mockReturnValue('/home/testuser');
  mockedPlatform.mockReturnValue('linux');
});

describe('getNeuraHome', () => {
  it('returns NEURA_HOME env var when set', () => {
    process.env.NEURA_HOME = '/custom/neura';
    expect(getNeuraHome()).toBe('/custom/neura');
  });

  it('falls back to ~/.neura when NEURA_HOME is not set', () => {
    const result = getNeuraHome();
    // Use path-separator-agnostic check for cross-platform compatibility
    expect(result).toMatch(/[/\\]home[/\\]testuser[/\\]\.neura$/);
  });
});

describe('getConfigPath', () => {
  it('returns config.json inside neura home', () => {
    expect(getConfigPath()).toMatch(/\.neura[/\\]config\.json$/);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    mockedExistsSync.mockReturnValue(false);

    const config = loadConfig();

    expect(config).toEqual({
      port: 0,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });
  });

  it('parses a valid config.json correctly', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        port: 4000,
        voice: 'custom',
        apiKeys: { xai: 'xai-key-123', google: 'goog-key-456' },
        service: { autoStart: false, logLevel: 'debug' },
        dbPath: '/data/neura.db',
      })
    );

    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.voice).toBe('custom');
    expect(config.apiKeys.xai).toBe('xai-key-123');
    expect(config.apiKeys.google).toBe('goog-key-456');
    expect(config.service.autoStart).toBe(false);
    expect(config.service.logLevel).toBe('debug');
    expect(config.dbPath).toBe('/data/neura.db');
  });

  it('fills missing fields with defaults', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ port: 5000 }));

    const config = loadConfig();

    expect(config.port).toBe(5000);
    expect(config.voice).toBe('eve');
    expect(config.apiKeys.xai).toBe('');
    expect(config.apiKeys.google).toBe('');
    expect(config.service.autoStart).toBe(true);
    expect(config.service.logLevel).toBe('info');
  });

  it('returns defaults on malformed JSON', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json {{{');

    const config = loadConfig();

    expect(config).toEqual({
      port: 0,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });
  });
});

describe('saveConfig', () => {
  it('writes JSON to the correct path', () => {
    const config = {
      port: 0,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' as string },
    };

    saveConfig(config);

    expect(mockedMkdirSync).toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockedWriteFileSync.mock.calls[0];
    expect(String(path)).toMatch(/config\.json$/);
    expect(JSON.parse(String(content))).toEqual(config);
  });

  it('sets chmod 0o600 on Unix', () => {
    mockedPlatform.mockReturnValue('linux');

    saveConfig({
      port: 0,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });

    expect(mockedChmodSync).toHaveBeenCalledWith(expect.stringContaining('config.json'), 0o600);
  });

  it('does not chmod on Windows', () => {
    mockedPlatform.mockReturnValue('win32');

    saveConfig({
      port: 0,
      voice: 'eve',
      apiKeys: { xai: '', google: '' },
      service: { autoStart: true, logLevel: 'info' },
    });

    expect(mockedChmodSync).not.toHaveBeenCalled();
  });
});

describe('getConfigValue', () => {
  it('resolves dot-notation keys (e.g., apiKeys.xai)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        port: 0,
        voice: 'eve',
        apiKeys: { xai: 'my-xai-key', google: '' },
        service: { autoStart: true, logLevel: 'info' },
      })
    );

    expect(getConfigValue('apiKeys.xai')).toBe('my-xai-key');
  });

  it('resolves top-level keys', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        port: 4000,
        voice: 'eve',
        apiKeys: { xai: '', google: '' },
        service: { autoStart: true, logLevel: 'info' },
      })
    );

    expect(getConfigValue('port')).toBe('4000');
  });

  it('returns undefined for missing keys', () => {
    mockedExistsSync.mockReturnValue(false);

    expect(getConfigValue('nonexistent.key')).toBeUndefined();
  });

  it('returns undefined for deeply missing keys', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        port: 0,
        voice: 'eve',
        apiKeys: { xai: '', google: '' },
        service: { autoStart: true, logLevel: 'info' },
      })
    );

    expect(getConfigValue('apiKeys.openai')).toBeUndefined();
  });
});

describe('setConfigValue', () => {
  beforeEach(() => {
    // setConfigValue calls loadConfig internally, set up default
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        port: 0,
        voice: 'eve',
        apiKeys: { xai: '', google: '' },
        service: { autoStart: true, logLevel: 'info' },
      })
    );
  });

  it('sets nested keys correctly', () => {
    setConfigValue('apiKeys.xai', 'new-key-value');

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.apiKeys.xai).toBe('new-key-value');
  });

  it('coerces "true" to boolean true', () => {
    setConfigValue('service.autoStart', 'true');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.service.autoStart).toBe(true);
  });

  it('coerces "false" to boolean false', () => {
    setConfigValue('service.autoStart', 'false');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.service.autoStart).toBe(false);
  });

  it('coerces "3002" to number', () => {
    setConfigValue('port', '3002');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.port).toBe(3002);
  });

  it('keeps non-numeric, non-boolean strings as strings', () => {
    setConfigValue('voice', 'custom-voice');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.voice).toBe('custom-voice');
  });

  it('creates intermediate objects for new nested paths', () => {
    setConfigValue('newSection.nested', 'value');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.newSection.nested).toBe('value');
  });
});
