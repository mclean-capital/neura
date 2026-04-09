import type { PGlite } from '@electric-sql/pglite';
import type { MemoryBackup, EntityRelationship } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { mapFact, mapTranscriptChunk, updateFactTsv } from './mappers.js';
import type { FactRow, TranscriptChunkRow } from './mappers.js';
import {
  getIdentity,
  getUserProfile,
  getPreferences,
  getRecentSummaries,
} from './memory-queries.js';
import { getEntities } from './entity-queries.js';

const log = new Logger('store');

// --- Backup & recovery ---

export async function exportMemories(db: PGlite): Promise<MemoryBackup> {
  const identity = await getIdentity(db);
  const userProfile = await getUserProfile(db);
  // Export ALL facts including invalidated ones (for temporal history preservation)
  const allFactsResult = await db.query<FactRow>('SELECT * FROM facts ORDER BY created_at');
  const facts = allFactsResult.rows.map((r) => mapFact(r));
  const preferences = await getPreferences(db);
  const sessionSummaries = await getRecentSummaries(db, 1000);
  const entities = await getEntities(db);
  const relResult = await db.query<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relationship: string;
    valid_from: string;
    valid_to: string | null;
    source_fact_id: string | null;
    created_at: string;
  }>('SELECT * FROM entity_relationships');
  const entityRelationships: EntityRelationship[] = relResult.rows.map((r) => ({
    id: r.id,
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    relationship: r.relationship,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    sourceFactId: r.source_fact_id,
    createdAt: r.created_at,
  }));

  const factEntitiesResult = await db.query<{
    fact_id: string;
    entity_id: string;
  }>('SELECT * FROM fact_entities');
  const factEntities = factEntitiesResult.rows.map((r) => ({
    factId: r.fact_id,
    entityId: r.entity_id,
  }));

  const chunkResult = await db.query<TranscriptChunkRow>(
    'SELECT id, session_id, chunk_text, start_transcript_id, end_transcript_id, created_at, embedding::text FROM transcript_chunks ORDER BY created_at'
  );
  const transcriptChunks = chunkResult.rows.map((r) => mapTranscriptChunk(r));

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    identity,
    userProfile,
    facts,
    preferences,
    sessionSummaries,
    entities,
    entityRelationships,
    factEntities,
    transcriptChunks,
  };
}

