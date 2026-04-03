# Phase 3 — Memory & Identity

## Design Philosophy

Four principles govern the memory system:

**Voice-first.** Users never touch config files. All memory is learned through conversation. The AI extracts, organizes, and manages its own memory automatically. Think Jarvis, not dotfiles.

**DB-first.** All memory lives in the DataStore — PGlite (embedded WASM Postgres) for local, Postgres for cloud. No markdown files, no filesystem scatter.

**Automatic.** The AI manages its own memory. It extracts facts from transcripts, learns preferences from corrections, and builds user profiles from conversation — all without explicit user action.

**Portable.** PGlite runs real PostgreSQL 17. The same SQL, same schema, same queries work in cloud Postgres. Migration is `pg_dump` / `pg_restore`. Zero query translation.

---

## Database Migration: sql.js → PGlite

Phase 2 uses sql.js (WASM SQLite). Phase 3 migrates to PGlite (WASM PostgreSQL 17) for:

- **pgvector** — Native vector similarity search for memory recall
- **Automatic persistence** — WAL-based, crash-safe. Eliminates manual save/export/atomic-rename
- **One SQL dialect** — Same queries run locally (PGlite) and in cloud (Postgres)
- **Richer SQL** — JSONB, window functions, CTEs, `tsvector` full-text search
- **Streamlined cloud migration** — Same SQL dialect. Moving local → cloud requires data export/import (via `pg_dump` / CLI) plus connection config change, but zero query translation

### PGlite specifics

```typescript
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

// File-backed with pgvector
const db = await PGlite.create('./data/neura', { extensions: { vector } });
await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');

// Parameterized queries (Postgres-style $1, $2)
await db.query('INSERT INTO facts (content, embedding) VALUES ($1, $2)', [text, vecString]);

// Cosine similarity search
const results = await db.query('SELECT content FROM facts ORDER BY embedding <=> $1 LIMIT 10', [
  queryEmbedding,
]);

// Automatic WAL persistence — no manual save needed
await db.close();
```

- Bundle size: ~3.7 MB gzipped (vs ~1.2 MB for sql.js)
- Persistence: automatic WAL (data directory at the specified path)
- API: fully async (natural for Node.js)
- Extensions: pgvector ships built-in (46 KB)

---

## Database Schema

Existing tables (`sessions`, `transcripts`) migrate to Postgres syntax. Six new tables for the memory system.

### Existing tables (migrated from SQLite)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP,
  duration_ms INTEGER,
  cost_usd REAL,
  voice_provider TEXT NOT NULL,
  vision_provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
```

### New tables

```sql
-- Identity: who Neura is. Behavioral rules learned from user feedback.
-- Small table, rarely changes. Entire table loaded every session.
CREATE TABLE IF NOT EXISTS identity (
  id TEXT PRIMARY KEY,
  attribute TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'default',  -- 'default' | 'user_feedback'
  source_session_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- User profile: who the user is. Continuously enriched from conversation.
CREATE TABLE IF NOT EXISTS user_profile (
  id TEXT PRIMARY KEY,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  source_session_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(field, value)
);

-- Facts: durable knowledge extracted from sessions. Vector-searchable.
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags JSONB NOT NULL DEFAULT '[]',
  embedding vector(768),                    -- Gemini embedding dimension
  source_session_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at DESC);

-- Preferences: behavioral corrections and confirmations. High weight.
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  preference TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  strength REAL NOT NULL DEFAULT 1.0,
  source_session_id TEXT,
  reinforcement_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Session summaries: auto-generated end-of-session summaries.
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
);

-- Memory extraction log: tracks what has been extracted to avoid re-processing.
CREATE TABLE IF NOT EXISTS memory_extractions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  memories_created INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON memory_extractions(status);
```

### Default identity seed

On first migration (empty `identity` table), seed these defaults:

```sql
INSERT INTO identity (id, attribute, value, source) VALUES
  (gen_random_uuid(), 'base_personality', 'You are Neura, a helpful voice assistant with camera and screen vision.', 'default'),
  (gen_random_uuid(), 'tone', 'direct and conversational', 'default'),
  (gen_random_uuid(), 'verbosity', 'concise — 1-2 sentences unless asked for detail', 'default'),
  (gen_random_uuid(), 'filler_words', 'avoid — no filler, no hedging', 'default');
