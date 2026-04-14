import type {
  RoutingConfig,
  VoiceRoute,
  VisionRoute,
  ModelRoute,
  EmbeddingRoute,
} from '@neura/types';

// ─── Provider Presets ──────────────────────────────────────────

export type Capability =
  | 'voice-realtime'
  | 'voice-stt'
  | 'voice-tts'
  | 'vision-streaming'
  | 'vision-snapshot'
  | 'text'
  | 'embedding'
  | 'worker';

export interface ProviderPreset {
  id: string;
  label: string;
  capabilities: Capability[];
  consoleUrl: string;
  validation: {
    url: string;
    headerKey: string;
    headerFormat: string;
  } | null;
  defaultModels: Partial<Record<Capability, { model: string; extra?: Record<string, unknown> }>>;
  voices?: { id: string; label: string }[];
  defaultVoice?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  xai: {
    id: 'xai',
    label: 'xAI',
    capabilities: ['voice-realtime', 'text', 'worker'],
    consoleUrl: 'https://console.x.ai',
    validation: {
      url: 'https://api.x.ai/v1/models',
      headerKey: 'Authorization',
      headerFormat: 'Bearer {key}',
    },
    defaultModels: {
      'voice-realtime': { model: 'grok-realtime' },
      text: { model: 'grok-4-fast' },
      worker: { model: 'grok-4-fast' },
    },
    voices: [
      { id: 'eve', label: 'Eve' },
      { id: 'sage', label: 'Sage' },
      { id: 'ember', label: 'Ember' },
    ],
    defaultVoice: 'eve',
  },
  google: {
    id: 'google',
    label: 'Google',
    capabilities: ['vision-streaming', 'text', 'embedding', 'worker'],
    consoleUrl: 'https://aistudio.google.com',
    validation: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      headerKey: 'x-goog-api-key',
      headerFormat: '{key}',
    },
    defaultModels: {
      'vision-streaming': { model: 'gemini-2.5-flash' },
      text: { model: 'gemini-2.5-flash' },
      embedding: { model: 'gemini-embedding-2-preview', extra: { dimensions: 3072 } },
      worker: { model: 'gemini-2.5-flash' },
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    capabilities: ['text', 'embedding', 'voice-tts', 'vision-snapshot', 'worker'],
    consoleUrl: 'https://platform.openai.com',
    validation: {
      url: 'https://api.openai.com/v1/models',
      headerKey: 'Authorization',
      headerFormat: 'Bearer {key}',
    },
    defaultModels: {
      text: { model: 'gpt-4.1-mini' },
      embedding: { model: 'text-embedding-3-small', extra: { dimensions: 1536 } },
      'voice-tts': { model: 'tts-1' },
      'vision-snapshot': { model: 'gpt-4.1-mini' },
      worker: { model: 'gpt-4.1-mini' },
    },
    voices: [
      { id: 'alloy', label: 'Alloy' },
      { id: 'echo', label: 'Echo' },
      { id: 'fable', label: 'Fable' },
      { id: 'onyx', label: 'Onyx' },
      { id: 'nova', label: 'Nova' },
      { id: 'shimmer', label: 'Shimmer' },
    ],
    defaultVoice: 'nova',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    capabilities: ['text', 'vision-snapshot', 'worker'],
    consoleUrl: 'https://console.anthropic.com',
    validation: {
      url: 'https://api.anthropic.com/v1/models',
      headerKey: 'x-api-key',
      headerFormat: '{key}',
    },
    defaultModels: {
      text: { model: 'claude-sonnet-4-6' },
      'vision-snapshot': { model: 'claude-sonnet-4-6' },
      worker: { model: 'claude-sonnet-4-6' },
    },
  },
  deepgram: {
    id: 'deepgram',
    label: 'Deepgram',
    capabilities: ['voice-stt'],
    consoleUrl: 'https://console.deepgram.com',
    validation: {
      url: 'https://api.deepgram.com/v1/projects',
      headerKey: 'Authorization',
      headerFormat: 'Token {key}',
    },
    defaultModels: {
      'voice-stt': { model: 'nova-3' },
    },
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    capabilities: ['voice-tts'],
    consoleUrl: 'https://elevenlabs.io',
    validation: {
      url: 'https://api.elevenlabs.io/v1/user',
      headerKey: 'xi-api-key',
      headerFormat: '{key}',
    },
    defaultModels: {
      'voice-tts': { model: 'eleven_turbo_v2' },
    },
    voices: [
      { id: 'Rachel', label: 'Rachel' },
      { id: 'Drew', label: 'Drew' },
      { id: 'Clyde', label: 'Clyde' },
      { id: 'Domi', label: 'Domi' },
      { id: 'Bella', label: 'Bella' },
    ],
    defaultVoice: 'Rachel',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    capabilities: ['text', 'worker'],
    consoleUrl: 'https://openrouter.ai',
    validation: {
      url: 'https://openrouter.ai/api/v1/models',
      headerKey: 'Authorization',
      headerFormat: 'Bearer {key}',
    },
    defaultModels: {
      text: { model: 'google/gemini-2.5-flash' },
      worker: { model: 'google/gemini-2.5-flash' },
    },
  },
};

