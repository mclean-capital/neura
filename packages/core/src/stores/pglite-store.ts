import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type {
  DataStore,
  SessionRecord,
  TranscriptEntry,
  IdentityEntry,
  UserProfileEntry,
  FactEntry,
  PreferenceEntry,
  SessionSummaryEntry,
  MemoryExtractionRecord,
  MemoryContext,
  MemoryBackup,
  WorkItemEntry,
  WorkItemPriority,
  EntityEntry,
  EntityRelationship,
  TimelineEntry,
  MemoryStats,
  TranscriptChunkEntry,
} from '@neura/types';
import { runMigrations } from './migrations.js';
import * as sessionQ from './session-queries.js';
import * as memoryQ from './memory-queries.js';
import * as searchQ from './search-queries.js';
import * as entityQ from './entity-queries.js';
import * as workItemQ from './work-item-queries.js';
import * as backupQ from './backup-queries.js';

export class PgliteStore implements DataStore {
  private db: PGlite;

  private constructor(db: PGlite) {
    this.db = db;
  }

  /**
   * Create a PgliteStore backed by a directory on disk (WAL-persisted).
   * If no dataDir is provided, creates an in-memory instance (useful for tests).
   */
  static async create(dataDir?: string): Promise<PgliteStore> {
    const db = await PGlite.create(dataDir ?? 'memory://', {
      extensions: { vector },
    });

    const store = new PgliteStore(db);
    await runMigrations(db);
    return store;
  }

  // --- Session methods ---

  createSession(voiceProvider: string, visionProvider: string): Promise<string> {
    return sessionQ.createSession(this.db, voiceProvider, visionProvider);
  }

  endSession(sessionId: string, costUsd: number): Promise<void> {
    return sessionQ.endSession(this.db, sessionId, costUsd);
  }

  appendTranscript(sessionId: string, role: 'user' | 'assistant', text: string): Promise<void> {
    return sessionQ.appendTranscript(this.db, sessionId, role, text);
  }

  getSessions(limit?: number): Promise<SessionRecord[]> {
    return sessionQ.getSessions(this.db, limit);
  }

  getTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    return sessionQ.getTranscript(this.db, sessionId);
  }

  // --- Identity methods ---

  getIdentity(): Promise<IdentityEntry[]> {
    return memoryQ.getIdentity(this.db);
  }

  upsertIdentity(
    attribute: string,
    value: string,
    source: 'default' | 'user_feedback',
    sourceSessionId?: string
  ): Promise<void> {
    return memoryQ.upsertIdentity(this.db, attribute, value, source, sourceSessionId);
  }

  // --- User profile methods ---

  getUserProfile(): Promise<UserProfileEntry[]> {
    return memoryQ.getUserProfile(this.db);
  }

  upsertUserProfile(
    field: string,
    value: string,
    confidence: number,
    sourceSessionId?: string
  ): Promise<void> {
    return memoryQ.upsertUserProfile(this.db, field, value, confidence, sourceSessionId);
  }

  // --- Facts methods ---

  getFacts(options?: {
    category?: string;
    limit?: number;
    minConfidence?: number;
  }): Promise<FactEntry[]> {
    return memoryQ.getFacts(this.db, options);
  }

  searchFacts(query: string, embedding?: number[], limit?: number): Promise<FactEntry[]> {
    return memoryQ.searchFacts(this.db, query, embedding, limit);
  }

  upsertFact(
    content: string,
    category: string,
    tags: string[],
    sourceSessionId?: string,
    confidence?: number,
    embedding?: number[],
    tagPath?: string
  ): Promise<string> {
    return memoryQ.upsertFact(
      this.db,
      content,
      category,
      tags,
      sourceSessionId,
      confidence,
      embedding,
      tagPath
    );
  }

  touchFact(id: string): Promise<void> {
    return memoryQ.touchFact(this.db, id);
  }

  deleteFact(id: string): Promise<void> {
    return memoryQ.deleteFact(this.db, id);
  }

  // --- Preferences methods ---

  getPreferences(options?: {
    category?: string;
    minStrength?: number;
  }): Promise<PreferenceEntry[]> {
    return memoryQ.getPreferences(this.db, options);
  }

  upsertPreference(preference: string, category: string, sourceSessionId?: string): Promise<void> {
    return memoryQ.upsertPreference(this.db, preference, category, sourceSessionId);
  }

  reinforcePreference(id: string): Promise<void> {
    return memoryQ.reinforcePreference(this.db, id);
  }

  // --- Session summaries ---

  getSessionSummary(sessionId: string): Promise<SessionSummaryEntry | null> {
    return memoryQ.getSessionSummary(this.db, sessionId);
  }

  getRecentSummaries(limit?: number): Promise<SessionSummaryEntry[]> {
    return memoryQ.getRecentSummaries(this.db, limit);
  }

  createSessionSummary(
    sessionId: string,
    summary: Omit<SessionSummaryEntry, 'id' | 'sessionId' | 'createdAt'>
  ): Promise<void> {
    return memoryQ.createSessionSummary(this.db, sessionId, summary);
  }

  // --- Extraction tracking ---

  createExtraction(sessionId: string): Promise<string> {
    return memoryQ.createExtraction(this.db, sessionId);
  }

  updateExtraction(
    id: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    memoriesCreated?: number,
    error?: string
  ): Promise<void> {
    return memoryQ.updateExtraction(this.db, id, status, memoriesCreated, error);
  }

  getPendingExtractions(): Promise<MemoryExtractionRecord[]> {
    return memoryQ.getPendingExtractions(this.db);
  }

  // --- Composite memory context ---

  getMemoryContext(options?: { maxTokens?: number }): Promise<MemoryContext> {
    return memoryQ.getMemoryContext(this.db, options);
  }

  // --- Work items ---

  getOpenWorkItems(limit?: number): Promise<WorkItemEntry[]> {
    return workItemQ.getOpenWorkItems(this.db, limit);
  }

  getWorkItems(options?: { status?: string; limit?: number }): Promise<WorkItemEntry[]> {
    return workItemQ.getWorkItems(this.db, options);
  }

  getWorkItem(id: string): Promise<WorkItemEntry | null> {
    return workItemQ.getWorkItem(this.db, id);
  }

  createWorkItem(
    title: string,
    priority: WorkItemPriority,
    options?: {
      description?: string;
      dueAt?: string;
      parentId?: string;
      sourceSessionId?: string;
    }
  ): Promise<string> {
    return workItemQ.createWorkItem(this.db, title, priority, options);
  }

  updateWorkItem(
    id: string,
    updates: Partial<Pick<WorkItemEntry, 'status' | 'priority' | 'title' | 'description' | 'dueAt'>>
  ): Promise<void> {
    return workItemQ.updateWorkItem(this.db, id, updates);
  }

  deleteWorkItem(id: string): Promise<void> {
    return workItemQ.deleteWorkItem(this.db, id);
  }

  // --- Backup & recovery ---

  exportMemories(): Promise<MemoryBackup> {
    return backupQ.exportMemories(this.db);
  }

  importMemories(backup: MemoryBackup): Promise<{ imported: number; skipped: number }> {
    return backupQ.importMemories(this.db, backup);
  }

  // --- Phase 5b: Hybrid Retrieval ---

  searchFactsHybrid(query: string, embedding?: number[], limit?: number): Promise<FactEntry[]> {
    return searchQ.searchFactsHybrid(this.db, query, embedding, limit);
  }

  searchTranscripts(
    embedding: number[],
    limit?: number,
    sessionId?: string
  ): Promise<TranscriptChunkEntry[]> {
    return searchQ.searchTranscripts(this.db, embedding, limit, sessionId);
  }

  insertTranscriptChunks(
    sessionId: string,
    chunks: {
      chunkText: string;
      embedding: number[];
      startTranscriptId: number;
      endTranscriptId: number;
    }[]
  ): Promise<void> {
    return searchQ.insertTranscriptChunks(this.db, sessionId, chunks);
  }

  // --- Phase 5b: Temporal Tracking ---

  invalidateFact(id: string): Promise<void> {
    return entityQ.invalidateFact(this.db, id);
  }

  supersedeFact(oldId: string, newId: string): Promise<void> {
    return entityQ.supersedeFact(this.db, oldId, newId);
  }

  getFactHistory(content: string, category: string): Promise<FactEntry[]> {
    return entityQ.getFactHistory(this.db, content, category);
  }

  // --- Phase 5b: Entities ---

  upsertEntity(name: string, type: string): Promise<string> {
    return entityQ.upsertEntity(this.db, name, type);
  }

  getEntities(type?: string): Promise<EntityEntry[]> {
    return entityQ.getEntities(this.db, type);
  }

  linkFactEntity(factId: string, entityId: string): Promise<void> {
    return entityQ.linkFactEntity(this.db, factId, entityId);
  }

  getRelatedFacts(factId: string, limit?: number): Promise<FactEntry[]> {
    return entityQ.getRelatedFacts(this.db, factId, limit);
  }

  getEntityRelationships(entityId: string): Promise<EntityRelationship[]> {
    return entityQ.getEntityRelationships(this.db, entityId);
  }

  createEntityRelationship(
    sourceEntityId: string,
    targetEntityId: string,
    relationship: string,
    sourceFactId?: string
  ): Promise<string> {
    return entityQ.createEntityRelationship(
      this.db,
      sourceEntityId,
      targetEntityId,
      relationship,
      sourceFactId
    );
  }

  // --- Phase 5b: Timeline & Stats ---

  getTimeline(from: Date, to: Date, entityFilter?: string): Promise<TimelineEntry[]> {
    return entityQ.getTimeline(this.db, from, to, entityFilter);
  }

  getMemoryStats(): Promise<MemoryStats> {
    return entityQ.getMemoryStats(this.db);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