```

---

## TypeScript Interfaces

New file: `packages/types/src/memory.ts`

```typescript
/** Memory type discriminator */
export type MemoryType = 'identity' | 'user_profile' | 'fact' | 'preference' | 'session_summary';

/** Identity attribute — who Neura is */
export interface IdentityEntry {
  id: string;
  attribute: string;
  value: string;
  source: 'default' | 'user_feedback';
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** User profile field — who the user is */
export interface UserProfileEntry {
  id: string;
  field: string;
  value: string;
  confidence: number;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Extracted fact — durable knowledge with optional vector embedding */
export interface FactEntry {
  id: string;
  content: string;
  category: 'project' | 'technical' | 'business' | 'personal' | 'general';
  tags: string[];
  sourceSessionId: string | null;
  confidence: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

/** Behavioral preference — corrections and confirmations */
export interface PreferenceEntry {
  id: string;
  preference: string;
  category: 'response_style' | 'workflow' | 'communication' | 'technical' | 'general';
  strength: number;
  sourceSessionId: string | null;
  reinforcementCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Auto-generated session summary */
export interface SessionSummaryEntry {
  id: string;
  sessionId: string;
  summary: string;
  topics: string[];
  keyDecisions: string[];
  openThreads: string[];
  extractionModel: string;
  extractionCostUsd: number | null;
  createdAt: string;
}

/** Extraction job status */
export interface MemoryExtractionRecord {
  id: string;
  sessionId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  memoriesCreated: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Composite memory context assembled for system prompt injection */
export interface MemoryContext {
  identity: IdentityEntry[];
  userProfile: UserProfileEntry[];
  recentFacts: FactEntry[];
  preferences: PreferenceEntry[];
  recentSummaries: SessionSummaryEntry[];
  tokenEstimate: number;
}

/** Output from the extraction pipeline */
export interface ExtractionResult {
  facts: Array<{ content: string; category: string; tags: string[] }>;
  preferences: Array<{ preference: string; category: string }>;
  userProfile: Array<{ field: string; value: string }>;
  identityUpdates: Array<{ attribute: string; value: string }>;
  sessionSummary: {
    summary: string;
    topics: string[];
    keyDecisions: string[];
    openThreads: string[];
  };
}
```

---

## DataStore Interface Extensions

The existing `DataStore` interface gains memory methods. The interface remains implementation-agnostic — the same contract works for PGlite (local) and Postgres (cloud).

```typescript
// Added to DataStore in packages/types/src/providers.ts

// Identity
getIdentity(): Promise<IdentityEntry[]>;
upsertIdentity(attribute: string, value: string, source: 'default' | 'user_feedback', sourceSessionId?: string): Promise<void>;

// User profile
getUserProfile(): Promise<UserProfileEntry[]>;
upsertUserProfile(field: string, value: string, confidence: number, sourceSessionId?: string): Promise<void>;

// Facts
getFacts(options?: { category?: string; limit?: number; minConfidence?: number }): Promise<FactEntry[]>;
searchFacts(query: string, embedding?: number[], limit?: number): Promise<FactEntry[]>;
upsertFact(content: string, category: string, tags: string[], sourceSessionId?: string, confidence?: number, embedding?: number[]): Promise<string>;
touchFact(id: string): Promise<void>;
deleteFact(id: string): Promise<void>;

// Preferences
getPreferences(options?: { category?: string; minStrength?: number }): Promise<PreferenceEntry[]>;
upsertPreference(preference: string, category: string, sourceSessionId?: string): Promise<void>;
reinforcePreference(id: string): Promise<void>;

// Session summaries
getSessionSummary(sessionId: string): Promise<SessionSummaryEntry | null>;
getRecentSummaries(limit?: number): Promise<SessionSummaryEntry[]>;
createSessionSummary(sessionId: string, summary: SessionSummaryEntry): Promise<void>;

// Extraction tracking
createExtraction(sessionId: string): Promise<string>;
updateExtraction(id: string, status: string, memoriesCreated?: number, error?: string): Promise<void>;
getPendingExtractions(): Promise<MemoryExtractionRecord[]>;

// Composite context for system prompt injection
getMemoryContext(options?: { maxTokens?: number }): Promise<MemoryContext>;
```

Note: all methods become `Promise`-based (PGlite is async). The existing session/transcript methods also migrate from sync to async.

---

## Conversation Boundary

Clients are disposable — a page reload, network hiccup, or device switch should not fragment memory. Extraction must not be tied to raw WebSocket disconnect.

### Conversation vs. transport

A **conversation** is the logical unit of interaction. A **connection** is a WebSocket transport that may drop and reconnect. One conversation can span multiple connections (reconnects, device switches). Extraction triggers on conversation end, not connection end.

### How a conversation ends

A conversation ends when any of these occur:

1. **Idle timeout** — No voice activity (no `audio` or `text` messages) for a configurable duration (default: 5 minutes). The server tracks a per-session idle timer, reset on every inbound message.
2. **Explicit close** — The client sends a `sessionEnd` message (future protocol addition) or the user clicks "End Session" in the UI.
3. **Server shutdown** — Graceful SIGTERM triggers extraction for all active conversations before exit.

WebSocket disconnect alone does **not** end a conversation. If the client reconnects within the idle timeout window, the same session continues (transcript seeding already handles this for the voice provider).

### Session state machine

```
ACTIVE ──── audio/text ──── ACTIVE (reset idle timer)
  │
  ├── idle timeout ──── FINALIZING ──── extraction ──── ENDED
  ├── explicit close ── FINALIZING ──── extraction ──── ENDED
  ├── server shutdown ─ FINALIZING ──── extraction ──── ENDED
  └── ws disconnect ─── IDLE (waiting for reconnect or timeout)
```

---

## Architecture: Memory Manager

A service layer at `packages/core/src/memory-manager.ts` that orchestrates injection, extraction, and recall.

```
packages/core/src/
  memory-manager.ts          — MemoryManager (injection, extraction, recall)
  memory-extractor.ts        — ExtractionPipeline (LLM-based transcript → memories)
  memory-prompt-builder.ts   — System prompt construction from memory context
```

### MemoryManager API

```typescript
export interface MemoryManager {
  /** Build system prompt fragment from memory. Called at session start. */
  buildSystemPrompt(): Promise<string>;