// ─── Feature Selections ────────────────────────────────────────

export type VoiceMode = 'realtime' | 'pipeline' | 'skip';
export type VisionMode = 'streaming' | 'snapshot' | 'skip';

export interface FeatureSelections {
  voice: VoiceMode;
  /** STT provider — only used when voice === 'pipeline' */
  sttProvider?: string;
  /** TTS provider — only used when voice === 'pipeline' */
  ttsProvider?: string;
  vision: VisionMode;
  /** Snapshot provider — only used when vision === 'snapshot' */
  snapshotProvider?: string;
  /** Brain (text) provider — required */
  brainProvider: string;
  /** Memory embedding provider, or 'skip' */
  memoryProvider: string;
  /** Agent worker provider, or 'skip' */
  agentProvider: string;
  /** Custom provider details */
  customProvider?: { name: string; baseUrl: string; model: string };
}

// ─── Feature Labels (for key collection display) ───────────────

const FEATURE_LABELS: Record<string, string> = {
  'voice-realtime': 'Voice (realtime)',
  'voice-stt': 'Voice (speech-to-text)',
  'voice-tts': 'Voice (text-to-speech)',
  'vision-streaming': 'Vision (streaming)',
  'vision-snapshot': 'Vision (snapshot)',
  text: 'Brain',
  embedding: 'Memory',
  worker: 'Agents',
};

// ─── Routing Builder ───────────────────────────────────────────

export interface RoutingResult {
  routing: RoutingConfig;
  requiredProviders: Map<string, string[]>;
  warnings: string[];
  capabilities: Record<string, boolean>;
}

