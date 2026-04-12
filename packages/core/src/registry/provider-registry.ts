import type {
  NeuraConfigFile,
  ProviderCredentials,
  RoutingConfig,
  TextAdapter,
  EmbeddingAdapter,
  RouteDescriptor,
  VoiceRouteDescriptor,
  VisionRouteDescriptor,
} from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { OpenAICompatibleTextAdapter } from '../adapters/openai-compatible-text.js';
import { OpenAICompatibleEmbeddingAdapter } from '../adapters/openai-compatible-embedding.js';

const log = new Logger('registry');

/**
 * Known base URLs for providers that expose OpenAI-compatible endpoints.
 * Used as fallback when no explicit baseUrl is configured.
 */
const KNOWN_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  together: 'https://api.together.xyz/v1',
};

/**
 * Central registry that resolves route descriptors and manages adapter lifecycle.
 *
 * - Stateless adapters (text, embedding) are singletons shared across sessions.
 * - Stateful adapters (voice, vision, STT, TTS) are created per-session via
 *   factory methods added in later phases.
 */
export class ProviderRegistry {
  private readonly providers: Record<string, ProviderCredentials>;
  private readonly routing: RoutingConfig;

  private textAdapter: TextAdapter | null = null;
  private embeddingAdapter: EmbeddingAdapter | null = null;

  constructor(config: NeuraConfigFile) {
    this.providers = config.providers;
    this.routing = config.routing;
  }

  // ─── Route Resolution ──────────────────────────────────────────

  private resolveRoute(provider: string, model: string): RouteDescriptor {
    const creds = this.providers[provider];
    if (!creds) {
      throw new Error(
        `Provider "${provider}" not found in config.providers. ` +
          `Available: ${Object.keys(this.providers).join(', ') || '(none)'}`
      );
    }
    return {
      providerId: provider,
      model,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl ?? KNOWN_BASE_URLS[provider],
    };
  }

  resolveText(): RouteDescriptor | null {
    if (!this.routing.text) return null;
    return this.resolveRoute(this.routing.text.provider, this.routing.text.model);
  }

  resolveEmbedding(): (RouteDescriptor & { dimensions: number }) | null {
    if (!this.routing.embedding) return null;
    const route = this.resolveRoute(this.routing.embedding.provider, this.routing.embedding.model);
    return { ...route, dimensions: this.routing.embedding.dimensions };
  }

  resolveVision(): VisionRouteDescriptor | null {
    const v = this.routing.vision;
    if (!v) return null;
    return {
      mode: v.mode,
      route: this.resolveRoute(v.provider, v.model),
    };
  }

  resolveVoice(): VoiceRouteDescriptor | null {
    const v = this.routing.voice;
    if (!v) return null;
    if (v.mode === 'realtime') {
      return {
        mode: 'realtime',
        realtime: { ...this.resolveRoute(v.provider, v.model), voice: v.voice },
      };
    }
    return {
      mode: 'pipeline',
      pipeline: {
        stt: this.resolveRoute(v.stt.provider, v.stt.model),
        llm: this.resolveRoute(v.llm.provider, v.llm.model),
        tts: {
          ...this.resolveRoute(v.tts.provider, v.tts.model),
          voice: v.tts.voice,
        },
      },
    };
  }

  // ─── Singleton Adapters (stateless, shared) ────────────────────

  getTextAdapter(): TextAdapter | null {
    if (!this.textAdapter) {
      const route = this.resolveText();
      if (!route) return null;
      log.info('creating text adapter', {
        provider: route.providerId,
        model: route.model,
      });
      this.textAdapter = new OpenAICompatibleTextAdapter(route);
    }
    return this.textAdapter;
  }

  getEmbeddingAdapter(): EmbeddingAdapter | null {
    if (!this.embeddingAdapter) {
      const route = this.resolveEmbedding();
      if (!route) return null;
      log.info('creating embedding adapter', {
        provider: route.providerId,
        model: route.model,
        dimensions: route.dimensions,
      });
      this.embeddingAdapter = new OpenAICompatibleEmbeddingAdapter(route);
    }
    return this.embeddingAdapter;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async close(): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.textAdapter) {
      const r = this.textAdapter.close();
      if (r instanceof Promise) tasks.push(r);
      this.textAdapter = null;
    }
    if (this.embeddingAdapter) {
      const r = this.embeddingAdapter.close();
      if (r instanceof Promise) tasks.push(r);
      this.embeddingAdapter = null;
    }
    await Promise.all(tasks);
  }
}
