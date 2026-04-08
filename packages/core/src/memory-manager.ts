import { Logger } from '@neura/utils/logger';
import type { DataStore, FactEntry } from '@neura/types';
import { buildMemoryPrompt } from './memory-prompt-builder.js';
import { createExtractionPipeline, type ExtractionPipeline } from './memory-extractor.js';

const log = new Logger('memory');

export interface MemoryManagerOptions {
  store: DataStore;
  googleApiKey: string;
  onExtractionComplete?: () => Promise<void>;
}

export interface MemoryManager {
  /** Build system prompt from stored memory context. Called once per client connection. */
  buildSystemPrompt(): Promise<string>;

  /** Queue extraction for a completed conversation. Returns a trackable promise. */
  queueExtraction(sessionId: string): Promise<void>;

  /** Search memories by query with optional vector search. */
  recall(query: string, limit?: number): Promise<FactEntry[]>;

  /** Store a fact with auto-generated embedding. */
  storeFact(content: string, category: string, tags: string[], sessionId?: string): Promise<string>;

  /** Store a behavioral preference. */
  storePreference(preference: string, category: string, sessionId?: string): Promise<void>;

  /** Await all pending extractions and shut down. */
  close(): Promise<void>;
}

export function createMemoryManager(options: MemoryManagerOptions): MemoryManager {
  const { store, googleApiKey } = options;
  const pipeline: ExtractionPipeline = createExtractionPipeline(googleApiKey);
  const pendingExtractions = new Set<Promise<void>>();

  async function buildSystemPrompt(): Promise<string> {
    const context = await store.getMemoryContext({ maxTokens: 2000 });
    return buildMemoryPrompt(context);
  }

  async function runExtraction(sessionId: string): Promise<void> {
    const extractionId = await store.createExtraction(sessionId);
    await store.updateExtraction(extractionId, 'processing');

    try {
      const existingContext = await store.getMemoryContext();
      const transcript = await store.getTranscript(sessionId);
      const output = await pipeline.extract(transcript, existingContext);

      if (!output) {
        await store.updateExtraction(extractionId, 'failed', 0, 'extraction returned no results');
        return;
      }

      const { result, factEmbeddings } = output;
      let memoriesCreated = 0;

      // Store extracted facts with embeddings
      for (let i = 0; i < result.facts.length; i++) {
        const fact = result.facts[i];
        const embedding = factEmbeddings[i] ?? undefined;
        await store.upsertFact(fact.content, fact.category, fact.tags, sessionId, 0.8, embedding);
        memoriesCreated++;
      }

      // Store preferences
      for (const pref of result.preferences) {
        await store.upsertPreference(pref.preference, pref.category, sessionId);
        memoriesCreated++;
      }

      // Store user profile updates
      for (const field of result.userProfile) {
        await store.upsertUserProfile(field.field, field.value, 0.8, sessionId);
        memoriesCreated++;
      }

      // Store identity updates
      for (const update of result.identityUpdates) {
        await store.upsertIdentity(update.attribute, update.value, 'user_feedback', sessionId);
        memoriesCreated++;
      }

      // Store session summary
      if (result.sessionSummary.summary) {
        await store.createSessionSummary(sessionId, {
          summary: result.sessionSummary.summary,
          topics: result.sessionSummary.topics,
          keyDecisions: result.sessionSummary.keyDecisions,
          openThreads: result.sessionSummary.openThreads,
          extractionModel: 'gemini-2.5-flash',
          extractionCostUsd: null,
        });
      }

      await store.updateExtraction(extractionId, 'completed', memoriesCreated);
      log.info('extraction stored', { sessionId, memoriesCreated });

      if (options.onExtractionComplete) {
        await options
          .onExtractionComplete()
          .catch((e) => log.warn('post-extraction callback failed', { err: String(e) }));
      }
    } catch (err) {
      log.error('extraction failed', { sessionId, err: String(err) });
      await store
        .updateExtraction(extractionId, 'failed', 0, String(err))
        .catch((e) => log.warn('failed to update extraction status', { err: String(e) }));
    }
  }

  async function queueExtraction(sessionId: string): Promise<void> {
    const transcript = await store.getTranscript(sessionId);

    if (transcript.length < 4) {
      log.info('skipping extraction, transcript too short', {
        sessionId,
        entries: transcript.length,
      });
      return;
    }

    const p = runExtraction(sessionId);
    pendingExtractions.add(p);
    void p.finally(() => pendingExtractions.delete(p));
    await p;
  }

  async function recall(query: string, limit = 10): Promise<FactEntry[]> {
    const embedding = await pipeline.generateEmbedding(query);
    return store.searchFacts(query, embedding ?? undefined, limit);
  }

  async function storeFact(
    content: string,
    category: string,
    tags: string[],
    sessionId?: string
  ): Promise<string> {
    const embedding = await pipeline.generateEmbedding(content);
    return store.upsertFact(content, category, tags, sessionId, 0.8, embedding ?? undefined);
  }

  async function storePreference(
    preference: string,
    category: string,
    sessionId?: string
  ): Promise<void> {
    await store.upsertPreference(preference, category, sessionId);
  }

  async function close(): Promise<void> {
    if (pendingExtractions.size > 0) {
      log.info('awaiting pending extractions', { count: pendingExtractions.size });
      await Promise.allSettled([...pendingExtractions]);
    }
  }

  return { buildSystemPrompt, queueExtraction, recall, storeFact, storePreference, close };
}
