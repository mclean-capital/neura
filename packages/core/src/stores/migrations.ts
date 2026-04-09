import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import { Logger } from '@neura/utils/logger';

const log = new Logger('store');

export async function runMigrations(db: PGlite): Promise<void> {
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');

  // --- Session & transcript tables (Phase 2) ---

  await db.exec(`
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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await db.exec('CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id)');

  // --- Memory tables (Phase 3) ---

  await db.exec(`
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

  await db.exec(`
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

  await db.exec(`
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
  const typeCheck = await db.query<{ col_type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS col_type FROM pg_attribute
     WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`
  );
  if (typeCheck.rows.length > 0 && typeCheck.rows[0].col_type !== 'vector(3072)') {
    await db.exec('ALTER TABLE facts DROP COLUMN embedding');
    await db.exec('ALTER TABLE facts ADD COLUMN embedding vector(3072)');
    log.info('migrated facts.embedding to vector(3072)', { was: typeCheck.rows[0].col_type });
  }

  // Ensure unique index exists (may be missing on tables created before constraint was added)
  await db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_content_category ON facts(content, category)'
  );

  await db.exec('CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at DESC)');

  await db.exec(`
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
  await db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_preferences_pref_category ON preferences(preference, category)'
  );

  await db.exec(`
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

  await db.exec(`
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

  await db.exec('CREATE INDEX IF NOT EXISTS idx_extractions_status ON memory_extractions(status)');

  await db.exec(`
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
  await db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_due ON work_items(due_at)');

  // --- Phase 5b: Advanced Memory ---

  // Temporal tracking columns on facts
  await db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_from TIMESTAMP DEFAULT NOW()');
  await db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_to TIMESTAMP');
  await db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS superseded_by TEXT');
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts (valid_to) WHERE valid_to IS NULL'
  );

  // Hierarchical tag path
  await db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS tag_path TEXT');
  // Backfill tag_path from category for existing facts
  await db.exec(
    'UPDATE facts SET tag_path = category WHERE tag_path IS NULL AND category IS NOT NULL'
  );

  // Full-text search (application-managed tsvector)
  await db.exec('ALTER TABLE facts ADD COLUMN IF NOT EXISTS tsv tsvector');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_facts_tsv ON facts USING GIN (tsv)');
  // Backfill tsvector for existing facts
  await db.exec(`
    UPDATE facts SET tsv = to_tsvector('english',
      content || ' ' || COALESCE((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(tags)), '')
    ) WHERE tsv IS NULL
  `);

  // Transcript embeddings
  await db.exec('ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS embedding vector(3072)');

  // Entity tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(canonical_name, type)
    )
  `);

  await db.exec(`
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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS fact_entities (
      fact_id TEXT NOT NULL REFERENCES facts(id),
      entity_id TEXT NOT NULL REFERENCES entities(id),
      PRIMARY KEY (fact_id, entity_id)
    )
  `);

  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_entity_rels_source ON entity_relationships(source_entity_id)'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_entity_rels_target ON entity_relationships(target_entity_id)'
  );
  await db.exec('CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_facts_tag_path ON facts(tag_path)');

  // Transcript chunks table (replaces per-row midpoint embedding)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      chunk_text TEXT NOT NULL,
      embedding vector(3072),
      start_transcript_id INTEGER NOT NULL,
      end_transcript_id INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_transcript_chunks_session ON transcript_chunks(session_id)'
  );

  // Seed default identity if table is empty
  const identityCount = await db.query<{ count: string }>(
    'SELECT COUNT(*)::TEXT as count FROM identity'
  );
  if (identityCount.rows[0].count === '0') {
    await seedIdentity(db);
  }
}

export async function seedIdentity(db: PGlite): Promise<void> {
  const defaults = [
    ['base_personality', 'You are Neura, a helpful voice assistant with camera and screen vision.'],
    ['tone', 'direct and conversational'],
    ['verbosity', 'concise — 1-2 sentences unless asked for detail'],
    ['filler_words', 'avoid — no filler, no hedging'],
  ];
  for (const [attribute, value] of defaults) {
    await db.query('INSERT INTO identity (id, attribute, value, source) VALUES ($1, $2, $3, $4)', [
      crypto.randomUUID(),
      attribute,
      value,
      'default',
    ]);
  }
}
