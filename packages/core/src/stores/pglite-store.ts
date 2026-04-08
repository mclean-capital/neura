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
} from '@neura/types';

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

    // Seed default identity if table is empty
    const identityCount = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::TEXT as count FROM identity'
    );
    if (identityCount.rows[0].count === '0') {
      await this.seedIdentity();
    }
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
      'SELECT * FROM facts WHERE confidence >= $1 AND (expires_at IS NULL OR expires_at > NOW())';
    const params: (string | number)[] = [minConfidence];

    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }

    params.push(limit);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

    const result = await this.db.query<{
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
    }>(sql, params);

    return result.rows.map((r) => this.mapFact(r));
  }

  async searchFacts(query: string, embedding?: number[], limit = 10): Promise<FactEntry[]> {
    if (embedding?.length === 3072) {
      const vecStr = `[${embedding.join(',')}]`;
      const result = await this.db.query<{
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
      }>(
        `SELECT * FROM facts
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vecStr, limit]
      );
      return result.rows.map((r) => this.mapFact(r));
    }

    // Fallback: ILIKE text search
    const result = await this.db.query<{
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
    }>(
      `SELECT * FROM facts
       WHERE content ILIKE $1
         AND (expires_at IS NULL OR expires_at > NOW())
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
    embedding?: number[]
  ): Promise<string> {
    if (embedding && embedding.length !== 3072) {
      throw new Error(`Embedding must be 3072-dimensional, got ${embedding.length}`);
    }
    const id = crypto.randomUUID();
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
    // Use content+category as dedup key — if the same fact exists, update it
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO facts (id, content, category, tags, source_session_id, confidence, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
       ON CONFLICT (content, category) DO UPDATE
       SET tags = EXCLUDED.tags,
           source_session_id = EXCLUDED.source_session_id,
           confidence = GREATEST(facts.confidence, EXCLUDED.confidence),
           embedding = COALESCE(EXCLUDED.embedding, facts.embedding),
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
      ]
    );
    return result.rows[0].id;
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

  // --- Backup & recovery ---

  async exportMemories(): Promise<MemoryBackup> {
    const identity = await this.getIdentity();
    const userProfile = await this.getUserProfile();
    const facts = await this.getFacts({ limit: 10000 });
    const preferences = await this.getPreferences();
    const sessionSummaries = await this.getRecentSummaries(1000);

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      identity,
      userProfile,
      facts,
      preferences,
      sessionSummaries,
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

    // Facts — direct SQL to preserve accessCount, lastAccessedAt, expiresAt
    for (const entry of backup.facts ?? []) {
      try {
        await this.db.query(
          `INSERT INTO facts (id, content, category, tags, source_session_id, confidence, access_count, last_accessed_at, created_at, updated_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (content, category) DO UPDATE SET
             tags = EXCLUDED.tags,
             confidence = GREATEST(facts.confidence, EXCLUDED.confidence),
             access_count = GREATEST(facts.access_count, EXCLUDED.access_count),
             last_accessed_at = COALESCE(EXCLUDED.last_accessed_at, facts.last_accessed_at),
             expires_at = COALESCE(EXCLUDED.expires_at, facts.expires_at),
             updated_at = EXCLUDED.updated_at`,
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
          ]
        );
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

    log.info('import complete', { imported, skipped });
    return { imported, skipped };
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // --- Private helpers ---

  private mapFact(r: {
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
  }): FactEntry {
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
