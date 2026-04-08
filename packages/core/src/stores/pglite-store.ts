import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import crypto from 'crypto';
import { Logger } from '@neura/utils/logger';

const log = new Logger('store');
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
} from '@neura/types';

/** Raw DB row shape for facts table (snake_case column names). */
interface FactRow {
  id: string;
  content: string;
  category: string;
  tags: string[];
  source_session_id: string | null;
  confidence: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  superseded_by?: string | null;
  tag_path?: string | null;
}

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
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    await this.db.exec('CREATE EXTENSION IF NOT EXISTS vector;');

    // --- Session & transcript tables (Phase 2) ---

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMP,
        duration_ms INTEGER,
        cost_usd REAL,
        voice_provider TEXT NOT NULL,
        vision_provider TEXT NOT NULL
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id)'
    );

    // --- Memory tables (Phase 3) ---

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity (
        id TEXT PRIMARY KEY,
        attribute TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'default',
        source_session_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        id TEXT PRIMARY KEY,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source_session_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(field, value)
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        tags JSONB NOT NULL DEFAULT '[]',
        embedding vector(3072),
        source_session_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP,
        CONSTRAINT facts_content_category_key UNIQUE(content, category)
      )
    `);

    // Migrate embedding column from vector(768) → vector(3072) if needed
    const typeCheck = await this.db.query<{ col_type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS col_type FROM pg_attribute
       WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`
    );
    if (typeCheck.rows.length > 0 && typeCheck.rows[0].col_type !== 'vector(3072)') {
      await this.db.exec('ALTER TABLE facts DROP COLUMN embedding');
      await this.db.exec('ALTER TABLE facts ADD COLUMN embedding vector(3072)');
      log.info('migrated facts.embedding to vector(3072)', { was: typeCheck.rows[0].col_type });
    }

    // Ensure unique index exists (may be missing on tables created before constraint was added)
    await this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_content_category ON facts(content, category)'
    );

    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at DESC)');

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id TEXT PRIMARY KEY,
        preference TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        strength REAL NOT NULL DEFAULT 1.0,
        source_session_id TEXT,
        reinforcement_count INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT preferences_pref_category_key UNIQUE(preference, category)
      )
    `);

    // Ensure unique index exists (may be missing on tables created before constraint was added)
    await this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_preferences_pref_category ON preferences(preference, category)'
    );

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        summary TEXT NOT NULL,
        topics JSONB NOT NULL DEFAULT '[]',
        key_decisions JSONB NOT NULL DEFAULT '[]',
        open_threads JSONB NOT NULL DEFAULT '[]',
        extraction_model TEXT NOT NULL,
        extraction_cost_usd REAL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_extractions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        memories_created INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_extractions_status ON memory_extractions(status)'
    );

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled', 'failed')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('low', 'medium', 'high')),
        due_at TIMESTAMP,
        parent_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
        source_session_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_due ON work_items(due_at)');

    // --- Phase 5b: Advanced Memory ---

    // Temporal tracking columns on facts
    await this.db.exec(
      'ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_from TIMESTAMP DEFAULT NOW()'
    );
    await this.db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_to TIMESTAMP');
    await this.db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS superseded_by TEXT');
    await this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts (valid_to) WHERE valid_to IS NULL'
    );

    // Hierarchical tag path
    await this.db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS tag_path TEXT');
    // Backfill tag_path from category for existing facts
    await this.db.exec(
      'UPDATE facts SET tag_path = category WHERE tag_path IS NULL AND category IS NOT NULL'
    );

    // Full-text search (application-managed tsvector)
    await this.db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS tsv tsvector');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_facts_tsv ON facts USING GIN (tsv)');
    // Backfill tsvector for existing facts
    await this.db.exec(`
      UPDATE facts SET tsv = to_tsvector('english',
        content || ' ' || COALESCE((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(tags)), '')
      ) WHERE tsv IS NULL
    `);

    // Transcript embeddings
    await this.db.exec('ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS embedding vector(3072)');

    // Entity tables
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(canonical_name, type)
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_relationships (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL REFERENCES entities(id),
        target_entity_id TEXT NOT NULL REFERENCES entities(id),
        relationship TEXT NOT NULL,
        valid_from TIMESTAMP NOT NULL DEFAULT NOW(),
        valid_to TIMESTAMP,
        source_fact_id TEXT REFERENCES facts(id),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_entities (
        fact_id TEXT NOT NULL REFERENCES facts(id),
        entity_id TEXT NOT NULL REFERENCES entities(id),
        PRIMARY KEY (fact_id, entity_id)
      )
    `);

    await this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_rels_source ON entity_relationships(source_entity_id)'
    );
    await this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_rels_target ON entity_relationships(target_entity_id)'
    );
    await this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id)'
    );
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_facts_tag_path ON facts(tag_path)');

    // Seed default identity if table is empty
    const identityCount = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::TEXT as count FROM identity'
    );
    if (identityCount.rows[0].count === '0') {
      await this.seedIdentity();
    }
  }

  /** Update the tsvector column for a fact (application-managed full-text search). */
  private async updateFactTsv(factId: string): Promise<void> {
    await this.db.query(
      `UPDATE facts SET tsv = to_tsvector('english',
        content || ' ' || COALESCE((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(tags)), '')
      ) WHERE id = $1`,
      [factId]
    );
  }

  private async seedIdentity(): Promise<void> {
    const defaults = [
      [
        'base_personality',
        'You are Neura, a helpful voice assistant with camera and screen vision.',
      ],
      ['tone', 'direct and conversational'],
      ['verbosity', 'concise — 1-2 sentences unless asked for detail'],
      ['filler_words', 'avoid — no filler, no hedging'],
    ];
    for (const [attribute, value] of defaults) {
      await this.db.query(
        'INSERT INTO identity (id, attribute, value, source) VALUES ($1, $2, $3, $4)',
        [crypto.randomUUID(), attribute, value, 'default']
      );
    }
  }

  // --- Session methods ---

  async createSession(voiceProvider: string, visionProvider: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO sessions (id, voice_provider, vision_provider) VALUES ($1, $2, $3)',
      [id, voiceProvider, visionProvider]
    );
    return id;
  }

  async endSession(sessionId: string, costUsd: number): Promise<void> {
    await this.db.query(
      `UPDATE sessions
       SET ended_at = NOW(),
           duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER,
           cost_usd = $1
       WHERE id = $2`,
      [costUsd, sessionId]
    );
  }

  async appendTranscript(
    sessionId: string,
    role: 'user' | 'assistant',
    text: string
  ): Promise<void> {
    await this.db.query('INSERT INTO transcripts (session_id, role, text) VALUES ($1, $2, $3)', [
      sessionId,
      role,
      text,
    ]);
  }

  async getSessions(limit = 50): Promise<SessionRecord[]> {
    const result = await this.db.query<{
      id: string;
      started_at: string;
      ended_at: string | null;
      duration_ms: number | null;
      cost_usd: number | null;
      voice_provider: string;
      vision_provider: string;
    }>('SELECT * FROM sessions ORDER BY started_at DESC LIMIT $1', [limit]);

    return result.rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
      costUsd: r.cost_usd,
      voiceProvider: r.voice_provider,
      visionProvider: r.vision_provider,
    }));
  }

  async getTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const result = await this.db.query<{
      id: number;
      session_id: string;
      role: 'user' | 'assistant';
      text: string;
      created_at: string;
    }>('SELECT * FROM transcripts WHERE session_id = $1 ORDER BY id ASC', [sessionId]);

    return result.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  // --- Identity methods ---

  async getIdentity(): Promise<IdentityEntry[]> {
    const result = await this.db.query<{
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

  async upsertIdentity(
    attribute: string,
    value: string,
    source: 'default' | 'user_feedback',
    sourceSessionId?: string
  ): Promise<void> {
    await this.db.query(
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

  async getUserProfile(): Promise<UserProfileEntry[]> {
    const result = await this.db.query<{
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

  async upsertUserProfile(
    field: string,
    value: string,
    confidence: number,
    sourceSessionId?: string
  ): Promise<void> {
    await this.db.query(
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

  async getFacts(
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

    const result = await this.db.query<FactRow>(sql, params);

    return result.rows.map((r) => this.mapFact(r));
  }

  async searchFacts(query: string, embedding?: number[], limit = 10): Promise<FactEntry[]> {
    if (embedding?.length === 3072) {
      const vecStr = `[${embedding.join(',')}]`;
      const result = await this.db.query<FactRow>(
        `SELECT * FROM facts
         WHERE embedding IS NOT NULL
           AND valid_to IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vecStr, limit]
      );
      return result.rows.map((r) => this.mapFact(r));
    }

    // Fallback: ILIKE text search
    const result = await this.db.query<FactRow>(
      `SELECT * FROM facts
       WHERE content ILIKE $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND valid_to IS NULL
       ORDER BY confidence DESC, updated_at DESC
       LIMIT $2`,
      [`%${query}%`, limit]
    );
    return result.rows.map((r) => this.mapFact(r));
  }

  async upsertFact(
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
    const result = await this.db.query<{ id: string }>(
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
    await this.updateFactTsv(factId);
    return factId;
  }

  async touchFact(id: string): Promise<void> {
    await this.db.query(
      'UPDATE facts SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = $1',
      [id]
    );
  }

  async deleteFact(id: string): Promise<void> {
    await this.db.query('DELETE FROM facts WHERE id = $1', [id]);
  }

  // --- Preferences methods ---

  async getPreferences(
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

    const result = await this.db.query<{
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

  async upsertPreference(
    preference: string,
    category: string,
    sourceSessionId?: string
  ): Promise<void> {
    await this.db.query(
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

  async reinforcePreference(id: string): Promise<void> {
    await this.db.query(
      `UPDATE preferences
       SET reinforcement_count = reinforcement_count + 1,
           strength = LEAST(strength + 0.1, 2.0),
           updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // --- Session summaries ---

  async getSessionSummary(sessionId: string): Promise<SessionSummaryEntry | null> {
    const result = await this.db.query<{
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
    return this.mapSummary(result.rows[0]);
  }

  async getRecentSummaries(limit = 5): Promise<SessionSummaryEntry[]> {
    const result = await this.db.query<{
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

    return result.rows.map((r) => this.mapSummary(r));
  }

  async createSessionSummary(
    sessionId: string,
    summary: Omit<SessionSummaryEntry, 'id' | 'sessionId' | 'createdAt'>
  ): Promise<void> {
    await this.db.query(
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

  async createExtraction(sessionId: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.query('INSERT INTO memory_extractions (id, session_id) VALUES ($1, $2)', [
      id,
      sessionId,
    ]);
    return id;
  }

  async updateExtraction(
    id: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    memoriesCreated?: number,
    error?: string
  ): Promise<void> {
    if (status === 'processing') {
      await this.db.query(
        `UPDATE memory_extractions
         SET status = $1, started_at = NOW()
         WHERE id = $2`,
        [status, id]
      );
    } else {
      await this.db.query(
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

  async getPendingExtractions(): Promise<MemoryExtractionRecord[]> {
    const result = await this.db.query<{
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

  async getMemoryContext(options: { maxTokens?: number } = {}): Promise<MemoryContext> {
    const maxTokens = options.maxTokens ?? 2000;

    const [identity, userProfile, preferences, recentFacts, recentSummaries] = await Promise.all([
      this.getIdentity(),
      this.getUserProfile(),
      this.getPreferences(),
      this.getFacts({ limit: 20, minConfidence: 0.2 }),
      this.getRecentSummaries(3),
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

  // --- Work items ---

  async getOpenWorkItems(limit = 50): Promise<WorkItemEntry[]> {
    const result = await this.db.query<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      due_at: string | null;
      parent_id: string | null;
      source_session_id: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>(
      `SELECT * FROM work_items
       WHERE status IN ('pending', 'in_progress')
       ORDER BY
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
         due_at ASC NULLS LAST,
         created_at ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((r) => this.mapWorkItem(r));
  }

  async getWorkItems(options?: { status?: string; limit?: number }): Promise<WorkItemEntry[]> {
    const limit = options?.limit ?? 100;
    const status = options?.status;

    let query: string;
    let params: unknown[];

    if (status && status !== 'all') {
      query = `SELECT * FROM work_items WHERE status = $1
               ORDER BY created_at DESC LIMIT $2`;
      params = [status, limit];
    } else {
      query = `SELECT * FROM work_items
               ORDER BY created_at DESC LIMIT $1`;
      params = [limit];
    }

    const result = await this.db.query<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      due_at: string | null;
      parent_id: string | null;
      source_session_id: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>(query, params);
    return result.rows.map((r) => this.mapWorkItem(r));
  }

  async getWorkItem(id: string): Promise<WorkItemEntry | null> {
    const result = await this.db.query<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      due_at: string | null;
      parent_id: string | null;
      source_session_id: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>('SELECT * FROM work_items WHERE id = $1', [id]);
    return result.rows.length > 0 ? this.mapWorkItem(result.rows[0]) : null;
  }

  async createWorkItem(
    title: string,
    priority: WorkItemPriority,
    options?: {
      description?: string;
      dueAt?: string;
      parentId?: string;
      sourceSessionId?: string;
    }
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO work_items (id, title, priority, description, due_at, parent_id, source_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        title,
        priority,
        options?.description ?? null,
        options?.dueAt ?? null,
        options?.parentId ?? null,
        options?.sourceSessionId ?? null,
      ]
    );
    return id;
  }

  async updateWorkItem(
    id: string,
    updates: Partial<Pick<WorkItemEntry, 'status' | 'priority' | 'title' | 'description' | 'dueAt'>>
  ): Promise<void> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (updates.title !== undefined) {
      sets.push(`title = $${paramIdx++}`);
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      sets.push(`description = $${paramIdx++}`);
      values.push(updates.description);
    }
    if (updates.status !== undefined) {
      sets.push(`status = $${paramIdx++}`);
      values.push(updates.status);
      if (
        updates.status === 'done' ||
        updates.status === 'cancelled' ||
        updates.status === 'failed'
      ) {
        sets.push('completed_at = NOW()');
      }
    }
    if (updates.priority !== undefined) {
      sets.push(`priority = $${paramIdx++}`);
      values.push(updates.priority);
    }
    if (updates.dueAt !== undefined) {
      sets.push(`due_at = $${paramIdx++}`);
      values.push(updates.dueAt);
    }

    values.push(id);
    await this.db.query(`UPDATE work_items SET ${sets.join(', ')} WHERE id = $${paramIdx}`, values);
  }

  async deleteWorkItem(id: string): Promise<void> {
    await this.db.query('DELETE FROM work_items WHERE id = $1', [id]);
  }

  private mapWorkItem(r: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    due_at: string | null;
    parent_id: string | null;
    source_session_id: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }): WorkItemEntry {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status as WorkItemEntry['status'],
      priority: r.priority as WorkItemEntry['priority'],
      dueAt: r.due_at,
      parentId: r.parent_id,
      sourceSessionId: r.source_session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
    };
  }

  // --- Backup & recovery ---

  async exportMemories(): Promise<MemoryBackup> {
    const identity = await this.getIdentity();
    const userProfile = await this.getUserProfile();
    // Export ALL facts including invalidated ones (for temporal history preservation)
    const allFactsResult = await this.db.query<FactRow>('SELECT * FROM facts ORDER BY created_at');
    const facts = allFactsResult.rows.map((r) => this.mapFact(r));
    const preferences = await this.getPreferences();
    const sessionSummaries = await this.getRecentSummaries(1000);
    const entities = await this.getEntities();
    const relResult = await this.db.query<{
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

    const factEntitiesResult = await this.db.query<{
      fact_id: string;
      entity_id: string;
    }>('SELECT * FROM fact_entities');
    const factEntities = factEntitiesResult.rows.map((r) => ({
      factId: r.fact_id,
      entityId: r.entity_id,
    }));

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
    };
  }

  async importMemories(backup: MemoryBackup): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    // Identity — direct SQL to preserve all fields
    for (const entry of backup.identity ?? []) {
      try {
        await this.db.query(
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
        await this.db.query(
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
        const factResult = await this.db.query<{ id: string }>(
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
        await this.updateFactTsv(survivingId);
        imported++;
      } catch {
        skipped++;
      }
    }

    // Preferences — direct SQL to preserve strength and reinforcementCount
    for (const entry of backup.preferences ?? []) {
      try {
        await this.db.query(
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
        await this.db.query(
          `INSERT INTO sessions (id, voice_provider, vision_provider)
           VALUES ($1, 'restored', 'restored')
           ON CONFLICT (id) DO NOTHING`,
          [entry.sessionId]
        );
        await this.db.query(
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
        await this.db.query(
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
        await this.db.query(
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
        await this.db.query(
          'INSERT INTO fact_entities (fact_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [entry.factId, entry.entityId]
        );
        imported++;
      } catch {
        skipped++;
      }
    }

    log.info('import complete', { imported, skipped });
    return { imported, skipped };
  }

  // --- Phase 5b: Hybrid Retrieval ---

  async searchFactsHybrid(query: string, embedding?: number[], limit = 10): Promise<FactEntry[]> {
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

    // If we have an embedding, use RRF fusion of vector + BM25
    if (embeddingStr) {
      const result = await this.db.query<FactRow>(
        `WITH vector_results AS (
          SELECT id, content, category, tags, source_session_id, confidence,
                 access_count, last_accessed_at, created_at, updated_at, expires_at,
                 valid_from, valid_to, superseded_by, tag_path,
                 ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vec_rank
          FROM facts
          WHERE embedding IS NOT NULL
            AND confidence >= 0.2
            AND valid_to IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        ),
        text_results AS (
          SELECT id, content, category, tags, source_session_id, confidence,
                 access_count, last_accessed_at, created_at, updated_at, expires_at,
                 valid_from, valid_to, superseded_by, tag_path,
                 ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $3)) DESC) AS text_rank
          FROM facts
          WHERE tsv @@ plainto_tsquery('english', $3)
            AND confidence >= 0.2
            AND valid_to IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $3)) DESC
          LIMIT $2
        )
        SELECT COALESCE(v.id, t.id) AS id,
               COALESCE(v.content, t.content) AS content,
               COALESCE(v.category, t.category) AS category,
               COALESCE(v.tags, t.tags) AS tags,
               COALESCE(v.source_session_id, t.source_session_id) AS source_session_id,
               COALESCE(v.confidence, t.confidence) AS confidence,
               COALESCE(v.access_count, t.access_count) AS access_count,
               COALESCE(v.last_accessed_at, t.last_accessed_at) AS last_accessed_at,
               COALESCE(v.created_at, t.created_at) AS created_at,
               COALESCE(v.updated_at, t.updated_at) AS updated_at,
               COALESCE(v.expires_at, t.expires_at) AS expires_at,
               COALESCE(v.valid_from, t.valid_from) AS valid_from,
               COALESCE(v.valid_to, t.valid_to) AS valid_to,
               COALESCE(v.superseded_by, t.superseded_by) AS superseded_by,
               COALESCE(v.tag_path, t.tag_path) AS tag_path,
               (1.0 / (60 + COALESCE(v.vec_rank, 999))) +
               (1.0 / (60 + COALESCE(t.text_rank, 999))) AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN text_results t ON v.id = t.id
        ORDER BY rrf_score DESC
        LIMIT $2`,
        [embeddingStr, limit, query]
      );
      return result.rows.map((r) => this.mapFact(r));
    }

    // Fallback: text-only BM25 search
    const result = await this.db.query<FactRow>(
      `SELECT * FROM facts
       WHERE tsv @@ plainto_tsquery('english', $1)
         AND valid_to IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC
       LIMIT $2`,
      [query, limit]
    );
    return result.rows.map((r) => this.mapFact(r));
  }

  async searchTranscripts(
    embedding: number[],
    limit = 10,
    sessionId?: string
  ): Promise<TranscriptEntry[]> {
    const embeddingStr = `[${embedding.join(',')}]`;
    if (sessionId) {
      const result = await this.db.query<{
        id: number;
        session_id: string;
        role: 'user' | 'assistant';
        text: string;
        created_at: string;
      }>(
        `SELECT id, session_id, role, text, created_at FROM transcripts
         WHERE session_id = $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [embeddingStr, sessionId, limit]
      );
      return result.rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        text: r.text,
        createdAt: r.created_at,
      }));
    }
    const result = await this.db.query<{
      id: number;
      session_id: string;
      role: 'user' | 'assistant';
      text: string;
      created_at: string;
    }>(
      `SELECT id, session_id, role, text, created_at FROM transcripts
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [embeddingStr, limit]
    );
    return result.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  async indexTranscriptEmbeddings(
    sessionId: string,
    embeddings: Map<number, number[]>
  ): Promise<void> {
    for (const [transcriptId, embedding] of embeddings) {
      const embeddingStr = `[${embedding.join(',')}]`;
      await this.db.query(
        'UPDATE transcripts SET embedding = $1::vector WHERE id = $2 AND session_id = $3',
        [embeddingStr, transcriptId, sessionId]
      );
    }
  }

  // --- Phase 5b: Temporal Tracking ---

  async invalidateFact(id: string): Promise<void> {
    await this.db.query('UPDATE facts SET valid_to = NOW(), updated_at = NOW() WHERE id = $1', [
      id,
    ]);
  }

  async supersedeFact(oldId: string, newId: string): Promise<void> {
    await this.db.query(
      'UPDATE facts SET valid_to = NOW(), superseded_by = $2, updated_at = NOW() WHERE id = $1',
      [oldId, newId]
    );
  }

  async getFactHistory(content: string, category: string): Promise<FactEntry[]> {
    const result = await this.db.query<FactRow>(
      `SELECT * FROM facts WHERE content = $1 AND category = $2 ORDER BY created_at DESC`,
      [content, category]
    );
    return result.rows.map((r) => this.mapFact(r));
  }

  // --- Phase 5b: Entities ---

  async upsertEntity(name: string, type: string): Promise<string> {
    const id = crypto.randomUUID();
    const canonicalName = name.toLowerCase().trim();
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO entities (id, name, type, canonical_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (canonical_name, type) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [id, name, type, canonicalName]
    );
    return result.rows[0].id;
  }

  async getEntities(type?: string): Promise<EntityEntry[]> {
    if (type) {
      const result = await this.db.query<{
        id: string;
        name: string;
        type: string;
        canonical_name: string;
        created_at: string;
      }>('SELECT * FROM entities WHERE type = $1 ORDER BY name', [type]);
      return result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type as EntityEntry['type'],
        canonicalName: r.canonical_name,
        createdAt: r.created_at,
      }));
    }
    const result = await this.db.query<{
      id: string;
      name: string;
      type: string;
      canonical_name: string;
      created_at: string;
    }>('SELECT * FROM entities ORDER BY name');
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as EntityEntry['type'],
      canonicalName: r.canonical_name,
      createdAt: r.created_at,
    }));
  }

  async linkFactEntity(factId: string, entityId: string): Promise<void> {
    await this.db.query(
      'INSERT INTO fact_entities (fact_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [factId, entityId]
    );
  }

  async getRelatedFacts(factId: string, limit = 5): Promise<FactEntry[]> {
    const result = await this.db.query<FactRow>(
      `SELECT DISTINCT f2.* FROM fact_entities fe1
       JOIN fact_entities fe2 ON fe1.entity_id = fe2.entity_id
       JOIN facts f2 ON fe2.fact_id = f2.id
       WHERE fe1.fact_id = $1
         AND fe2.fact_id != $1
         AND f2.valid_to IS NULL
         AND (f2.expires_at IS NULL OR f2.expires_at > NOW())
       LIMIT $2`,
      [factId, limit]
    );
    return result.rows.map((r) => this.mapFact(r));
  }

  async getEntityRelationships(entityId: string): Promise<EntityRelationship[]> {
    const result = await this.db.query<{
      id: string;
      source_entity_id: string;
      target_entity_id: string;
      relationship: string;
      valid_from: string;
      valid_to: string | null;
      source_fact_id: string | null;
      created_at: string;
    }>('SELECT * FROM entity_relationships WHERE source_entity_id = $1 OR target_entity_id = $1', [
      entityId,
    ]);
    return result.rows.map((r) => ({
      id: r.id,
      sourceEntityId: r.source_entity_id,
      targetEntityId: r.target_entity_id,
      relationship: r.relationship,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      sourceFactId: r.source_fact_id,
      createdAt: r.created_at,
    }));
  }

  async createEntityRelationship(
    sourceEntityId: string,
    targetEntityId: string,
    relationship: string,
    sourceFactId?: string
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, relationship, source_fact_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, sourceEntityId, targetEntityId, relationship, sourceFactId ?? null]
    );
    return id;
  }

  // --- Phase 5b: Timeline & Stats ---

  async getTimeline(from: Date, to: Date, entityFilter?: string): Promise<TimelineEntry[]> {
    const params: unknown[] = [from.toISOString(), to.toISOString()];

    let entityJoin = '';
    let entityWhere = '';
    if (entityFilter) {
      entityJoin =
        'JOIN fact_entities fe ON f.id = fe.fact_id JOIN entities e ON fe.entity_id = e.id';
      entityWhere = `AND e.canonical_name = $${params.length + 1}`;
      params.push(entityFilter.toLowerCase().trim());
    }

    const query = `
      SELECT 'fact_created' AS type, f.created_at AS timestamp, f.content, f.id AS fact_id, NULL AS entity_name
      FROM facts f ${entityJoin}
      WHERE f.created_at BETWEEN $1 AND $2 ${entityWhere}

      UNION ALL

      SELECT 'fact_invalidated' AS type, f.valid_to AS timestamp, f.content, f.id AS fact_id, NULL AS entity_name
      FROM facts f ${entityJoin}
      WHERE f.valid_to IS NOT NULL AND f.valid_to BETWEEN $1 AND $2 ${entityWhere}

      UNION ALL

      SELECT 'entity_created' AS type, e2.created_at AS timestamp, e2.name AS content, NULL AS fact_id, e2.name AS entity_name
      FROM entities e2
      WHERE e2.created_at BETWEEN $1 AND $2
      ${entityFilter ? `AND e2.canonical_name = $${params.length}` : ''}

      UNION ALL

      SELECT 'relationship_created' AS type, er.created_at AS timestamp,
             er.relationship AS content, er.source_fact_id AS fact_id, NULL AS entity_name
      FROM entity_relationships er
      ${entityFilter ? `JOIN entities esrc ON er.source_entity_id = esrc.id JOIN entities etgt ON er.target_entity_id = etgt.id` : ''}
      WHERE er.created_at BETWEEN $1 AND $2
      ${entityFilter ? `AND (esrc.canonical_name = $${params.length} OR etgt.canonical_name = $${params.length})` : ''}

      ORDER BY timestamp ASC
    `;

    const result = await this.db.query<{
      type: TimelineEntry['type'];
      timestamp: string;
      content: string;
      fact_id: string | null;
      entity_name: string | null;
    }>(query, params);

    return result.rows.map((r) => ({
      type: r.type,
      timestamp: r.timestamp,
      content: r.content,
      factId: r.fact_id ?? undefined,
      entityName: r.entity_name ?? undefined,
    }));
  }

  async getMemoryStats(): Promise<MemoryStats> {
    const [
      totalFacts,
      activeFacts,
      expiredFacts,
      categories,
      entities,
      relationships,
      dateRange,
      transcripts,
    ] = await Promise.all([
      this.db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM facts'),
      this.db.query<{ count: string }>(
        'SELECT COUNT(*)::TEXT as count FROM facts WHERE valid_to IS NULL'
      ),
      this.db.query<{ count: string }>(
        'SELECT COUNT(*)::TEXT as count FROM facts WHERE valid_to IS NOT NULL'
      ),
      this.db.query<{ category: string; count: string }>(
        'SELECT COALESCE(tag_path, category) as category, COUNT(*)::TEXT as count FROM facts WHERE valid_to IS NULL GROUP BY COALESCE(tag_path, category) ORDER BY count DESC LIMIT 10'
      ),
      this.db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM entities'),
      this.db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM entity_relationships'),
      this.db.query<{ oldest: string | null; newest: string | null }>(
        'SELECT MIN(created_at)::TEXT as oldest, MAX(created_at)::TEXT as newest FROM facts'
      ),
      this.db.query<{ count: string }>(
        'SELECT COUNT(*)::TEXT as count FROM transcripts WHERE embedding IS NOT NULL'
      ),
    ]);

    const topCategories: Record<string, number> = {};
    for (const row of categories.rows) {
      topCategories[row.category] = parseInt(row.count, 10);
    }

    return {
      totalFacts: parseInt(totalFacts.rows[0].count, 10),
      activeFacts: parseInt(activeFacts.rows[0].count, 10),
      expiredFacts: parseInt(expiredFacts.rows[0].count, 10),
      topCategories,
      totalEntities: parseInt(entities.rows[0].count, 10),
      totalRelationships: parseInt(relationships.rows[0].count, 10),
      oldestFact: dateRange.rows[0].oldest,
      newestFact: dateRange.rows[0].newest,
      totalTranscriptsIndexed: parseInt(transcripts.rows[0].count, 10),
      storageEstimate: `${totalFacts.rows[0].count} facts`,
    };
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // --- Private helpers ---

  private mapFact(r: FactRow): FactEntry {
    return {
      id: r.id,
      content: r.content,
      category: r.category as FactEntry['category'],
      tags: r.tags,
      sourceSessionId: r.source_session_id,
      confidence: r.confidence,
      accessCount: r.access_count,
      lastAccessedAt: r.last_accessed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
      validFrom: r.valid_from ?? undefined,
      validTo: r.valid_to ?? undefined,
      supersededBy: r.superseded_by ?? undefined,
      tagPath: r.tag_path ?? undefined,
    };
  }

  private mapSummary(r: {
    id: string;
    session_id: string;
    summary: string;
    topics: string[];
    key_decisions: string[];
    open_threads: string[];
    extraction_model: string;
    extraction_cost_usd: number | null;
    created_at: string;
  }): SessionSummaryEntry {
    return {
      id: r.id,
      sessionId: r.session_id,
      summary: r.summary,
      topics: r.topics,
      keyDecisions: r.key_decisions,
      openThreads: r.open_threads,
      extractionModel: r.extraction_model,
      extractionCostUsd: r.extraction_cost_usd,
      createdAt: r.created_at,
    };
  }
}
