import { describe, it, expect } from 'vitest';
import { AuthStorage } from '@mariozechner/pi-coding-agent';
import type { ProviderCredentials } from '@neura/types';
import { seedAuthStorageFromConfig } from './auth-bridge.js';

describe('seedAuthStorageFromConfig', () => {
  it('installs runtime api keys from every provider with an apiKey', async () => {
    const storage = AuthStorage.inMemory();
    const providers: Record<string, ProviderCredentials> = {
      xai: { apiKey: 'xai-key-123' },
      openai: { apiKey: 'openai-key-456' },
    };
    const count = seedAuthStorageFromConfig(storage, providers);
    expect(count).toBe(2);
    await expect(storage.getApiKey('xai')).resolves.toBe('xai-key-123');
    await expect(storage.getApiKey('openai')).resolves.toBe('openai-key-456');
  });

  it('skips providers without an apiKey', async () => {
    const storage = AuthStorage.inMemory();
    // Cast through `unknown` to simulate a partial/corrupt config row —
    // zod schema rejects this at load, but the helper must still be
    // defensive against an empty record or missing apiKey shape.
    const providers = {
      xai: { apiKey: 'xai-key' },
      broken: {},
    } as unknown as Record<string, ProviderCredentials>;
    const count = seedAuthStorageFromConfig(storage, providers);
    expect(count).toBe(1);
    await expect(storage.getApiKey('broken')).resolves.toBeUndefined();
  });

  it('handles an empty provider map without throwing', () => {
    const storage = AuthStorage.inMemory();
    expect(seedAuthStorageFromConfig(storage, {})).toBe(0);
  });

  it('does not persist keys to disk (runtime override only)', async () => {
    // Without write access to a real auth.json path, a persisted key
    // would throw. `setRuntimeApiKey` is documented as in-memory only,
    // so seeding should succeed even against an AuthStorage whose
    // backend file is unwritable — we verify by using inMemory() where
    // any persistence attempt would surface.
    const storage = AuthStorage.inMemory();
    seedAuthStorageFromConfig(storage, { xai: { apiKey: 'runtime-only' } });
    // `has()` checks auth.json only (not runtime overrides); a runtime
    // override should NOT show up there.
    expect(storage.has('xai')).toBe(false);
    // But getApiKey resolves via the runtime override layer.
    await expect(storage.getApiKey('xai')).resolves.toBe('runtime-only');
  });
});