export async function importMemories(
  db: PGlite,
  backup: MemoryBackup
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  // Identity — direct SQL to preserve all fields
  for (const entry of backup.identity ?? []) {
    try {
      await db.query(
        `INSERT INTO identity (id, attribute, value, source, source_session_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (attribute) DO UPDATE SET
           value = EXCLUDED.value,
           source = EXCLUDED.source,
           updated_at = EXCLUDED.updated_at`,
        [
          entry.id,
          entry.attribute,
          entry.value,
          entry.source,
          entry.sourceSessionId,
          entry.createdAt,
          entry.updatedAt,
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // User profile — direct SQL to preserve confidence
  for (const entry of backup.userProfile ?? []) {
    try {
      await db.query(
        `INSERT INTO user_profile (id, field, value, confidence, source_session_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (field, value) DO UPDATE SET
           confidence = EXCLUDED.confidence,
           updated_at = EXCLUDED.updated_at`,
        [
          entry.id,
          entry.field,
          entry.value,
          entry.confidence,
          entry.sourceSessionId,
          entry.createdAt,
          entry.updatedAt,
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // Facts — direct SQL to preserve all fields including Phase 5b temporal/tag columns
  for (const entry of backup.facts ?? []) {
    try {
      const validFrom = entry.validFrom ?? entry.createdAt;
      const validTo = entry.validTo ?? null;
      const tagPath = entry.tagPath ?? entry.category;
      const factResult = await db.query<{ id: string }>(
        `INSERT INTO facts (id, content, category, tags, source_session_id, confidence, access_count, last_accessed_at, created_at, updated_at, expires_at, valid_from, valid_to, superseded_by, tag_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (content, category) DO UPDATE SET
           tags = EXCLUDED.tags,
           confidence = GREATEST(facts.confidence, EXCLUDED.confidence),
           access_count = GREATEST(facts.access_count, EXCLUDED.access_count),
           last_accessed_at = COALESCE(EXCLUDED.last_accessed_at, facts.last_accessed_at),
           expires_at = COALESCE(EXCLUDED.expires_at, facts.expires_at),
           valid_from = COALESCE(facts.valid_from, EXCLUDED.valid_from),
           valid_to = EXCLUDED.valid_to,
           tag_path = COALESCE(EXCLUDED.tag_path, facts.tag_path),
           updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [
          entry.id,
          entry.content,
          entry.category,
          JSON.stringify(entry.tags),
          entry.sourceSessionId,
          entry.confidence,
          entry.accessCount,
          entry.lastAccessedAt,
          entry.createdAt,
          entry.updatedAt,
          entry.expiresAt,
          validFrom,
          validTo,
          entry.supersededBy ?? null,
          tagPath,
        ]
      );
      // Use the surviving row ID (may differ from entry.id on conflict)
      const survivingId = factResult.rows[0].id;
      await updateFactTsv(db, survivingId);
      imported++;
    } catch {
      skipped++;
    }
  }

  // Preferences — direct SQL to preserve strength and reinforcementCount
  for (const entry of backup.preferences ?? []) {
    try {
      await db.query(
        `INSERT INTO preferences (id, preference, category, strength, source_session_id, reinforcement_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (preference, category) DO UPDATE SET
           strength = GREATEST(preferences.strength, EXCLUDED.strength),
           reinforcement_count = GREATEST(preferences.reinforcement_count, EXCLUDED.reinforcement_count),
           updated_at = EXCLUDED.updated_at`,
        [
          entry.id,
          entry.preference,
          entry.category,
          entry.strength,
          entry.sourceSessionId,
          entry.reinforcementCount,
          entry.createdAt,
          entry.updatedAt,
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // Session summaries — need stub session rows for FK constraint
  for (const entry of backup.sessionSummaries ?? []) {
    try {
      await db.query(
        `INSERT INTO sessions (id, voice_provider, vision_provider)
         VALUES ($1, 'restored', 'restored')
         ON CONFLICT (id) DO NOTHING`,
        [entry.sessionId]
      );
      await db.query(
        `INSERT INTO session_summaries (id, session_id, summary, topics, key_decisions, open_threads, extraction_model, extraction_cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (session_id) DO UPDATE SET
           summary = EXCLUDED.summary,
           topics = EXCLUDED.topics,
           key_decisions = EXCLUDED.key_decisions,
           open_threads = EXCLUDED.open_threads`,
        [
          entry.id,
          entry.sessionId,
          entry.summary,
          JSON.stringify(entry.topics),
          JSON.stringify(entry.keyDecisions),
          JSON.stringify(entry.openThreads),
          entry.extractionModel,
          entry.extractionCostUsd,
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // Phase 5b: Entities (v2 backups only)
  for (const entry of backup.entities ?? []) {
    try {
      await db.query(
        `INSERT INTO entities (id, name, type, canonical_name, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (canonical_name, type) DO UPDATE SET name = EXCLUDED.name`,
        [entry.id, entry.name, entry.type, entry.canonicalName, entry.createdAt]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // Phase 5b: Entity relationships (v2 backups only)
  for (const entry of backup.entityRelationships ?? []) {
    try {
      await db.query(
        `INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, relationship, valid_from, valid_to, source_fact_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          entry.id,
          entry.sourceEntityId,
          entry.targetEntityId,
          entry.relationship,
          entry.validFrom,
          entry.validTo,
          entry.sourceFactId,
          entry.createdAt,
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // Phase 5b: Fact-entity links (v2 backups only)
  for (const entry of backup.factEntities ?? []) {
    try {
      await db.query(
        'INSERT INTO fact_entities (fact_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [entry.factId, entry.entityId]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  // Transcript chunks — create stub session rows for FK constraint (same pattern as session_summaries)
  for (const entry of backup.transcriptChunks ?? []) {
    try {
      await db.query(
        `INSERT INTO sessions (id, voice_provider, vision_provider)
         VALUES ($1, 'restored', 'restored')
         ON CONFLICT (id) DO NOTHING`,
        [entry.sessionId]
      );
      const embeddingStr = entry.embedding ? `[${entry.embedding.join(',')}]` : null;
      await db.query(
        `INSERT INTO transcript_chunks (id, session_id, chunk_text, embedding, start_transcript_id, end_transcript_id, created_at)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          entry.sessionId,
          entry.chunkText,
          embeddingStr,
          entry.startTranscriptId,
          entry.endTranscriptId,
          entry.createdAt,
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  log.info('import complete', { imported, skipped });
  return { imported, skipped };
}
