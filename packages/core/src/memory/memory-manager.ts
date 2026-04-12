import { Logger } from '@neura/utils/logger';
import type {
  DataStore,
  FactEntry,
  RetrievalStrategy,
  TimelineEntry,
  MemoryStats,
  TextAdapter,
  EmbeddingAdapter,
} from '@neura/types';
import { buildMemoryPrompt } from './prompt-builder.js';
import { ExtractionPipeline } from './extraction-pipeline.js';
import { Reranker } from './reranker.js';

const log = new Logger('memory');

export interface MemoryManagerOptions {
  store: DataStore;
  textAdapter: TextAdapter;
  embeddingAdapter: EmbeddingAdapter;
  onExtractionComplete?: () => Promise<void>;
  /** Phase 5b: retrieval strategy. Default: 'hybrid' */
  retrievalStrategy?: RetrievalStrategy;
  /** The configured assistant name — used to generate the base personality
   *  in the system prompt so it stays in sync with the wake word. */
  assistantName?: string;
}

export class MemoryManager {
  private readonly store: DataStore;
  private readonly pipeline: ExtractionPipeline;
  private readonly reranker: Reranker;
  private readonly strategy: RetrievalStrategy;
  private readonly assistantName?: string;
  private readonly pendingExtractions = new Set<Promise<void>>();
  private readonly onExtractionComplete?: () => Promise<void>;

  constructor(options: MemoryManagerOptions) {
    this.store = options.store;
    this.strategy = options.retrievalStrategy ?? 'hybrid';
    this.assistantName = options.assistantName;
    this.pipeline = new ExtractionPipeline(options.textAdapter, options.embeddingAdapter);
    this.reranker = new Reranker(options.textAdapter);
    this.onExtractionComplete = options.onExtractionComplete;
  }

  async buildSystemPrompt(): Promise<string> {
    const context = await this.store.getMemoryContext({ maxTokens: 2000 });
    return buildMemoryPrompt(context, { assistantName: this.assistantName });
  }

  async queueExtraction(sessionId: string): Promise<void> {
    const transcript = await this.store.getTranscript(sessionId);

    if (transcript.length < 4) {
      log.info('skipping extraction, transcript too short', {
        sessionId,
        entries: transcript.length,
      });
      return;
    }

    const p = this.runExtraction(sessionId);
    this.pendingExtractions.add(p);
    void p.finally(() => this.pendingExtractions.delete(p));
    await p;
  }

