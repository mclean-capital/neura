import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type {
  IdentityEntry,
  UserProfileEntry,
  FactEntry,
  PreferenceEntry,
  SessionSummaryEntry,
  MemoryExtractionRecord,
  MemoryContext,
} from '@neura/types';
import { mapFact, mapSummary, updateFactTsv } from './mappers.js';
import type { FactRow } from './mappers.js';

// --- Identity methods ---

export async function getIdentity(db: PGlite): Promise<IdentityEntry[]> {
  const result = await db.query<{
    id: string;
    attribute: string;
    value: string;
    source: 'default' | 'user_feedback';
    source_session_id: string | null;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM identity ORDER BY created_at ASC');

  return result.rows.map((r) => ({
    id: r.id,
    attribute: r.attribute,
    value: r.value,
    source: r.source,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function upsertIdentity(
  db: PGlite,
  attribute: string,
  value: string,
  source: 'default' | 'user_feedback',
  sourceSessionId?: string
): Promise<void> {
  await db.query(
    `INSERT INTO identity (id, attribute, value, source, source_session_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (attribute) DO UPDATE
     SET value = EXCLUDED.value,
         source = EXCLUDED.source,
         source_session_id = EXCLUDED.source_session_id,
         updated_at = NOW()`,
    [crypto.randomUUID(), attribute, value, source, sourceSessionId ?? null]
  );
}

// --- User profile methods ---

export async function getUserProfile(db: PGlite): Promise<UserProfileEntry[]> {
  const result = await db.query<{
    id: string;
    field: string;
    value: string;
    confidence: number;
    source_session_id: string | null;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM user_profile ORDER BY confidence DESC, updated_at DESC');

  return result.rows.map((r) => ({
    id: r.id,
    field: r.field,
    value: r.value,
    confidence: r.confidence,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function upsertUserProfile(
  db: PGlite,
  field: string,
  value: string,
  confidence: number,
  sourceSessionId?: string
): Promise<void> {
  await db.query(
    `INSERT INTO user_profile (id, field, value, confidence, source_session_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (field, value) DO UPDATE
     SET confidence = GREATEST(user_profile.confidence, EXCLUDED.confidence),
         source_session_id = EXCLUDED.source_session_id,
         updated_at = NOW()`,
    [crypto.randomUUID(), field, value, confidence, sourceSessionId ?? null]
  );
}

// --- Facts methods ---

export async function getFacts(
  db: PGlite,
  options: { category?: string; limit?: number; minConfidence?: number } = {}
): Promise<FactEntry[]> {
  const { category, limit = 50, minConfidence = 0 } = options;

  let sql =
    'SELECT * FROM facts WHERE confidence >= $1 AND (expires_at IS NULL OR expires_at > NOW()) AND valid_to IS NULL';
  const params: (string | number)[] = [minConfidence];

  if (category) {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }

  params.push(limit);
  sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

  const result = await db.query<FactRow>(sql, params);

  return result.rows.map((r) => mapFact(r));
}

export async function searchFacts(
  db: PGlite,
  query: string,
  embedding?: number[],
  limit = 10
): Promise<FactEntry[]> {
  if (embedding?.length === 3072) {
    const vecStr = `[${embedding.join(',')}]`;
    const result = await db.query<FactRow>(
      `SELECT * FROM facts
       WHERE embedding IS NOT NULL
         AND valid_to IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vecStr, limit]
    );
    return result.rows.map((r) => mapFact(r));
  }

  // Fallback: ILIKE text search
  const result = await db.query<FactRow>(
    `SELECT * FROM facts
     WHERE content ILIKE $1
       AND (expires_at IS NULL OR expires_at > NOW())
       AND valid_to IS NULL
     ORDER BY confidence DESC, updated_at DESC
     LIMIT $2`,
    [`%${query}%`, limit]
  );
  return result.rows.map((r) => mapFact(r));
}

export async function upsertFact(
  db: PGlite,
  content: string,
  category: string,
  tags: string[],
  sourceSessionId?: string,
  confidence = 0.8,
  embedding?: number[],
  tagPath?: string
): Promise<string> {
  if (embedding && embedding.length !== 3072) {
    throw new Error(`Embedding must be 3072-dimensional, got ${embedding.length}`);
  }
  const id = crypto.randomUUID();
  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
  const resolvedTagPath = tagPath ?? category;
  const result = await db.query<{ id: string }>(
    `INSERT INTO facts (id, content, category, tags, source_session_id, confidence, embedding, tag_path, valid_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, NOW())
     ON CONFLICT (content, category) DO UPDATE
     SET tags = EXCLUDED.tags,
         source_session_id = EXCLUDED.source_session_id,
         confidence = GREATEST(facts.confidence, EXCLUDED.confidence),
         embedding = COALESCE(EXCLUDED.embedding, facts.embedding),
         tag_path = COALESCE(EXCLUDED.tag_path, facts.tag_path),
         valid_to = NULL,
         superseded_by = NULL,
         valid_from = CASE WHEN facts.valid_to IS NOT NULL THEN NOW() ELSE facts.valid_from END,
         updated_at = NOW()
     RETURNING id`,
    [
      id,
      content,
      category,
      JSON.stringify(tags),
      sourceSessionId ?? null,
      confidence,
      embeddingStr,
      resolvedTagPath,
    ]
  );
  const factId = result.rows[0].id;
  await updateFactTsv(db, factId);
  return factId;
}

export async function touchFact(db: PGlite, id: string): Promise<void> {
  await db.query(
    'UPDATE facts SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = $1',
    [id]
  );
}

export async function deleteFact(db: PGlite, id: string): Promise<void> {
  await db.query('DELETE FROM facts WHERE id = $1', [id]);
}

// --- Preferences methods ---

export async function getPreferences(
  db: PGlite,
  options: { category?: string; minStrength?: number } = {}
): Promise<PreferenceEntry[]> {
  const { category, minStrength = 0 } = options;

  let sql = 'SELECT * FROM preferences WHERE strength >= $1';
  const params: (string | number)[] = [minStrength];

  if (category) {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }

  sql += ' ORDER BY strength DESC, updated_at DESC';

  const result = await db.query<{
    id: string;
    preference: string;
    category: string;
    strength: number;
    source_session_id: string | null;
    reinforcement_count: number;
    created_at: string;
    updated_at: string;
  }>(sql, params);

  return result.rows.map((r) => ({
    id: r.id,
    preference: r.preference,
    category: r.category as PreferenceEntry['category'],
    strength: r.strength,
    sourceSessionId: r.source_session_id,
    reinforcementCount: r.reinforcement_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function upsertPreference(
  db: PGlite,
  preference: string,
  category: string,
  sourceSessionId?: string
): Promise<void> {
  await db.query(
    `INSERT INTO preferences (id, preference, category, source_session_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (preference, category) DO UPDATE
     SET source_session_id = EXCLUDED.source_session_id,
         reinforcement_count = preferences.reinforcement_count + 1,
         strength = LEAST(preferences.strength + 0.1, 2.0),
         updated_at = NOW()`,
    [crypto.randomUUID(), preference, category, sourceSessionId ?? null]
  );
}

export async function reinforcePreference(db: PGlite, id: string): Promise<void> {
  await db.query(
    `UPDATE preferences
     SET reinforcement_count = reinforcement_count + 1,
         strength = LEAST(strength + 0.1, 2.0),
         updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

// --- Session summaries ---

export async function getSessionSummary(
  db: PGlite,
  sessionId: string
): Promise<SessionSummaryEntry | null> {
  const result = await db.query<{
    id: string;
    session_id: string;
    summary: string;
    topics: string[];
    key_decisions: string[];
    open_threads: string[];
    extraction_model: string;
    extraction_cost_usd: number | null;
    created_at: string;
  }>('SELECT * FROM session_summaries WHERE session_id = $1', [sessionId]);

  if (result.rows.length === 0) return null;
  return mapSummary(result.rows[0]);
}

export async function getRecentSummaries(db: PGlite, limit = 5): Promise<SessionSummaryEntry[]> {
  const result = await db.query<{
    id: string;
    session_id: string;
    summary: string;
    topics: string[];
    key_decisions: string[];
    open_threads: string[];
    extraction_model: string;
    extraction_cost_usd: number | null;
    created_at: string;
  }>('SELECT * FROM session_summaries ORDER BY created_at DESC LIMIT $1', [limit]);

  return result.rows.map((r) => mapSummary(r));
}

export async function createSessionSummary(
  db: PGlite,
  sessionId: string,
  summary: Omit<SessionSummaryEntry, 'id' | 'sessionId' | 'createdAt'>
): Promise<void> {
  await db.query(
    `INSERT INTO session_summaries (id, session_id, summary, topics, key_decisions, open_threads, extraction_model, extraction_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      crypto.randomUUID(),
      sessionId,
      summary.summary,
      JSON.stringify(summary.topics),
      JSON.stringify(summary.keyDecisions),
      JSON.stringify(summary.openThreads),
      summary.extractionModel,
      summary.extractionCostUsd,
    ]
  );
}

// --- Extraction tracking ---

export async function createExtraction(db: PGlite, sessionId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO memory_extractions (id, session_id) VALUES ($1, $2)', [
    id,
    sessionId,
  ]);
  return id;
}

export async function updateExtraction(
  db: PGlite,
  id: string,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  memoriesCreated?: number,
  error?: string
): Promise<void> {
  if (status === 'processing') {
    await db.query(
      `UPDATE memory_extractions
       SET status = $1, started_at = NOW()
       WHERE id = $2`,
      [status, id]
    );
  } else {
    await db.query(
      `UPDATE memory_extractions
       SET status = $1,
           memories_created = COALESCE($2, memories_created),
           error = $3,
           completed_at = NOW()
       WHERE id = $4`,
      [status, memoriesCreated ?? null, error ?? null, id]
    );
  }
}

export async function getPendingExtractions(db: PGlite): Promise<MemoryExtractionRecord[]> {
  const result = await db.query<{
    id: string;
    session_id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    memories_created: number;
    error: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
  }>("SELECT * FROM memory_extractions WHERE status = 'pending' ORDER BY created_at ASC");

  return result.rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    status: r.status,
    memoriesCreated: r.memories_created,
    error: r.error,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  }));
}

// --- Composite memory context ---

export async function getMemoryContext(
  db: PGlite,
  options: { maxTokens?: number } = {}
): Promise<MemoryContext> {
  const maxTokens = options.maxTokens ?? 2000;

  const [identity, userProfile, preferences, recentFacts, recentSummaries] = await Promise.all([
    getIdentity(db),
    getUserProfile(db),
    getPreferences(db),
    getFacts(db, { limit: 20, minConfidence: 0.2 }),
    getRecentSummaries(db, 3),
  ]);

  // Estimate tokens (~4 chars per token)
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  const estimateArrayTokens = (items: unknown[]): number =>
    items.reduce<number>((sum, i) => sum + estimateTokens(JSON.stringify(i)), 0);

  // Priority order: identity > preferences > profile > facts > summaries
  let totalTokens = 0;
  totalTokens += estimateArrayTokens(identity);
  totalTokens += estimateArrayTokens(preferences);
  totalTokens += estimateArrayTokens(userProfile);

  // Trim facts if over budget
  let trimmedFacts = recentFacts;
  const factTokens = estimateArrayTokens(recentFacts);
  totalTokens += factTokens;
  if (totalTokens > maxTokens && factTokens > 0) {
    trimmedFacts = [];
    totalTokens -= factTokens;
    for (const fact of recentFacts) {
      const ft = estimateTokens(JSON.stringify(fact));
      if (totalTokens + ft > maxTokens) break;
      trimmedFacts.push(fact);
      totalTokens += ft;
    }
  }

  // Trim summaries — same approach as facts
  let trimmedSummaries = recentSummaries;
  const summaryTokens = estimateArrayTokens(recentSummaries);
  totalTokens += summaryTokens;
  if (totalTokens > maxTokens && summaryTokens > 0) {
    trimmedSummaries = [];
    totalTokens -= summaryTokens;
    for (const summary of recentSummaries) {
      const st = estimateTokens(JSON.stringify(summary));
      if (totalTokens + st > maxTokens) break;
      trimmedSummaries.push(summary);
      totalTokens += st;
    }
  }

  return {
    identity,
    userProfile,
    recentFacts: trimmedFacts,
    preferences,
    recentSummaries: trimmedSummaries,
    tokenEstimate: totalTokens,
  };
}
