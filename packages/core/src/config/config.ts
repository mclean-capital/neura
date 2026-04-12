import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type {
  NeuraConfigFile,
  RetrievalStrategy,
  RoutingConfig,
  ProviderCredentials,
  MemoryTierConfig,
} from '@neura/types';
import { neuraConfigSchema, isV2Config } from '@neura/types';
import { Logger } from '@neura/utils/logger';

const log = new Logger('config');

export interface ResolvedCoreConfig {
  port: number;
  providers: Record<string, ProviderCredentials>;
  routing: RoutingConfig;
  pgDataPath: string | undefined;
  neuraHome: string;
  assistantName: string;
  wakeWord: string;
  retrievalStrategy: RetrievalStrategy;
  memoryTiers?: MemoryTierConfig;
  authToken: string;
}

/**
 * Load core configuration with priority: env vars > ~/.neura/config.json > defaults.
 *
 * v3 config schema: provider-agnostic with capability-based routing.
 * Detects v2 config format and prints clear upgrade instructions.
 */
export function loadConfig(): ResolvedCoreConfig {
  const neuraHome = process.env.NEURA_HOME ?? join(homedir(), '.neura');
  const configPath = join(neuraHome, 'config.json');

  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      log.warn('malformed config.json, using defaults');
    }
  }

  // Detect v2 config and provide upgrade guidance
  if (isV2Config(raw)) {
    throw new Error(
      'Detected Neura v2 config format (apiKeys.xai / apiKeys.google).\n' +
        'Neura v3 uses a new provider-agnostic config schema.\n' +
        'Please migrate your ~/.neura/config.json to the v3 format.\n' +
        'See: https://github.com/mclean-capital/neura/blob/main/docs/model-agnostic-refactor-plan.md\n\n' +
        'Example v3 config:\n' +
        '{\n' +
        '  "providers": { "xai": { "apiKey": "xai-..." }, "google": { "apiKey": "AIza..." } },\n' +
        '  "routing": {\n' +
        '    "voice": { "mode": "realtime", "provider": "xai", "model": "grok-3-fast" },\n' +
        '    "vision": { "mode": "streaming", "provider": "google", "model": "gemini-2.5-flash" },\n' +
        '    "text": { "provider": "google", "model": "gemini-2.5-flash" },\n' +
        '    "embedding": { "provider": "google", "model": "gemini-embedding-2-preview", "dimensions": 3072 },\n' +
        '    "worker": { "provider": "xai", "model": "grok-4-fast" }\n' +
        '  }\n' +
        '}'
    );
  }

  // Apply env var overrides for provider API keys: NEURA_PROVIDER_{ID}_API_KEY
  const file = (raw ?? {}) as Partial<NeuraConfigFile>;
  const providers = { ...(file.providers ?? {}) };
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^NEURA_PROVIDER_(\w+)_API_KEY$/.exec(key);
    if (match && value) {
      const providerId = match[1].toLowerCase();
      providers[providerId] = {
        ...(providers[providerId] ?? {}),
        apiKey: value,
      } as ProviderCredentials;
    }
  }

  // Apply env var overrides for routing: NEURA_ROUTING_{CAP}_{FIELD}
  // Coerces numeric strings to numbers (e.g. NEURA_ROUTING_EMBEDDING_DIMENSIONS=768)
  // Creates route objects when they don't exist yet (enables env-only config)
  const routing = { ...(file.routing ?? {}) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^NEURA_ROUTING_(\w+)_(\w+)$/.exec(key);
    if (match && value) {
      const cap = match[1].toLowerCase();
      const field = match[2].toLowerCase();
      // Create the route object if it doesn't exist
      if (routing[cap] == null) {
        routing[cap] = {};
      }
      if (typeof routing[cap] === 'object') {
        const coerced = /^\d+$/.test(value) ? parseInt(value, 10) : value;
        (routing[cap] as Record<string, unknown>)[field] = coerced;
      }
    }
  }

  // Build merged config
  const merged = {
    ...file,
    providers,
    routing,
    port: tryParseInt(process.env.PORT) ?? file.port,
    pgDataPath: process.env.PG_DATA_PATH ?? process.env.DB_PATH ?? file.pgDataPath,
    authToken: process.env.NEURA_AUTH_TOKEN ?? file.authToken,
    assistantName: process.env.NEURA_ASSISTANT_NAME ?? file.assistantName,
    wakeWord: process.env.NEURA_WAKE_WORD ?? file.wakeWord,
    retrievalStrategy: process.env.NEURA_RETRIEVAL_STRATEGY ?? file.retrievalStrategy,
    autoUpdate: file.autoUpdate,
    memoryTiers: file.memoryTiers,
  };

  // Validate with Zod
  const result = neuraConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid Neura config:\n${issues}\n\n` +
        'See: https://github.com/mclean-capital/neura/blob/main/docs/model-agnostic-refactor-plan.md'
    );
  }

  const config = result.data as NeuraConfigFile;
  const pgDataPathDefault = existsSync(neuraHome) ? join(neuraHome, 'pgdata') : undefined;

  return {
    port: config.port ?? 3002,
    providers: config.providers,
    routing: config.routing,
    pgDataPath: config.pgDataPath ?? pgDataPathDefault,
    neuraHome,
    assistantName: config.assistantName ?? 'jarvis',
    wakeWord: config.wakeWord ?? 'jarvis',
    retrievalStrategy: config.retrievalStrategy ?? 'hybrid',
    memoryTiers: config.memoryTiers,
    authToken: config.authToken ?? '',
  };
}

function tryParseInt(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}
