/**
 * Bridge Neura's config.providers into pi-coding-agent's AuthStorage.
 *
 * Pi resolves API keys from its own `auth.json` by default; Neura stores
 * credentials in `~/.neura/config.json` under `providers.<id>.apiKey`.
 * Without a handoff, pi throws "No API key found for <provider>" on
 * the first session prompt and every worker dispatch fails silently.
 *
 * We use `setRuntimeApiKey` (priority 1 in pi's resolution order, ahead
 * of the on-disk file) so config.json stays the single source of truth.
 * Runtime keys are held in memory and are NOT persisted. Note that pi's
 * `AuthStorage.create()` will still create an empty `{}` auth.json at
 * the configured path — that's pi's own bookkeeping, not a forked copy
 * of our credentials.
 */

import type { AuthStorage } from '@mariozechner/pi-coding-agent';
import type { ProviderCredentials } from '@neura/types';

/**
 * Seed an AuthStorage instance with every provider from Neura's config
 * that has an apiKey set. No-ops for entries without a key. Returns the
 * number of providers seeded — useful for startup logs.
 */
export function seedAuthStorageFromConfig(
  authStorage: AuthStorage,
  providers: Record<string, ProviderCredentials>
): number {
  let count = 0;
  for (const [providerId, creds] of Object.entries(providers)) {
    if (creds?.apiKey) {
      authStorage.setRuntimeApiKey(providerId, creds.apiKey);
      count++;
    }
  }
  return count;
}
