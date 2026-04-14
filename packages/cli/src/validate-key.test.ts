import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateProviderKey } from './validate-key.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateProviderKey', () => {
  it('validates xAI key with Bearer auth', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey('xai', 'xai-test-key');

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer xai-test-key' },
      })
    );
  });

  it('validates Google key with x-goog-api-key header', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey('google', 'AIzaTest');

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models',
      expect.objectContaining({
        headers: { 'x-goog-api-key': 'AIzaTest' },
      })
    );
  });

  it('validates OpenAI key', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey('openai', 'sk-test');

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-test' },
      })
    );
  });

  it('validates Anthropic key with x-api-key header', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey('anthropic', 'sk-ant-test');

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: { 'x-api-key': 'sk-ant-test' },
      })
    );
  });

  it('validates Deepgram key with Token auth', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey('deepgram', 'dg-test');

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/projects',
      expect.objectContaining({
        headers: { Authorization: 'Token dg-test' },
      })
    );
  });

  it('validates ElevenLabs key with xi-api-key header', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey('elevenlabs', 'el-test');

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/user',
      expect.objectContaining({
        headers: { 'xi-api-key': 'el-test' },
      })
    );
  });

  it('returns invalid for HTTP error responses', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const result = await validateProviderKey('xai', 'bad-key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validateProviderKey('xai', 'test-key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('returns error on timeout', async () => {
    mockFetch.mockRejectedValue(new Error('AbortError'));

    const result = await validateProviderKey('xai', 'test-key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('validates custom provider with baseUrl', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await validateProviderKey(
      'my-custom',
      'custom-key',
      'https://api.custom.com/v1/'
    );

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.custom.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer custom-key' },
      })
    );
  });

  it('returns valid for custom provider when endpoint fails (best-effort)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validateProviderKey(
      'my-custom',
      'custom-key',
      'https://api.custom.com/v1'
    );

    // Custom providers gracefully accept on failure
    expect(result.valid).toBe(true);
  });

  it('returns valid for unknown provider without baseUrl', async () => {
    const result = await validateProviderKey('unknown', 'some-key');

    expect(result.valid).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
