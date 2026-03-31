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
