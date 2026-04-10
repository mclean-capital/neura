import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir, platform } from 'os';
import type { NeuraConfigFile } from '@neura/types';

export type { NeuraConfigFile };

const DEFAULT_CONFIG: NeuraConfigFile = {
  port: 0, // 0 = not yet assigned; neura install will auto-assign
  voice: 'eve',
  apiKeys: { xai: '', google: '' },
  service: { autoStart: true, logLevel: 'info' },
};

export function getNeuraHome(): string {
  return process.env.NEURA_HOME ?? join(homedir(), '.neura');
}

export function getConfigPath(): string {
  return join(getNeuraHome(), 'config.json');
}

export function ensureNeuraHome(): void {
  const home = getNeuraHome();
  for (const dir of [
    home,
    join(home, 'core'),
    join(home, 'logs'),
    join(home, 'service'),
    join(home, 'pgdata'),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): NeuraConfigFile {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<NeuraConfigFile>;
    return {
      port: raw.port ?? DEFAULT_CONFIG.port,
      voice: raw.voice ?? DEFAULT_CONFIG.voice,
      apiKeys: {
        xai: raw.apiKeys?.xai ?? '',
        google: raw.apiKeys?.google ?? '',
      },
      service: {
        autoStart: raw.service?.autoStart ?? true,
        logLevel: raw.service?.logLevel ?? 'info',
      },
      pgDataPath: raw.pgDataPath,
      autoUpdate: raw.autoUpdate,
      authToken: process.env.NEURA_AUTH_TOKEN ?? raw.authToken,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: NeuraConfigFile): void {
  ensureNeuraHome();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // Restrict file permissions to owner-only on Unix
  if (platform() !== 'win32') {
    chmodSync(configPath, 0o600);
  }
}

/** Generate a cryptographically random 256-bit auth token. */
export function generateAuthToken(): string {
  return randomBytes(32).toString('hex');
}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
export function getConfigValue(key: string): string | undefined {
  const config = loadConfig();
  const parts = key.split('.');

  let current: any = config;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current != null ? String(current) : undefined;
}

export function setConfigValue(key: string, value: string): void {
  const config = loadConfig();
  const parts = key.split('.');

  if (parts.some((p) => BLOCKED_KEYS.has(p))) {
    throw new Error(`Invalid config key: ${key}`);
  }

  const last = parts.pop()!;

  let current: any = config;
  for (const part of parts) {
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }

  // Coerce booleans and numbers
  if (value === 'true') current[last] = true;
  else if (value === 'false') current[last] = false;
  else if (/^\d+$/.test(value)) current[last] = parseInt(value, 10);
  else current[last] = value;

  saveConfig(config);
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
