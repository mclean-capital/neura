import { PROVIDER_PRESETS } from './providers.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a provider API key by hitting the provider's test endpoint.
 * Returns { valid: true } on success, { valid: false, error } on failure.
 *
 * Custom providers attempt `GET {baseUrl}/models` with Bearer auth.
 * If the provider has no known validation endpoint, returns valid (best-effort).
 */
export async function validateProviderKey(
  providerId: string,
  apiKey: string,
  baseUrl?: string
): Promise<ValidationResult> {
  const preset = PROVIDER_PRESETS[providerId];

  // Custom or unknown provider — try baseUrl/models if available
  if (!preset?.validation) {
    if (!baseUrl) return { valid: true }; // Can't validate, assume ok

    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { valid: false, error: `HTTP ${res.status} from ${baseUrl}/models` };
      }
      return { valid: true };
    } catch {
      // Best-effort: can't reach the endpoint but the key might still be fine
      return { valid: true };
    }
  }

  const { url, headerKey, headerFormat } = preset.validation;
  const headerValue = headerFormat.replace('{key}', apiKey);

  try {
    const res = await fetch(url, {
      headers: { [headerKey]: headerValue },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return {
        valid: false,
        error: `Invalid key (HTTP ${res.status})`,
      };
    }

    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('AbortError') || msg.includes('timeout')) {
      return { valid: false, error: 'Request timed out — check your connection' };
    }
    return { valid: false, error: `Network error: ${msg}` };
  }
}
