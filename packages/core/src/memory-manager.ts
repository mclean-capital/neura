import { Logger } from '@neura/utils/logger';
import type {
  DataStore,
  FactEntry,
  RetrievalStrategy,
  TimelineEntry,
  MemoryStats,
} from '@neura/types';
import { buildMemoryPrompt } from './memory-prompt-builder.js';
import { createExtractionPipeline, type ExtractionPipeline } from './memory-extractor.js';
import { createReranker, type Reranker } from './memory-reranker.js';

const log = new Logger('memory');

export interface MemoryManagerOptions {
  store: DataStore;
  googleApiKey: string;
  onExtractionComplete?: () => Promise<void>;
  /** Phase 5b: retrieval strategy. Default: 'hybrid' */
  retrievalStrategy?: RetrievalStrategy;
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

  /** Phase 5b: Invalidate a fact by finding the best match for a query. */
  invalidateFact(query: string): Promise<string | null>;

  /** Phase 5b: Get timeline of memory changes. */
  getTimeline(daysBack: number, entityFilter?: string): Promise<TimelineEntry[]>;

  /** Phase 5b: Get memory statistics. */
  getMemoryStats(): Promise<MemoryStats>;

  /** Await all pending extractions and shut down. */
  close(): Promise<void>;
}

export function createMemoryManager(options: MemoryManagerOptions): MemoryManager {
  const { store, googleApiKey } = options;
  const strategy: RetrievalStrategy = options.retrievalStrategy ?? 'hybrid';
  const pipeline: ExtractionPipeline = createExtractionPipeline(googleApiKey);
  const reranker: Reranker = createReranker(googleApiKey);
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

      const { result, factEmbeddings, transcriptEmbeddings } = output;
      let memoriesCreated = 0;

      // Store extracted facts with embeddings, collecting IDs for entity linking
      const factIds: string[] = [];
      for (let i = 0; i < result.facts.length; i++) {
        const fact = result.facts[i];
        const embedding = factEmbeddings[i] ?? undefined;
        const factId = await store.upsertFact(
          fact.content,
          fact.category,
          fact.tags,
          sessionId,
          0.8,
          embedding,
          fact.tagPath
        );
        factIds.push(factId);
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

      // Phase 5b: Index transcript embeddings
      if (transcriptEmbeddings.size > 0) {
        await store.indexTranscriptEmbeddings(sessionId, transcriptEmbeddings);
        log.info('transcript embeddings indexed', { count: transcriptEmbeddings.size });
      }

      // Phase 5b: Store extracted entities, link to facts via mentionedEntities, create relationships
      // Isolated try/catch so entity failures don't lose already-stored facts/prefs
      if (result.entities && result.entities.length > 0) {
        // Build name→type map and name→entityId map
        const entityTypeMap = new Map<string, string>();
        const entityIdMap = new Map<string, string>();
        for (const entity of result.entities) {
          entityTypeMap.set(entity.name.toLowerCase(), entity.type);
        }

        // First pass: create all entities
        for (const entity of result.entities) {
          try {
            const entityId = await store.upsertEntity(entity.name, entity.type);
            entityIdMap.set(entity.name.toLowerCase(), entityId);
            memoriesCreated++;
          } catch (entityErr) {
            log.warn('entity creation failed', {
              entity: entity.name,
              err: String(entityErr),
            });
          }
        }

        // Second pass: link entities to facts using mentionedEntities (precise linking)
        for (let i = 0; i < result.facts.length; i++) {
          const fact = result.facts[i];
          const factId = factIds[i];
          const mentioned = fact.mentionedEntities ?? [];
          for (const entityName of mentioned) {
            const entityId = entityIdMap.get(entityName.toLowerCase());
            if (entityId) {
              await store.linkFactEntity(factId, entityId);
            }
          }
        }

        // Third pass: create relationships between entities
        for (const entity of result.entities) {
          const sourceEntityId = entityIdMap.get(entity.name.toLowerCase());
          if (!sourceEntityId || !entity.relationships) continue;

          for (const rel of entity.relationships) {
            try {
              const targetType = entityTypeMap.get(rel.target.toLowerCase()) ?? 'concept';
              let targetId = entityIdMap.get(rel.target.toLowerCase());
              if (!targetId) {
                targetId = await store.upsertEntity(rel.target, targetType);
                entityIdMap.set(rel.target.toLowerCase(), targetId);
              }
              // Find the first fact that mentions both source and target for provenance
              const relevantFactId = factIds.find((_, idx) => {
                const mentioned = result.facts[idx].mentionedEntities ?? [];
                const mentionedLower = mentioned.map((n) => n.toLowerCase());
                return (
                  mentionedLower.includes(entity.name.toLowerCase()) &&
                  mentionedLower.includes(rel.target.toLowerCase())
                );
              });
              await store.createEntityRelationship(
                sourceEntityId,
                targetId,
                rel.relationship,
                relevantFactId
              );
            } catch (relErr) {
              log.warn('entity relationship creation failed', {
                entity: entity.name,
                target: rel.target,
                err: String(relErr),
              });
            }
          }
        }
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

    let results: FactEntry[];
    if (strategy === 'vector-only') {
      results = await store.searchFacts(query, embedding ?? undefined, limit);
    } else {
      // hybrid or hybrid-rerank: use BM25 + cosine fusion
      const candidateLimit = strategy === 'hybrid-rerank' ? 20 : limit;
      results = await store.searchFactsHybrid(query, embedding ?? undefined, candidateLimit);

      if (strategy === 'hybrid-rerank' && results.length > limit) {
        results = await reranker.rerank(query, results, limit);
      }
    }

    // Phase 5b: if few results, fall back to transcript search
    if (results.length < 3 && embedding) {
      const transcriptResults = await store.searchTranscripts(embedding, limit - results.length);
      if (transcriptResults.length > 0) {
        log.info('supplementing recall with transcript search', {
          factResults: results.length,
          transcriptResults: transcriptResults.length,
        });
        // Convert transcript entries to fact-like results for the caller
        const transcriptFacts: FactEntry[] = transcriptResults.map((t) => ({
          id: `transcript-${t.id}`,
          content: `[from transcript] ${t.text}`,
          category: 'general' as const,
          tags: ['transcript'],
          sourceSessionId: t.sessionId,
          confidence: 0.5,
          accessCount: 0,
          lastAccessedAt: null,
          createdAt: t.createdAt,
          updatedAt: t.createdAt,
          expiresAt: null,
        }));
        results = [...results, ...transcriptFacts];
      }
    }

    // Phase 5b: expand with cross-referenced facts via shared entities
    if (results.length > 0 && results.length <= limit) {
      const seenIds = new Set(results.map((r) => r.id));
      for (const fact of results.slice(0, 3)) {
        if (fact.id.startsWith('transcript-')) continue;
        const related = await store.getRelatedFacts(fact.id, 2);
        for (const rel of related) {
          if (!seenIds.has(rel.id) && results.length < limit) {
            results.push(rel);
            seenIds.add(rel.id);
          }
        }
      }
    }

    return results;
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

  async function invalidateFact(query: string): Promise<string | null> {
    const results = await recall(query, 1);
    if (results.length === 0 || results[0].id.startsWith('transcript-')) return null;
    const fact = results[0];
    await store.invalidateFact(fact.id);
    log.info('fact invalidated', { factId: fact.id, content: fact.content });
    return fact.id;
  }

  async function getTimeline(daysBack: number, entityFilter?: string): Promise<TimelineEntry[]> {
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000);
    return store.getTimeline(from, to, entityFilter);
  }

  async function getMemoryStats(): Promise<MemoryStats> {
    return store.getMemoryStats();
  }

  async function close(): Promise<void> {
    if (pendingExtractions.size > 0) {
      log.info('awaiting pending extractions', { count: pendingExtractions.size });
      await Promise.allSettled([...pendingExtractions]);
    }
  }

  return {
    buildSystemPrompt,
    queueExtraction,
    recall,
    storeFact,
    storePreference,
    invalidateFact,
    getTimeline,
    getMemoryStats,
    close,
  };
}
