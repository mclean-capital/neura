import { describe, it, expect } from 'vitest';
import { buildRoutingFromFeatures, getVoiceOptions, PROVIDER_PRESETS } from './providers.js';
import type { FeatureSelections } from './providers.js';

// ─── buildRoutingFromFeatures ──────────────────────────────────

describe('buildRoutingFromFeatures', () => {
  const base: FeatureSelections = {
    voice: 'skip',
    vision: 'skip',
    brainProvider: 'google',
    memoryProvider: 'skip',
    agentProvider: 'skip',
  };

  it('produces full routing for xai + google (default combo)', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      voice: 'realtime',
      vision: 'streaming',
      brainProvider: 'google',
      memoryProvider: 'google',
      agentProvider: 'xai',
    });

    expect(result.routing.voice).toEqual({
      mode: 'realtime',
      provider: 'xai',
      model: 'grok-realtime',
    });
    expect(result.routing.vision).toEqual({
      mode: 'streaming',
      provider: 'google',
      model: 'gemini-2.5-flash',
    });
    expect(result.routing.text).toEqual({
      provider: 'google',
      model: 'gemini-2.5-flash',
    });
    expect(result.routing.embedding).toEqual({
      provider: 'google',
      model: 'gemini-embedding-2-preview',
      dimensions: 3072,
    });
    expect(result.routing.worker).toEqual({
      provider: 'xai',
      model: 'grok-4-fast',
    });

    expect(result.capabilities.voice).toBe(true);
    expect(result.capabilities.vision).toBe(true);
    expect(result.capabilities.brain).toBe(true);
    expect(result.capabilities.memory).toBe(true);
    expect(result.capabilities.agents).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('handles OpenAI-only setup with snapshot vision', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      voice: 'skip',
      vision: 'snapshot',
      snapshotProvider: 'openai',
      brainProvider: 'openai',
      memoryProvider: 'openai',
      agentProvider: 'openai',
    });

    expect(result.routing.voice).toBeUndefined();
    expect(result.routing.vision).toEqual({
      mode: 'snapshot',
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });
    expect(result.routing.text?.provider).toBe('openai');
    expect(result.routing.embedding?.provider).toBe('openai');
    expect(result.routing.embedding?.dimensions).toBe(1536);
    expect(result.routing.worker?.provider).toBe('openai');

    expect(result.capabilities.voice).toBe(false);
    expect(result.capabilities.vision).toBe(true);
    expect(result.warnings).toContain('Voice skipped — Neura will be text-only.');
  });

  it('handles Anthropic brain + snapshot vision', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      vision: 'snapshot',
      snapshotProvider: 'anthropic',
      brainProvider: 'anthropic',
      memoryProvider: 'skip',
      agentProvider: 'anthropic',
    });

    expect(result.routing.text?.provider).toBe('anthropic');
    expect(result.routing.text?.model).toBe('claude-sonnet-4-6');
    expect(result.routing.vision?.provider).toBe('anthropic');
    expect(result.routing.worker?.provider).toBe('anthropic');
    expect(result.routing.embedding).toBeUndefined();

    expect(result.warnings).toContain(
      'Memory embedding skipped — cross-session recall will use keyword search only.'
    );
  });

  it('handles pipeline voice with deepgram + elevenlabs', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      voice: 'pipeline',
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      brainProvider: 'google',
    });

    expect(result.routing.voice).toEqual({
      mode: 'pipeline',
      stt: { provider: 'deepgram', model: 'nova-3' },
      llm: { provider: 'google', model: 'gemini-2.5-flash' },
      tts: { provider: 'elevenlabs', model: 'eleven_turbo_v2' },
    });
    expect(result.capabilities.voice).toBe(true);
  });

  it('handles pipeline voice with openai TTS', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      voice: 'pipeline',
      sttProvider: 'deepgram',
      ttsProvider: 'openai',
      brainProvider: 'openai',
    });

    expect(result.routing.voice).toEqual({
      mode: 'pipeline',
      stt: { provider: 'deepgram', model: 'nova-3' },
      llm: { provider: 'openai', model: 'gpt-4.1-mini' },
      tts: { provider: 'openai', model: 'tts-1' },
    });
  });

  it('deduplicates providers in requiredProviders', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      voice: 'realtime',
      vision: 'streaming',
      brainProvider: 'google',
      memoryProvider: 'google',
      agentProvider: 'xai',
    });

    // Google appears for vision + brain + memory (3 features)
    const googleFeatures = result.requiredProviders.get('google')!;
    expect(googleFeatures.length).toBe(3);

    // xAI appears for voice + agents (2 features)
    const xaiFeatures = result.requiredProviders.get('xai')!;
    expect(xaiFeatures.length).toBe(2);

    // Only 2 unique providers needed
    expect(result.requiredProviders.size).toBe(2);
  });

  it('sets warnings for skipped features', () => {
    const result = buildRoutingFromFeatures(base);

    expect(result.warnings).toContain('Voice skipped — Neura will be text-only.');
    expect(result.warnings).toContain('Vision skipped — no screen or camera awareness.');
    expect(result.warnings).toContain(
      'Memory embedding skipped — cross-session recall will use keyword search only.'
    );
  });

  it('handles custom provider for brain + agents', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      brainProvider: 'custom',
      agentProvider: 'together',
      customProvider: {
        name: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        model: 'meta-llama/Llama-4-Scout-17B-16E',
      },
    });

    expect(result.routing.text?.provider).toBe('together');
    expect(result.routing.text?.model).toBe('meta-llama/Llama-4-Scout-17B-16E');
    expect(result.routing.worker?.provider).toBe('together');
    expect(result.routing.worker?.model).toBe('meta-llama/Llama-4-Scout-17B-16E');
    expect(result.requiredProviders.has('together')).toBe(true);
  });

  it('skips worker when agentProvider is skip', () => {
    const result = buildRoutingFromFeatures({
      ...base,
      agentProvider: 'skip',
    });

    expect(result.routing.worker).toBeUndefined();
    expect(result.capabilities.agents).toBe(false);
  });

  it('minimal config — brain only', () => {
    const result = buildRoutingFromFeatures(base);

    expect(result.routing.text).toBeDefined();
    expect(result.routing.voice).toBeUndefined();
    expect(result.routing.vision).toBeUndefined();
    expect(result.routing.embedding).toBeUndefined();
    expect(result.routing.worker).toBeUndefined();
    expect(result.capabilities.brain).toBe(true);
    expect(result.requiredProviders.size).toBe(1);
  });
});