export function buildRoutingFromFeatures(selections: FeatureSelections): RoutingResult {
  const requiredProviders = new Map<string, string[]>();
  const warnings: string[] = [];
  const capabilities: Record<string, boolean> = {
    voice: false,
    vision: false,
    brain: true,
    memory: false,
    agents: false,
  };

  function requireProvider(providerId: string, feature: string): void {
    const existing = requiredProviders.get(providerId) ?? [];
    existing.push(FEATURE_LABELS[feature] ?? feature);
    requiredProviders.set(providerId, existing);
  }

  // Resolve custom provider name and model
  const resolveProvider = (id: string): string =>
    id === 'custom' && selections.customProvider ? selections.customProvider.name : id;
  const resolveCustomModel = (): string => selections.customProvider?.model ?? 'gpt-4.1-mini';

  // ── Voice ────────────────────────────────────────────────────
  let voice: VoiceRoute | undefined;

  if (selections.voice === 'realtime') {
    const provider = 'xai';
    const preset = PROVIDER_PRESETS[provider];
    voice = {
      mode: 'realtime',
      provider,
      model: preset.defaultModels['voice-realtime']!.model,
    };
    requireProvider(provider, 'voice-realtime');
    capabilities.voice = true;
  } else if (selections.voice === 'pipeline') {
    const sttProvider = selections.sttProvider ?? 'deepgram';
    const ttsProvider = selections.ttsProvider ?? 'elevenlabs';
    const brainProvider = resolveProvider(selections.brainProvider);

    const sttPreset = PROVIDER_PRESETS[sttProvider];
    const ttsPreset = PROVIDER_PRESETS[ttsProvider];
    const brainPreset = PROVIDER_PRESETS[brainProvider];

    voice = {
      mode: 'pipeline',
      stt: {
        provider: sttProvider,
        model: sttPreset?.defaultModels['voice-stt']?.model ?? 'nova-3',
      },
      llm: {
        provider: brainProvider,
        model: brainPreset?.defaultModels?.text?.model ?? resolveCustomModel(),
      },
      tts: {
        provider: ttsProvider,
        model: ttsPreset?.defaultModels['voice-tts']?.model ?? 'tts-1',
      },
    };

    requireProvider(sttProvider, 'voice-stt');
    requireProvider(ttsProvider, 'voice-tts');
    // Brain provider is already required for text — no duplicate needed
    capabilities.voice = true;
  }

  // ── Vision ───────────────────────────────────────────────────
  let vision: VisionRoute | undefined;

  if (selections.vision === 'streaming') {
    const provider = 'google';
    const preset = PROVIDER_PRESETS[provider];
    vision = {
      mode: 'streaming',
      provider,
      model: preset.defaultModels['vision-streaming']!.model,
    };
    requireProvider(provider, 'vision-streaming');
    capabilities.vision = true;
  } else if (selections.vision === 'snapshot') {
    const provider = selections.snapshotProvider ?? 'openai';
    const preset = PROVIDER_PRESETS[provider];
    vision = {
      mode: 'snapshot',
      provider,
      model: preset?.defaultModels['vision-snapshot']?.model ?? 'gpt-4.1-mini',
    };
    requireProvider(provider, 'vision-snapshot');
    capabilities.vision = true;
  }

  // ── Brain (text) — required ──────────────────────────────────
  const brainProvider = resolveProvider(selections.brainProvider);
  const brainPreset = PROVIDER_PRESETS[brainProvider];
  const text: ModelRoute = {
    provider: brainProvider,
    model: brainPreset?.defaultModels?.text?.model ?? resolveCustomModel(),
  };
  requireProvider(brainProvider, 'text');

  // ── Memory (embedding) ──────────────────────────────────────
  let embedding: EmbeddingRoute | undefined;

  if (selections.memoryProvider !== 'skip') {
    const provider = selections.memoryProvider;
    const preset = PROVIDER_PRESETS[provider];
    const dims =
      (preset?.defaultModels?.embedding?.extra?.dimensions as number | undefined) ?? 1536;
    embedding = {
      provider,
      model: preset?.defaultModels?.embedding?.model ?? 'text-embedding-3-small',
      dimensions: dims,
    };
    requireProvider(provider, 'embedding');
    capabilities.memory = true;
  } else {
    warnings.push('Memory embedding skipped — cross-session recall will use keyword search only.');
  }

  // ── Agents (worker) ─────────────────────────────────────────
  let worker: ModelRoute | undefined;

  if (selections.agentProvider !== 'skip') {
    const provider = resolveProvider(selections.agentProvider);
    const preset = PROVIDER_PRESETS[provider];
    worker = {
      provider,
      model:
        preset?.defaultModels?.worker?.model ??
        preset?.defaultModels?.text?.model ??
        resolveCustomModel(),
    };
    requireProvider(provider, 'worker');
    capabilities.agents = true;
  }

  // ── Warnings for skipped features ───────────────────────────
  if (selections.voice === 'skip') {
    warnings.push('Voice skipped — Neura will be text-only.');
  }
  if (selections.vision === 'skip') {
    warnings.push('Vision skipped — no screen or camera awareness.');
  }

  const routing: RoutingConfig = {
    voice,
    vision,
    text,
    embedding,
    worker,
  };

  return { routing, requiredProviders, warnings, capabilities };
}

// ─── Voice Options ─────────────────────────────────────────────

/**
 * Get voice options for the voice provider(s) selected by the user.
 * Returns the appropriate voice list based on the voice mode and providers.
 */
export function getVoiceOptions(selections: FeatureSelections): {
  voices: { value: string; label: string }[];
  defaultVoice: string;
} | null {
  if (selections.voice === 'skip') return null;

  if (selections.voice === 'realtime') {
    const preset = PROVIDER_PRESETS.xai;
    return {
      voices: preset.voices!.map((v) => ({ value: v.id, label: v.label })),
      defaultVoice: preset.defaultVoice!,
    };
  }

  // Pipeline — use TTS provider's voice list
  const ttsProvider = selections.ttsProvider ?? 'elevenlabs';
  const preset = PROVIDER_PRESETS[ttsProvider];
  if (!preset?.voices) return null;

  return {
    voices: preset.voices.map((v) => ({ value: v.id, label: v.label })),
    defaultVoice: preset.defaultVoice ?? preset.voices[0].id,
  };
}