  async recall(query: string, limit = 10): Promise<FactEntry[]> {
    const embedding = await this.pipeline.generateEmbedding(query);

    let results: FactEntry[];
    if (this.strategy === 'vector-only') {
      results = await this.store.searchFacts(query, embedding ?? undefined, limit);
    } else {
      const candidateLimit = this.strategy === 'hybrid-rerank' ? 20 : limit;
      results = await this.store.searchFactsHybrid(query, embedding ?? undefined, candidateLimit);

      if (this.strategy === 'hybrid-rerank' && results.length > limit) {
        results = await this.reranker.rerank(query, results, limit);
      }
    }

    if (results.length < 3 && embedding) {
      const transcriptResults = await this.store.searchTranscripts(
        embedding,
        limit - results.length
      );
      if (transcriptResults.length > 0) {
        log.info('supplementing recall with transcript search', {
          factResults: results.length,
          transcriptResults: transcriptResults.length,
        });
        const transcriptFacts: FactEntry[] = transcriptResults.map((t) => ({
          id: `transcript-chunk-${t.id}`,
          content: `[from transcript] ${t.chunkText}`,
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

    if (results.length > 0 && results.length <= limit) {
      const seenIds = new Set(results.map((r) => r.id));
      for (const fact of results.slice(0, 3)) {
        if (fact.id.startsWith('transcript-')) continue;
        const related = await this.store.getRelatedFacts(fact.id, 2);
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

  async storeFact(
    content: string,
    category: string,
    tags: string[],
    sessionId?: string
  ): Promise<string> {
    const embedding = await this.pipeline.generateEmbedding(content);
    return this.store.upsertFact(content, category, tags, sessionId, 0.8, embedding ?? undefined);
  }

  async storePreference(preference: string, category: string, sessionId?: string): Promise<void> {
    await this.store.upsertPreference(preference, category, sessionId);
  }

  async invalidateFact(query: string): Promise<string | null> {
    const results = await this.recall(query, 1);
    if (results.length === 0 || results[0].id.startsWith('transcript-')) return null;
    const fact = results[0];
    await this.store.invalidateFact(fact.id);
    log.info('fact invalidated', { factId: fact.id, content: fact.content });
    return fact.id;
  }

  async getTimeline(daysBack: number, entityFilter?: string): Promise<TimelineEntry[]> {
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000);
    return this.store.getTimeline(from, to, entityFilter);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    return this.store.getMemoryStats();
  }

  async close(): Promise<void> {
    if (this.pendingExtractions.size > 0) {
      log.info('awaiting pending extractions', { count: this.pendingExtractions.size });
      await Promise.allSettled([...this.pendingExtractions]);
    }
  }

  private async runExtraction(sessionId: string): Promise<void> {
    const extractionId = await this.store.createExtraction(sessionId);
    await this.store.updateExtraction(extractionId, 'processing');

    try {
      const existingContext = await this.store.getMemoryContext();
      const transcript = await this.store.getTranscript(sessionId);
      const output = await this.pipeline.extract(transcript, existingContext);

      if (!output) {
        await this.store.updateExtraction(
          extractionId,
          'failed',
          0,
          'extraction returned no results'
        );
        return;
      }

      const { result, factEmbeddings, transcriptChunks } = output;
      let memoriesCreated = 0;

      const factIds: string[] = [];
      for (let i = 0; i < result.facts.length; i++) {
        const fact = result.facts[i];
        const embedding = factEmbeddings[i] ?? undefined;
        const factId = await this.store.upsertFact(
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

      for (const pref of result.preferences) {
        await this.store.upsertPreference(pref.preference, pref.category, sessionId);
        memoriesCreated++;
      }

      for (const field of result.userProfile) {
        await this.store.upsertUserProfile(field.field, field.value, 0.8, sessionId);
        memoriesCreated++;
      }

      for (const update of result.identityUpdates) {
        await this.store.upsertIdentity(update.attribute, update.value, 'user_feedback', sessionId);
        memoriesCreated++;
      }

      if (result.sessionSummary.summary) {
        await this.store.createSessionSummary(sessionId, {
          summary: result.sessionSummary.summary,
          topics: result.sessionSummary.topics,
          keyDecisions: result.sessionSummary.keyDecisions,
          openThreads: result.sessionSummary.openThreads,
          extractionModel: 'adapter-text',
          extractionCostUsd: null,
        });
      }

      if (transcriptChunks.length > 0) {
        await this.store.insertTranscriptChunks(sessionId, transcriptChunks);
        log.info('transcript chunks indexed', { count: transcriptChunks.length });
      }

      if (result.entities && result.entities.length > 0) {
        const entityTypeMap = new Map<string, string>();
        const entityIdMap = new Map<string, string>();
        for (const entity of result.entities) {
          entityTypeMap.set(entity.name.toLowerCase(), entity.type);
        }

        for (const entity of result.entities) {
          try {
            const entityId = await this.store.upsertEntity(entity.name, entity.type);
            entityIdMap.set(entity.name.toLowerCase(), entityId);
            memoriesCreated++;
          } catch (entityErr) {
            log.warn('entity creation failed', {
              entity: entity.name,
              err: String(entityErr),
            });
          }
        }

        for (let i = 0; i < result.facts.length; i++) {
          const fact = result.facts[i];
          const factId = factIds[i];
          const mentioned = fact.mentionedEntities ?? [];
          for (const entityName of mentioned) {
            const entityId = entityIdMap.get(entityName.toLowerCase());
            if (entityId) {
              await this.store.linkFactEntity(factId, entityId);
            }
          }
        }

        for (const entity of result.entities) {
          const sourceEntityId = entityIdMap.get(entity.name.toLowerCase());
          if (!sourceEntityId || !entity.relationships) continue;

          for (const rel of entity.relationships) {
            try {
              const targetType = entityTypeMap.get(rel.target.toLowerCase()) ?? 'concept';
              let targetId = entityIdMap.get(rel.target.toLowerCase());
              if (!targetId) {
                targetId = await this.store.upsertEntity(rel.target, targetType);
                entityIdMap.set(rel.target.toLowerCase(), targetId);
              }
              const relevantFactId = factIds.find((_, idx) => {
                const mentioned = result.facts[idx].mentionedEntities ?? [];
                const mentionedLower = mentioned.map((n) => n.toLowerCase());
                return (
                  mentionedLower.includes(entity.name.toLowerCase()) &&
                  mentionedLower.includes(rel.target.toLowerCase())
                );
              });
              await this.store.createEntityRelationship(
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

      await this.store.updateExtraction(extractionId, 'completed', memoriesCreated);
      log.info('extraction stored', { sessionId, memoriesCreated });

      if (this.onExtractionComplete) {
        await this.onExtractionComplete().catch((e) =>
          log.warn('post-extraction callback failed', { err: String(e) })
        );
      }
    } catch (err) {
      log.error('extraction failed', { sessionId, err: String(err) });
      await this.store
        .updateExtraction(extractionId, 'failed', 0, String(err))
        .catch((e) => log.warn('failed to update extraction status', { err: String(e) }));
    }
  }
}