// ─── getVoiceOptions ───────────────────────────────────────────

describe('getVoiceOptions', () => {
  it('returns null when voice is skipped', () => {
    const result = getVoiceOptions({
      voice: 'skip',
      vision: 'skip',
      brainProvider: 'google',
      memoryProvider: 'skip',
      agentProvider: 'skip',
    });
    expect(result).toBeNull();
  });

  it('returns xAI voices for realtime mode', () => {
    const result = getVoiceOptions({
      voice: 'realtime',
      vision: 'skip',
      brainProvider: 'google',
      memoryProvider: 'skip',
      agentProvider: 'skip',
    });
    expect(result).not.toBeNull();
    expect(result!.defaultVoice).toBe('eve');
    expect(result!.voices.some((v) => v.value === 'sage')).toBe(true);
  });

  it('returns ElevenLabs voices for pipeline with elevenlabs TTS', () => {
    const result = getVoiceOptions({
      voice: 'pipeline',
      ttsProvider: 'elevenlabs',
      vision: 'skip',
      brainProvider: 'google',
      memoryProvider: 'skip',
      agentProvider: 'skip',
    });
    expect(result).not.toBeNull();
    expect(result!.defaultVoice).toBe('Rachel');
  });

  it('returns OpenAI voices for pipeline with openai TTS', () => {
    const result = getVoiceOptions({
      voice: 'pipeline',
      ttsProvider: 'openai',
      vision: 'skip',
      brainProvider: 'google',
      memoryProvider: 'skip',
      agentProvider: 'skip',
    });
    expect(result).not.toBeNull();
    expect(result!.defaultVoice).toBe('nova');
    expect(result!.voices.some((v) => v.value === 'shimmer')).toBe(true);
  });
});

// ─── PROVIDER_PRESETS ──────────────────────────────────────────

describe('PROVIDER_PRESETS', () => {
  it('has all expected providers', () => {
    const ids = Object.keys(PROVIDER_PRESETS);
    expect(ids).toContain('xai');
    expect(ids).toContain('google');
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('deepgram');
    expect(ids).toContain('elevenlabs');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('vercel');
  });

  it('every preset has a label, capabilities, consoleUrl, and validation', () => {
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.label, `${id}.label`).toBeTruthy();
      expect(preset.capabilities.length, `${id}.capabilities`).toBeGreaterThan(0);
      expect(preset.consoleUrl, `${id}.consoleUrl`).toMatch(/^https?:\/\//);
      expect(preset.validation, `${id}.validation`).toBeDefined();
    }
  });

  it('xAI has voice-realtime capability', () => {
    expect(PROVIDER_PRESETS.xai.capabilities).toContain('voice-realtime');
  });

  it('Google has vision-streaming capability', () => {
    expect(PROVIDER_PRESETS.google.capabilities).toContain('vision-streaming');
  });

  it('Anthropic has text and vision-snapshot capabilities', () => {
    expect(PROVIDER_PRESETS.anthropic.capabilities).toContain('text');
    expect(PROVIDER_PRESETS.anthropic.capabilities).toContain('vision-snapshot');
  });

  it('Vercel has text, embedding, and worker capabilities', () => {
    expect(PROVIDER_PRESETS.vercel.capabilities).toContain('text');
    expect(PROVIDER_PRESETS.vercel.capabilities).toContain('embedding');
    expect(PROVIDER_PRESETS.vercel.capabilities).toContain('worker');
  });
});
