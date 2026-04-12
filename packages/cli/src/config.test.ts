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
      providers: {},
      routing: {
        voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
        vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
        text: { provider: 'google', model: 'gemini-2.5-flash' },
        embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
        worker: { provider: 'xai', model: 'grok-4-fast' },
      },
    });
  });

  it('parses a valid config.json correctly', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        providers: { xai: { apiKey: 'xai-key-123' }, google: { apiKey: 'goog-key-456' } },
        routing: {
          voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
          vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
          text: { provider: 'google', model: 'gemini-2.5-flash' },
          embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
          worker: { provider: 'xai', model: 'grok-4-fast' },
        },
        port: 4000,
        pgDataPath: '/data/pgdata',
      })
    );

    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.providers.xai?.apiKey).toBe('xai-key-123');
    expect(config.providers.google?.apiKey).toBe('goog-key-456');
    expect(config.routing.voice).toEqual({
      mode: 'realtime',
      provider: 'xai',
      model: 'grok-realtime',
    });
    expect(config.pgDataPath).toBe('/data/pgdata');
  });

  it('fills missing fields with defaults', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ port: 5000 }));

    const config = loadConfig();

    expect(config.port).toBe(5000);
    expect(config.providers).toEqual({});
    expect(config.routing).toEqual({
      voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
      vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
      text: { provider: 'google', model: 'gemini-2.5-flash' },
      embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
      worker: { provider: 'xai', model: 'grok-4-fast' },
    });
  });

  it('returns defaults on malformed JSON', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json {{{');

    const config = loadConfig();

    expect(config).toEqual({
      providers: {},
      routing: {
        voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
        vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
        text: { provider: 'google', model: 'gemini-2.5-flash' },
        embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
        worker: { provider: 'xai', model: 'grok-4-fast' },
      },
    });
  });
});

describe('saveConfig', () => {
  it('writes JSON to the correct path', () => {
    const config = {
      providers: {},
      routing: {
        voice: { mode: 'realtime' as const, provider: 'xai', model: 'grok-realtime' },
        vision: { mode: 'streaming' as const, provider: 'google', model: 'gemini-2.5-flash' },
        text: { provider: 'google', model: 'gemini-2.5-flash' },
        embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
        worker: { provider: 'xai', model: 'grok-4-fast' },
      },
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
      providers: {},
      routing: {
        voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
        vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
        text: { provider: 'google', model: 'gemini-2.5-flash' },
        embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
        worker: { provider: 'xai', model: 'grok-4-fast' },
      },
    });

    expect(mockedChmodSync).toHaveBeenCalledWith(expect.stringContaining('config.json'), 0o600);
  });

  it('does not chmod on Windows', () => {
    mockedPlatform.mockReturnValue('win32');

    saveConfig({
      providers: {},
      routing: {
        voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
        vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
        text: { provider: 'google', model: 'gemini-2.5-flash' },
        embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
        worker: { provider: 'xai', model: 'grok-4-fast' },
      },
    });

    expect(mockedChmodSync).not.toHaveBeenCalled();
  });
});

describe('getConfigValue', () => {
  it('resolves dot-notation keys (e.g., providers.xai.apiKey)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        providers: { xai: { apiKey: 'my-xai-key' } },
        routing: {
          voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
          vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
          text: { provider: 'google', model: 'gemini-2.5-flash' },
          embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
          worker: { provider: 'xai', model: 'grok-4-fast' },
        },
      })
    );

    expect(getConfigValue('providers.xai.apiKey')).toBe('my-xai-key');
  });

  it('resolves top-level keys', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        providers: {},
        routing: {
          voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
          vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
          text: { provider: 'google', model: 'gemini-2.5-flash' },
          embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
          worker: { provider: 'xai', model: 'grok-4-fast' },
        },
        port: 4000,
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
        providers: { xai: { apiKey: 'test' } },
        routing: {
          voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
          vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
          text: { provider: 'google', model: 'gemini-2.5-flash' },
          embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
          worker: { provider: 'xai', model: 'grok-4-fast' },
        },
      })
    );

    expect(getConfigValue('providers.openai.apiKey')).toBeUndefined();
  });
});

describe('setConfigValue', () => {
  beforeEach(() => {
    // setConfigValue calls loadConfig internally, set up default
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        providers: { xai: { apiKey: '' }, google: { apiKey: '' } },
        routing: {
          voice: { mode: 'realtime', provider: 'xai', model: 'grok-realtime' },
          vision: { mode: 'streaming', provider: 'google', model: 'gemini-2.5-flash' },
          text: { provider: 'google', model: 'gemini-2.5-flash' },
          embedding: { provider: 'google', model: 'gemini-embedding-2-preview', dimensions: 3072 },
          worker: { provider: 'xai', model: 'grok-4-fast' },
        },
      })
    );
  });

  it('sets nested keys correctly', () => {
    setConfigValue('providers.xai.apiKey', 'new-key-value');

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.providers.xai.apiKey).toBe('new-key-value');
  });

  it('coerces "true" to boolean true', () => {
    setConfigValue('autoUpdate', 'true');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.autoUpdate).toBe(true);
  });

  it('coerces "false" to boolean false', () => {
    setConfigValue('autoUpdate', 'false');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.autoUpdate).toBe(false);
  });

  it('coerces "3002" to number', () => {
    setConfigValue('port', '3002');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.port).toBe(3002);
  });

  it('keeps non-numeric, non-boolean strings as strings', () => {
    setConfigValue('assistantName', 'jarvis');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.assistantName).toBe('jarvis');
  });

  it('creates intermediate objects for new nested paths', () => {
    setConfigValue('newSection.nested', 'value');

    const written = JSON.parse(String(mockedWriteFileSync.mock.calls[0][1]));
    expect(written.newSection.nested).toBe('value');
  });
});
