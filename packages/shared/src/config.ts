export interface CoreConfig {
  port: number;
  xaiApiKey: string;
  googleApiKey: string;
  voice: string;
  visionModel: string;
  vadThreshold: number;
  vadSilenceDurationMs: number;
  vadPrefixPaddingMs: number;
  watcherQueryTimeoutMs: number;
  costUpdateIntervalMs: number;
  maxReconnectAttempts: number;
  sessionMaxMs: number;
}

export interface UIConfig {
  wsUrl: string;
}

// Audio constants shared between core and UI
export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_FORMAT = 'pcm16' as const;
export const FRAME_CAPTURE_INTERVAL_MS = 2_000;
