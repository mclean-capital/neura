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

/**
 * Schema for ~/.neura/config.json — the shared config file read by core and CLI.
 * Core reads this with env var overrides; CLI reads/writes it directly.
 */
export interface NeuraConfigFile {
  port: number;
  voice: string;
  apiKeys: {
    xai: string;
    google: string;
  };
  service: {
    autoStart: boolean;
    logLevel: string;
  };
  pgDataPath?: string;
  autoUpdate?: boolean;
  assistantName?: string;
}
