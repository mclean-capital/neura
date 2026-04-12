import { z } from 'zod';
import type { RetrievalStrategy, MemoryTierConfig } from './memory.js';

// ─── Provider Credentials ──────────────────────────────────────

export interface ProviderCredentials {
  apiKey: string;
  /** Base URL override — used for gateway providers (OpenRouter, Vercel AI Gateway) */
  baseUrl?: string;
}

// ─── Routing Config ────────────────────────────────────────────

export interface ModelRoute {
  provider: string;
  model: string;
}

export interface EmbeddingRoute extends ModelRoute {
  dimensions: number;
}

export interface RealtimeVoiceRoute {
  mode: 'realtime';
  provider: string;
  model: string;
  voice?: string;
}

export interface PipelineVoiceRoute {
  mode: 'pipeline';
  stt: ModelRoute;
  llm: ModelRoute;
  tts: ModelRoute & { voice?: string };
}

export type VoiceRoute = RealtimeVoiceRoute | PipelineVoiceRoute;

export interface StreamingVisionRoute {
  mode: 'streaming';
  provider: string;
  model: string;
}

export interface SnapshotVisionRoute {
  mode: 'snapshot';
  provider: string;
  model: string;
}

export type VisionRoute = StreamingVisionRoute | SnapshotVisionRoute;

export interface RoutingConfig {
  voice?: VoiceRoute;
  vision?: VisionRoute;
  text?: ModelRoute;
  embedding?: EmbeddingRoute;
  worker?: ModelRoute;
}

// ─── Config File (v3) ──────────────────────────────────────────

/**
 * Schema for ~/.neura/config.json — the shared config file read by core and CLI.
 * v3: provider-agnostic with capability-based routing.
 */
export interface NeuraConfigFile {
  providers: Record<string, ProviderCredentials>;
  routing: RoutingConfig;
  assistantName?: string;
  wakeWord?: string;
  port?: number;
  pgDataPath?: string;
  /** Shared-secret token for WebSocket and HTTP auth */
  authToken?: string;
  autoUpdate?: boolean;
  /** Phase 5b: memory retrieval strategy */
  retrievalStrategy?: RetrievalStrategy;
  /** Phase 5b: per-tier token budgets for system prompt */
  memoryTiers?: MemoryTierConfig;
}

// ─── UI Config (unchanged) ─────────────────────────────────────

export interface UIConfig {
  wsUrl: string;
  authToken?: string;
}

// ─── Zod Schema ────────────────────────────────────────────────

const providerCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

const modelRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const embeddingRouteSchema = modelRouteSchema.extend({
  dimensions: z.number().int().positive(),
});

const realtimeVoiceRouteSchema = z.object({
  mode: z.literal('realtime'),
  provider: z.string().min(1),
  model: z.string().min(1),
  voice: z.string().optional(),
});

const pipelineVoiceRouteSchema = z.object({
  mode: z.literal('pipeline'),
  stt: modelRouteSchema,
  llm: modelRouteSchema,
  tts: modelRouteSchema.extend({ voice: z.string().optional() }),
});

const voiceRouteSchema = z.discriminatedUnion('mode', [
  realtimeVoiceRouteSchema,
  pipelineVoiceRouteSchema,
]);

const streamingVisionRouteSchema = z.object({
  mode: z.literal('streaming'),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const snapshotVisionRouteSchema = z.object({
  mode: z.literal('snapshot'),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const visionRouteSchema = z.discriminatedUnion('mode', [
  streamingVisionRouteSchema,
  snapshotVisionRouteSchema,
]);

const routingConfigSchema = z.object({
  voice: voiceRouteSchema.optional(),
  vision: visionRouteSchema.optional(),
  text: modelRouteSchema.optional(),
  embedding: embeddingRouteSchema.optional(),
  worker: modelRouteSchema.optional(),
});

export const neuraConfigSchema = z
  .object({
    providers: z.record(z.string(), providerCredentialsSchema),
    routing: routingConfigSchema,
    assistantName: z.string().optional(),
    wakeWord: z.string().optional(),
    port: z.number().int().nonnegative().optional(),
    pgDataPath: z.string().optional(),
    authToken: z.string().optional(),
    autoUpdate: z.boolean().optional(),
    retrievalStrategy: z.enum(['vector-only', 'hybrid', 'hybrid-rerank']).optional(),
    memoryTiers: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (data) => {
      // Validate that every CONFIGURED routing provider exists in providers map.
      // Routes are optional — missing routes simply disable that capability.
      const providerIds = new Set(Object.keys(data.providers));
      const routes: string[] = [];

      if (data.routing.text) routes.push(data.routing.text.provider);
      if (data.routing.embedding) routes.push(data.routing.embedding.provider);
      if (data.routing.worker) routes.push(data.routing.worker.provider);

      if (data.routing.vision) {
        routes.push(data.routing.vision.provider);
      }

      if (data.routing.voice) {
        if (data.routing.voice.mode === 'realtime') {
          routes.push(data.routing.voice.provider);
        } else {
          routes.push(data.routing.voice.stt.provider);
          routes.push(data.routing.voice.llm.provider);
          routes.push(data.routing.voice.tts.provider);
        }
      }

      return routes.every((p) => providerIds.has(p));
    },
    {
      message: 'Every routing provider must have a matching entry in the providers map',
    }
  );

/** Detect v2 config format for clear upgrade error messages */
export function isV2Config(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'apiKeys' in raw &&
    typeof (raw as Record<string, unknown>).apiKeys === 'object' &&
    !('providers' in raw)
  );
}
