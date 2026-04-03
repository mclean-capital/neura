import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { NeuraConfigFile } from '@neura/types';

export interface ResolvedCoreConfig {
  port: number;
  xaiApiKey: string;
  googleApiKey: string;
  voice: string;
  pgDataPath: string | undefined;
  neuraHome: string;
}

function tryParseInt(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Load core configuration with priority: env vars > ~/.neura/config.json > defaults.
 *
 * - Local (OS service): Reads from config.json via NEURA_HOME env var
 * - Docker/cloud: Uses env vars exclusively
 * - Development: .env file via dotenv (import 'dotenv/config' before calling)
 */
export function loadConfig(): ResolvedCoreConfig {
  const neuraHome = process.env.NEURA_HOME ?? join(homedir(), '.neura');
  const configPath = join(neuraHome, 'config.json');

  let file: Partial<NeuraConfigFile> = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<NeuraConfigFile>;
    } catch {
      // Malformed config.json — fall through to defaults
    }
  }

  const pgDataPathDefault = existsSync(neuraHome) ? join(neuraHome, 'pgdata') : undefined;

  return {
    port: tryParseInt(process.env.PORT) ?? file.port ?? 3002,
    xaiApiKey: process.env.XAI_API_KEY ?? file.apiKeys?.xai ?? '',
    googleApiKey: process.env.GOOGLE_API_KEY ?? file.apiKeys?.google ?? '',
    voice: process.env.NEURA_VOICE ?? file.voice ?? 'eve',
    pgDataPath:
      process.env.PG_DATA_PATH ?? process.env.DB_PATH ?? file.pgDataPath ?? pgDataPathDefault,
    neuraHome,
  };
}
