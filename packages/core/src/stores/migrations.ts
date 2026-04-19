import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import { Logger } from '@neura/utils/logger';

const log = new Logger('store');

export async function runMigrations(db: PGlite, embeddingDimensions = 3072): Promise<void> {
  // Pin the session timezone to UTC. Our schema mixes TIMESTAMP (without tz)
  // and TIMESTAMPTZ — the moment those get compared (e.g. `due_at <= NOW()`),
  // PG coerces using the session tz. Leaving the host tz applied drifts any
  // time-window query by the local offset, and the bug only shows up when
  // the machine isn't in UTC. Pinning the session kills the class of bug.
  await db.exec(`SET TIME ZONE 'UTC'`);
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');

  // --- _meta table for embedding dimension tracking ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

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
      embedding vector(${embeddingDimensions}),
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

  // Migrate embedding column from vector(768) → vector(${embeddingDimensions}) if needed
  const typeCheck = await db.query<{ col_type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS col_type FROM pg_attribute
     WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`
  );
  if (
    typeCheck.rows.length > 0 &&
    typeCheck.rows[0].col_type !== `vector(${embeddingDimensions})`
  ) {
    await db.exec('ALTER TABLE facts DROP COLUMN embedding');
    await db.exec(`ALTER TABLE facts ADD COLUMN embedding vector(${embeddingDimensions})`);
    log.info('migrated facts.embedding', {
      was: typeCheck.rows[0].col_type,
      now: `vector(${embeddingDimensions})`,
    });
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

  // work_items — the primary unit of work. Phase 6b expands the status enum
  // and adds columns for task-driven execution (see
  // docs/phase6b-task-driven-execution.md §Schema Changes).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
          'pending', 'awaiting_dispatch', 'in_progress',
          'awaiting_clarification', 'awaiting_approval', 'paused',
          'done', 'cancelled', 'failed'
        )),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high')),
      due_at TIMESTAMP,
      parent_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      source_session_id TEXT,
      -- Phase 6b columns (also added via ALTER for upgrades below)
      goal TEXT,
      context JSONB,
      related_skills JSONB NOT NULL DEFAULT '[]',
      repo_path TEXT,
      base_branch TEXT,
      worker_id TEXT,
      source TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'system_proactive', 'discovery_loop')),
      version INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_due ON work_items(due_at)');

  // Upgrade path: expand existing work_items.status CHECK constraint for
  // installs that predate Phase 6b.
  //
  // Condition is inverted from the naive "drop+readd when old constraint
  // detected" so that a crash between DROP and ADD self-heals on the next
  // boot: we fire the branch whenever the up-to-date constraint is absent,
  // which covers both (a) legacy installs with the old constraint AND (b)
  // crashed-mid-upgrade installs where the constraint was dropped but the
  // new one never landed. The `DROP CONSTRAINT IF EXISTS` makes the branch
  // idempotent in either case.
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'work_items_status_check'
          AND pg_get_constraintdef(oid) LIKE '%awaiting_clarification%'
      ) THEN
        ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_status_check;
        ALTER TABLE work_items ADD CONSTRAINT work_items_status_check
          CHECK (status IN (
            'pending', 'awaiting_dispatch', 'in_progress',
            'awaiting_clarification', 'awaiting_approval', 'paused',
            'done', 'cancelled', 'failed'
          ));
      END IF;
    END $$
  `);

  // Upgrade path: add Phase 6b columns idempotently for installs that
  // predate the refactor.
  await db.exec('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS goal TEXT');
  await db.exec('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS context JSONB');
  await db.exec(
    `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS related_skills JSONB NOT NULL DEFAULT '[]'`
  );
  await db.exec('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS repo_path TEXT');
  await db.exec('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS base_branch TEXT');
  await db.exec('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS worker_id TEXT');
  await db.exec(
    `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user'`
  );
  await db.exec(
    `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`
  );
  await db.exec('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP');

  // Upgrade path: ensure the `source` column CHECK constraint exists for
  // installs where the column was added before the constraint.
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'work_items_source_check'
      ) THEN
        ALTER TABLE work_items ADD CONSTRAINT work_items_source_check
          CHECK (source IN ('user', 'system_proactive', 'discovery_loop'));
      END IF;
    END $$
  `);

  await db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_worker ON work_items(worker_id)');
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_work_items_lease ON work_items(lease_expires_at) WHERE lease_expires_at IS NOT NULL'
  );

  // task_comments — Phase 6b. Every worker-to-orchestrator protocol event
  // lands here (progress, clarification, approval, result, etc.), plus
  // user/orchestrator/system-authored companion comments.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      type TEXT NOT NULL
        CHECK (type IN (
          'progress', 'heartbeat',
          'clarification_request', 'approval_request',
          'clarification_response', 'approval_response',
          'error', 'result', 'system', 'deferred'
        )),
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      attachment_path TEXT,
      urgency TEXT
        CHECK (urgency IS NULL OR urgency IN ('low', 'normal', 'high', 'critical')),
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_task_comments_type ON task_comments(type)');
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_task_comments_created ON task_comments(created_at)'
  );

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
  await db.exec(
    `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS embedding vector(${embeddingDimensions})`
  );

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
      embedding vector(${embeddingDimensions}),
      start_transcript_id INTEGER NOT NULL,
      end_transcript_id INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_transcript_chunks_session ON transcript_chunks(session_id)'
  );

  // --- Workers (Phase 6) ---
  //
  // One row per pi AgentSession dispatched as a worker. The session_file
  // column is load-bearing for restart-safe resume: SessionManager.open()
  // is path-addressed, not id-addressed, so persisting the JSONL path is
  // what lets the core come back from a crash and reopen idle_partial
  // workers. The session_id column is stored for cross-reference and log
  // correlation — NOT sufficient alone for reopen.
  //
  // Status enum is documented in the authoritative stopReason → WorkerStatus
  // mapping in docs/phase6-os-core.md. On startup, worker-queries.ts'
  // recovery sweep marks any spawning/running/blocked_clarifying rows as
  // crashed (terminal), and preserves idle_partial rows with a valid
  // session_file for resume.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      task_spec JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'spawning'
        CHECK (status IN (
          'spawning', 'running', 'blocked_clarifying', 'idle_partial',
          'completed', 'failed', 'crashed', 'cancelled'
        )),
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_progress_at TIMESTAMP NOT NULL DEFAULT NOW(),
      result_json JSONB,
      error_json JSONB,
      session_id TEXT,
      session_file TEXT
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)');
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_workers_last_progress ON workers(last_progress_at)'
  );

  // --- Skill usage (Phase 6) ---
  //
  // Lightweight MRU tracking for the skill registry's token-budget
  // eviction logic. skill-registry.ts maintains an in-memory MRU map for
  // the current session; this table mirrors usage to disk so the MRU
  // ordering survives core restarts. Updated via a callback wired from
  // skill-registry.notifyUsed() → worker-queries' skill usage helpers.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      skill_name TEXT PRIMARY KEY,
      last_used_at TIMESTAMP NOT NULL DEFAULT NOW(),
      use_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // --- Embedding dimension tracking ---
  // Store the current embedding dimensions in _meta so we can detect
  // dimension changes on future startups.
  const storedDims = await db.query<{ value: string }>(
    `SELECT value FROM _meta WHERE key = 'embedding_dimensions'`
  );
  if (storedDims.rows.length === 0) {
    // First run — record current dimensions
    await db.query(`INSERT INTO _meta (key, value) VALUES ('embedding_dimensions', $1)`, [
      String(embeddingDimensions),
    ]);
  } else if (storedDims.rows[0].value !== String(embeddingDimensions)) {
    // Dimension change detected — logged for now, re-embedding handled by
    // the EmbeddingMigration module (Phase 2 follow-up when the full
    // crash-safe state machine is wired up). For now, update the stored
    // dimension and let the new adapter produce correct-dimension vectors.
    // Old vectors with mismatched dimensions will be skipped in search
    // (the IS NOT NULL + dimension check filters them).
    log.warn('embedding dimensions changed', {
      was: storedDims.rows[0].value,
      now: embeddingDimensions,
    });
    await db.query(`UPDATE _meta SET value = $1 WHERE key = 'embedding_dimensions'`, [
      String(embeddingDimensions),
    ]);
    // Drop old embedding columns and recreate with new dimensions.
    // This invalidates existing embeddings — they'll be re-generated
    // on next extraction. Acceptable for Phase 2; the full crash-safe
    // temp-column re-embedding is Phase 2b.
    for (const table of ['facts', 'transcripts', 'transcript_chunks']) {
      await db.exec(`ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding`);
      await db.exec(`ALTER TABLE ${table} ADD COLUMN embedding vector(${embeddingDimensions})`);
    }
    log.info('embedding columns recreated with new dimensions', {
      dimensions: embeddingDimensions,
    });
  }

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