  /** Queue extraction for a completed conversation. Non-blocking. */
  queueExtraction(sessionId: string): void;

  /** Search memories by query + optional embedding. Used by recall_memory tool. */
  recall(query: string, limit?: number): Promise<FactEntry[]>;

  /** Store a fact from a tool call. */
  storeFact(content: string, category: string, tags: string[], sessionId?: string): Promise<string>;

  /** Store a preference from a tool call. */
  storePreference(preference: string, category: string, sessionId?: string): Promise<void>;

  /** Shut down: flush pending extractions. */
  close(): Promise<void>;
}
```

### Lifecycle

```
Server start
  └─ createMemoryManager({ store, embeddingApiKey })

Client connects
  └─ memoryManager.buildSystemPrompt()
       └─ store.getMemoryContext({ maxTokens: 2000 })
       └─ Returns formatted string for voice provider instructions

During session
  └─ Tool calls: remember_fact → memoryManager.storeFact()
  └─ Tool calls: recall_memory → memoryManager.recall()
  └─ Tool calls: update_preference → memoryManager.storePreference()
  └─ Every inbound message resets the idle timer

Conversation ends (idle timeout, explicit close, or shutdown)
  └─ memoryManager.queueExtraction(sessionId)
       └─ store.getTranscript(sessionId)
       └─ extractionPipeline.extract(transcript)
       └─ Generate embeddings for extracted facts (Gemini Embedding)
       └─ store.upsert{Fact,Preference,UserProfile,Identity}(...)
       └─ store.createSessionSummary(sessionId, summary)
```

---

## System Prompt Construction

The system prompt is assembled from memory with a token budget. Sections are prioritized — lower priority sections are trimmed first if the budget is exceeded.

| Priority    | Section            | Typical tokens | Notes                                                    |
| ----------- | ------------------ | -------------- | -------------------------------------------------------- |
| 1 (highest) | Identity           | ~100-200       | Always included. Rarely grows.                           |
| 2           | Preferences        | ~100-400       | Always included. Behavioral corrections are high-signal. |
| 3           | User profile       | ~50-200        | Always included. Small, high-value.                      |
| 4           | Tool instructions  | ~200           | Always included. Camera/screen instructions.             |
| 5           | Recent facts       | ~200-800       | Trimmed first. Highest confidence, most recent.          |
| 6           | Session continuity | ~200-400       | Last 1-3 session summaries.                              |
| 7           | Transcript context | ~200-800       | Reconnect seeding (existing behavior).                   |

Token estimation: `Math.ceil(text.length / 4)` (4 chars per token average).

### Integration with grok-voice.ts

`GrokVoiceConfig` gains a `systemPromptPrefix?: string` field. When provided, `buildInstructions()` uses it as the base instead of the hardcoded personality strings, then appends transcript context for reconnects.

---

## Extraction Pipeline

Converts raw transcripts into structured memories. Runs asynchronously after session end using Gemini 2.5 Flash (cheap, fast).

### Flow

```
Conversation ends (idle timeout / explicit close / shutdown)
  └─ queueExtraction(sessionId)
       └─ store.createExtraction(sessionId) — status: 'pending'
       └─ store.getTranscript(sessionId)
       └─ Skip if < 4 entries (too little signal)
       └─ store.getMemoryContext() — for deduplication
       └─ LLM call: transcript + existing context → ExtractionResult
       └─ Generate embeddings for each extracted fact (Gemini Embedding API)
       └─ store.upsert{...}(extracted data with embeddings)
       └─ store.createSessionSummary(...)
       └─ store.updateExtraction(id, 'completed', memoriesCreated)
```

### Extraction prompt

```
System: You are a memory extraction agent. Analyze the conversation transcript
and extract structured information. Return JSON only.

Extract:
1. facts — Durable knowledge (would be true tomorrow). Include category and tags.
2. preferences — Behavioral instructions from user feedback.
3. userProfile — Who the user is (name, role, company, expertise).
4. identityUpdates — Changes to how the AI should behave.
5. sessionSummary — 2-4 sentence summary, topics, decisions, open threads.

Rules:
- Only durable facts. Not "it's raining" but "user lives in Seattle."
- Deduplicate against existing context provided below.
- Empty arrays for categories with no extractions.

Existing context (for dedup): {existingContext}
Transcript: {transcript}
```

### Cost

| Session length | Transcript tokens | Extraction cost | Notes                        |
| -------------- | ----------------- | --------------- | ---------------------------- |
| 5 min          | ~500-1000         | ~$0.001         | Negligible                   |
| 15 min         | ~2000-4000        | ~$0.002         | < 0.3% of session voice cost |
| 30 min         | ~4000-8000        | ~$0.004         | Truncated if needed          |

### Embedding generation

At extraction time, each new fact gets a 768-dimensional embedding via **Gemini Embedding** (same API key as vision). Stored in the `embedding vector(768)` column. Cost: negligible ($0.01 per 1M tokens).

---

## Memory Tools

Three new tools added to `packages/core/src/tools.ts`.

### remember_fact

```
Store an important fact for long-term memory. Use when the user tells you
something you should remember, or when you learn something important.
```

Parameters: `content` (required), `category`, `tags`

### recall_memory

```
Search long-term memory for relevant facts. Use when the user asks
"do you remember...", references a previous session, or when you need
stored context.
```

Parameters: `query` (required)

Internally calls `memoryManager.recall(query)` which:

1. Generates an embedding for the query (Gemini Embedding)
2. Runs `store.searchFacts(query, embedding, limit)` — pgvector cosine search
3. Returns ranked results

### update_preference

```
Record a user preference about behavior. Use when the user gives feedback
like "be more concise", "always explain your reasoning", etc.
```

Parameters: `preference` (required), `category`

---

## Offline Operation

The memory system works fully offline for all operations except extraction and embedding:

| Operation                | Offline? | Notes                                             |
| ------------------------ | -------- | ------------------------------------------------- |
| Injection (load context) | Yes      | Reads from local PGlite                           |
| Recall (keyword search)  | Yes      | Falls back to `LIKE` if no embedding              |
| Recall (vector search)   | No       | Requires Gemini Embedding API for query embedding |
| Store (via tools)        | Yes      | Writes to local PGlite                            |
| Extraction               | No       | Requires Gemini 2.5 Flash API                     |

If offline, extraction is deferred — the transcript is preserved in the DB and extraction runs on next startup when connectivity is available.

---

## Future Considerations

### Memory decay

Facts that are never accessed gradually lose relevance:

- Reduce `confidence` by 0.05 for facts not accessed in 30 days
- Facts below 0.2 confidence excluded from `getMemoryContext`
- Access-based ranking: `confidence * 0.6 + recency * 0.3 + access_frequency * 0.1`

### Multi-user support (cloud)

Add `user_id TEXT NOT NULL` to all memory tables. Identity remains global (Neura's personality is shared) with per-user overrides.

### Proactive memory (Phase 4 — Discovery Loop)

Facts with `expires_at` trigger proactive reminders:

- "You mentioned a deadline for project X on Friday. It's Thursday — want me to check?"

### Memory tools evolution

- `forget_fact` — user asks Neura to forget something
- `list_memories` — "what do you know about me?"
- `correct_memory` — "actually, that's wrong"
- `memory_status` — diagnostic: fact count, last extraction, storage size

---

## Migration: Existing neura.db Installs

Users running Phase 2 have a SQLite `neura.db` with session and transcript data. Migration path:

1. On first startup after the Phase 3 upgrade, core detects whether `DB_PATH` points to a SQLite file (by checking the file header magic bytes: `SQLite format 3`).
2. If SQLite is detected, core reads all `sessions` and `transcripts` rows using sql.js (kept as an optional dependency for migration only).
3. Core inserts the data into the new PGlite database.
4. The old `neura.db` is renamed to `neura.db.migrated` (preserved, not deleted).
5. Subsequent startups skip migration (PGlite data directory already exists).

This is a one-time, automatic, non-destructive migration. No user action required.

---

## Packaging & Distribution

PGlite is WASM — no native compilation, no ABI issues (unlike the better-sqlite3 problems in Phase 2). Validation required across all distribution paths:

### Distribution matrix

| Path                         | Store location                   | PGlite loading                                        | Validation                                       |
| ---------------------------- | -------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| `npm run dev -w @neura/core` | `~/.neura/pgdata/`               | Direct import from `node_modules`                     | Dev server starts, data persists across restarts |
| `neura start` (CLI service)  | `~/.neura/pgdata/`               | Bundled in core binary or resolved from install path  | Service starts, `neura status` shows healthy     |
| Desktop (Electron)           | `userData/pgdata/`               | Resolved from `extraResources` or `app.asar.unpacked` | Packaged app starts, sessions persist            |
| Docker                       | `/data/pgdata/` (mounted volume) | Bundled in image                                      | Container starts, volume persists data           |

### esbuild considerations

PGlite uses a WASM binary (`pglite.wasm`) that must be available at runtime. Options:

1. **Externalize PGlite from esbuild** (like we did with sql.js stores) — copy the package to `extraResources`. Simplest, most reliable.
2. **Bundle inline** — esbuild can handle WASM with the right loader config, but PGlite's dynamic WASM loading may need special handling.

Recommended: Option 1 (externalize), same pattern as the current `./stores/index.js` externalization. The stores module and PGlite package are copied to `extraResources/core/` alongside the bundle.

### Desktop electron-builder.yml changes

```yaml
extraResources:
  # Stores module (dynamically imported)
  - from: ../core/dist/stores
    to: core/stores
    filter:
      - '**/*.js'
      - '**/*.js.map'
  # PGlite (WASM Postgres) — needed by stores at runtime
  - from: ../../node_modules/@electric-sql/pglite
    to: core/node_modules/@electric-sql/pglite
    filter:
      - 'package.json'
      - 'dist/**/*'
```

---

## Implementation Sequence

### Step 1: DataStore async migration

Make the existing `DataStore` interface fully async (all methods return `Promise`). Update `SqliteStore`, `server.ts`, and all call sites to use `await`. This is a cross-package refactor (types, core, tests) but changes zero behavior — pure mechanical migration.

### Step 2: PGlite backend swap

Replace `sql.js` with `@electric-sql/pglite`. Create `PgliteStore` implementing the async `DataStore` interface. Migrate `sessions` and `transcripts` tables to Postgres syntax. Add auto-migration from existing `neura.db`. Update esbuild externals, electron-builder extraResources, and packaging. Validate across all distribution paths.

### Step 3: Memory types

Create `packages/types/src/memory.ts` with all memory interfaces. Export from index. Extend `DataStore` interface with memory methods.

### Step 4: Memory schema + store methods

Add the 6 new memory tables to `PgliteStore` migration. Implement all memory `DataStore` methods. Add tests.

### Step 5: Memory prompt builder

Create `packages/core/src/memory-prompt-builder.ts`. Implement `buildMemoryPrompt()` with token budget management. Add tests.

### Step 6: Memory manager + conversation boundary

Create `packages/core/src/memory-manager.ts`. Implement idle timeout conversation boundary. Wire `buildSystemPrompt()`, `storeFact()`, `recall()`, `storePreference()`, `queueExtraction()`. Add tests.

### Step 7: Extraction pipeline

Create `packages/core/src/memory-extractor.ts`. Implement Gemini 2.5 Flash extraction + Gemini Embedding generation. Add tests.

### Step 8: Voice integration

Add `systemPromptPrefix` to `GrokVoiceConfig`. Modify `buildInstructions()`. Wire memory manager into `server.ts` session lifecycle with conversation boundary.

### Step 9: Memory tools

Add `remember_fact`, `recall_memory`, `update_preference` to tools. Wire `memoryManager` through `handleToolCall`. Add tests.

### Step 10: Docs + roadmap

Update CLAUDE.md, roadmap, and README to reflect the memory system. Remove all references to markdown-based memory (SOUL.md, MEMORY.md, USER.md).

---

## File Manifest

### New files

```
packages/types/src/memory.ts                 — Memory type definitions
packages/core/src/stores/pglite-store.ts     — PGlite DataStore implementation
packages/core/src/stores/migrate-sqlite.ts   — One-time SQLite → PGlite data migration
packages/core/src/memory-manager.ts          — MemoryManager service layer
packages/core/src/memory-extractor.ts        — Extraction pipeline (Gemini Flash + Embedding)
packages/core/src/memory-prompt-builder.ts   — System prompt construction from memory
```

### Modified files

```
packages/types/src/providers.ts              — DataStore methods → async, add memory methods
packages/types/src/config.ts                 — Add extraction config fields
packages/types/src/index.ts                  — Export memory types
packages/core/package.json                   — Replace sql.js with @electric-sql/pglite (keep sql.js as optional for migration)
packages/core/src/stores/index.ts            — Export PgliteStore instead of SqliteStore
packages/core/src/config.ts                  — Load extraction config, PGlite data path
packages/core/src/server.ts                  — Async store calls, memory manager lifecycle, conversation idle timeout
packages/core/src/voice-session.ts           — Pass systemPromptPrefix through
packages/core/src/providers/grok-voice.ts    — Accept systemPromptPrefix, modify buildInstructions()
packages/core/src/tools.ts                   — Add memory tools
packages/core/scripts/bundle.ts              — Update externals for PGlite
packages/desktop/electron-builder.yml        — Update extraResources for PGlite
docs/roadmap.md                              — Phase 3 updated to DB-first approach
```

### Removed files

```
packages/core/src/stores/sqlite-store.ts     — Replaced by pglite-store.ts
packages/core/src/stores/sqlite-store.test.ts — Replaced by pglite-store.test.ts
```
