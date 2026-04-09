# Phase 5b — Advanced Memory

## Motivation

The Phase 3 memory system is functional — it extracts facts, stores embeddings, and injects context into system prompts. But recall quality, temporal awareness, and organizational structure have known gaps that will compound as memory grows.

Analysis of [MemPalace](https://github.com/milla-jovovich/mempalace) (verbatim-first storage, temporal knowledge graph, hybrid retrieval, tiered loading) confirmed these gaps and identified proven solutions. This phase adopts the best architectural concepts without taking an external dependency — everything is implemented natively in TypeScript on PGlite+pgvector.

### What this phase is NOT

- **Not a rewrite.** The existing extraction pipeline, embedding model (Gemini Embedding 2, 3072-dim), PGlite+pgvector storage, and memory tools stay. This phase enhances recall, adds temporal tracking, and improves organization.
- **Not MemPalace integration.** No Python dependency, no ChromaDB, no external MCP server. We adopt concepts, not code.
- **Not verbatim-only storage.** AI extraction remains our primary path — it produces cleaner, typed entries from noisy voice transcripts. Verbatim transcripts become a supplementary deep search layer.

---

## Current State (Phase 3 baseline)

| Capability                    | Status  | Limitations                                           |
| ----------------------------- | ------- | ----------------------------------------------------- |
| Extraction pipeline           | Working | Gemini 2.5 Flash, structured JSON, ~$0.002/session    |
| Fact storage + embeddings     | Working | 3072-dim vectors, `(content, category)` uniqueness    |
| Vector recall (`searchFacts`) | Working | Pure cosine distance, ILIKE fallback, top-10 fixed    |
| Memory tools                  | Working | `remember_fact`, `recall_memory`, `update_preference` |
| System prompt injection       | Working | Token-budgeted (2000), priority-ordered               |
| Transcript storage            | Working | Raw transcripts stored but **not vector-indexed**     |
| Temporal tracking             | Missing | No `valid_from`/`valid_to`, no fact invalidation      |
| Entity relationships          | Missing | No knowledge graph, no cross-references               |
| Retrieval quality             | Basic   | No BM25, no reranking, no hybrid scoring              |
| Organization                  | Flat    | Single `category` field, no hierarchy                 |

---

## Sub-phase A — Recall Quality

**Goal:** Make `recall_memory` and system prompt fact selection significantly more accurate. This is the highest-ROI change because it improves every interaction without the user doing anything differently.

### A1. Hybrid Retrieval (BM25 + Cosine Fusion)

**Problem:** Pure cosine similarity misses keyword-exact matches. ILIKE fallback is too crude (substring only, no ranking). A query for "React deployment on Vercel" might miss a fact containing those exact words if the embedding neighborhood is dominated by semantically similar but different facts.

**Solution:** Combine BM25 keyword scoring with cosine similarity using Reciprocal Rank Fusion (RRF).

#### Implementation

**Enable PostgreSQL full-text search on facts:**

```sql
-- Add tsvector column to facts table
-- Note: tags is JSONB, so we extract text values for tsvector indexing
ALTER TABLE facts ADD COLUMN tsv tsvector;

CREATE INDEX idx_facts_tsv ON facts USING GIN (tsv);
```

> **PGlite note:** `GENERATED ALWAYS AS ... STORED` with `to_tsvector` may not work in PGlite's WASM build. Use application-level tsvector updates instead — update the `tsv` column in the `storeFact()` method on every insert/update:
>
> ```sql
> UPDATE facts SET tsv = to_tsvector('english',
>   content || ' ' || COALESCE(array_to_string(ARRAY(SELECT jsonb_array_elements_text(tags)), ' '), '')
> ) WHERE id = $1;
> ```
>
> If PGlite supports generated columns with tsvector, the application-level approach can be replaced with the generated column. Validate during implementation.

**Hybrid search query (RRF fusion):**

```sql
WITH vector_results AS (
  SELECT id, content, category, tags, confidence,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS vec_rank
  FROM facts
  WHERE confidence >= $3
    AND valid_to IS NULL
    AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY embedding <=> $1
  LIMIT $2
),
text_results AS (
  SELECT id, content, category, tags, confidence,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $4)) DESC) AS text_rank
  FROM facts
  WHERE tsv @@ plainto_tsquery('english', $4)
    AND confidence >= $3
    AND valid_to IS NULL
    AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $4)) DESC
  LIMIT $2
)
SELECT COALESCE(v.id, t.id) AS id,
       COALESCE(v.content, t.content) AS content,
       COALESCE(v.category, t.category) AS category,
       COALESCE(v.tags, t.tags) AS tags,
       COALESCE(v.confidence, t.confidence) AS confidence,
       (1.0 / (60 + COALESCE(v.vec_rank, 999))) +
       (1.0 / (60 + COALESCE(t.text_rank, 999))) AS rrf_score
FROM vector_results v
FULL OUTER JOIN text_results t ON v.id = t.id
ORDER BY rrf_score DESC
LIMIT $2;
```

**Files to modify:**

- `packages/core/src/stores/pglite-store.ts` — New `searchFactsHybrid()` method, migration to add `tsv` column + GIN index
- `packages/core/src/memory-manager.ts` — Update `recallMemory()` to use hybrid search
- `packages/types/src/providers.ts` — Add `searchFactsHybrid` to `DataStore` interface

**RRF constant (k=60):** Standard value from the original RRF paper (Cormack et al., 2009). Balances vector and text rankings. Tunable later.

### A2. LLM Reranking

**Problem:** Even hybrid retrieval returns candidates ranked by statistical similarity, not semantic relevance to the actual question. A reranker understands context.

**Solution:** After hybrid retrieval returns top-K candidates (K=20), use Gemini 2.5 Flash to rerank them by relevance to the query. Return top-N (N=10) to the caller.

#### Implementation

```typescript
// memory-manager.ts
async rerank(query: string, candidates: FactEntry[], topN: number = 10): Promise<FactEntry[]> {
  const prompt = `Given this query: "${query}"

Rank these memory entries by relevance (most relevant first).
Return ONLY an array of indices (0-based) in order of relevance.

Entries:
${candidates.map((f, i) => `[${i}] ${f.content} (${f.category})`).join('\n')}`;

  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });

  const indices: number[] = JSON.parse(response.text());
  const valid = indices.filter(i => i >= 0 && i < candidates.length);
  return valid.slice(0, topN).map(i => candidates[i]);
}
```

**Cost:** ~$0.001 per rerank call (small prompt, Flash model). Only triggered on explicit `recall_memory` tool calls, not on system prompt assembly (where token budget trimming is sufficient).

**Files to modify:**

- `packages/core/src/memory-manager.ts` — Add `rerank()` method, update `recallMemory()` to optionally rerank

### A3. Verbatim Transcript Indexing (Deep Search / L3)

**Problem:** The extraction pipeline decides what's important. Sometimes users need to recall exact words or context that extraction dropped — "what exactly did I say about the pricing model last Tuesday?"

**Solution:** Vector-index raw transcript entries. This becomes a "deep search" layer queried when fact search returns insufficient results, or when the user explicitly asks for verbatim recall.

#### Implementation

**Schema migration:**

```sql
ALTER TABLE transcripts ADD COLUMN embedding vector(3072);
CREATE INDEX idx_transcripts_embedding ON transcripts
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

> **Why HNSW over IVFFlat:** IVFFlat requires representative data at index creation time to build meaningful clusters — on a fresh install the table is empty. HNSW builds incrementally and works correctly from the first inserted row.

**Embedding generation:** Batch-embed transcript entries at extraction time (same pipeline, additional step). Group consecutive entries by speaker turn (2-4 entries per chunk) to maintain conversational context.

**Search method:**

```typescript
// pglite-store.ts
async searchTranscripts(
  embedding: number[],
  limit: number = 10,
  sessionId?: string
): Promise<TranscriptEntry[]> {
  const vecString = `[${embedding.join(',')}]`;
  const query = sessionId
    ? `SELECT * FROM transcripts WHERE session_id = $2 ORDER BY embedding <=> $1 LIMIT $3`
    : `SELECT * FROM transcripts ORDER BY embedding <=> $1 LIMIT $2`;
  // ...
}
```

**Integration with recall_memory:** If fact search returns < 3 results with high confidence, automatically fall back to transcript search and present results with a "[from transcript]" label.

**Files to modify:**

- `packages/core/src/stores/pglite-store.ts` — Migration, `searchTranscripts()` method
- `packages/core/src/memory-extractor.ts` — Batch-embed transcript chunks after extraction
- `packages/core/src/memory-manager.ts` — Fallback logic in `recallMemory()`
- `packages/types/src/providers.ts` — Add `searchTranscripts` to `DataStore` interface

**Cost impact:** Embedding transcripts costs more per session (~$0.005 additional for a typical 5-15 minute session). Longer sessions (30+ minutes, 200+ transcript entries) may cost ~$0.01-0.02 due to higher chunk count. Offset by dramatically better recall for verbatim queries.

### A4. Configurable Retrieval Pipeline

**Problem:** Different use cases need different retrieval strategies. Development/debugging wants fast vector-only. Production wants hybrid+rerank.

**Solution:** Configuration enum in core config.

```typescript
type RetrievalStrategy = 'vector-only' | 'hybrid' | 'hybrid-rerank';
```

Default: `'hybrid'` (best balance of quality and cost). `'hybrid-rerank'` for maximum recall quality at higher latency/cost.

**Files to modify:**

- `packages/types/src/config.ts` — Add `retrievalStrategy` to `CoreConfig`
- `packages/core/src/memory-manager.ts` — Strategy dispatch in `recallMemory()`

---

## Sub-phase B — Temporal & Relational

**Goal:** Facts exist in time and relate to entities. The system should know when things became true, when they stopped being true, and how entities connect.

### B1. Temporal Fact Tracking

**Problem:** "User works at Company A" and "User works at Company B" both exist as facts with no way to know which is current. The extraction pipeline is told to deduplicate, but conflicting facts about state changes aren't caught.

**Solution:** Add temporal validity windows to facts.

#### Implementation

**Schema migration:**

```sql
ALTER TABLE facts ADD COLUMN valid_from TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE facts ADD COLUMN valid_to TIMESTAMPTZ DEFAULT NULL; -- NULL = still valid
ALTER TABLE facts ADD COLUMN superseded_by TEXT REFERENCES facts(id);

CREATE INDEX idx_facts_valid ON facts (valid_to) WHERE valid_to IS NULL;
```

> **Note:** `facts.id` is `TEXT PRIMARY KEY` (UUID), so `superseded_by` must be `TEXT`, not `INTEGER`.

**Fact lifecycle:**

- **Insert:** `valid_from = NOW()`, `valid_to = NULL`
- **Supersede:** When extraction finds a conflicting fact (same entity + attribute), set `valid_to = NOW()` on the old fact, `superseded_by = new_fact_id`
- **Invalidate:** When a fact is explicitly negated, set `valid_to = NOW()` without a replacement
- **Query current state:** `WHERE valid_to IS NULL` (default for system prompt and recall)
- **Query history:** Include expired facts for timeline queries

> **Dependency note:** Meaningful supersession detection (identifying "same entity, different value" conflicts) requires entity resolution from B2. Without B2, supersession is limited to high cosine similarity + same category heuristics. If B1 ships before B2, implement the simpler heuristic first and upgrade to entity-aware supersession when B2 lands.

**Files to modify:**

- `packages/core/src/stores/pglite-store.ts` — Migration, update `storeFact()` with supersession logic, add `invalidateFact()`, `getFactHistory()`
- `packages/core/src/memory-extractor.ts` — Detect superseding facts during extraction
- `packages/types/src/memory.ts` — Add `validFrom`, `validTo`, `supersededBy` to `FactEntry`

### B2. Entity-Relationship Edges

**Problem:** Facts are isolated. "Alice is the CTO" and "The CTO approved the architecture" have no explicit link. The AI can't answer "what did Alice approve?" without semantic search luck.

**Solution:** A lightweight entity-relationship table that links entities mentioned across facts.

#### Implementation

**Schema:**

```sql
CREATE TABLE entities (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'person', 'project', 'tool', 'company', 'concept'
  canonical_name TEXT NOT NULL, -- normalized form for dedup
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(canonical_name, type)
);

CREATE TABLE entity_relationships (
  id SERIAL PRIMARY KEY,
  source_entity_id INTEGER REFERENCES entities(id),
  target_entity_id INTEGER REFERENCES entities(id),
  relationship TEXT NOT NULL, -- 'works_at', 'owns', 'uses', 'relates_to'
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  source_fact_id INTEGER REFERENCES facts(id), -- provenance
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_entities (
  fact_id INTEGER REFERENCES facts(id),
  entity_id INTEGER REFERENCES entities(id),
  PRIMARY KEY (fact_id, entity_id)
);

CREATE INDEX idx_entity_rels_source ON entity_relationships(source_entity_id);
CREATE INDEX idx_entity_rels_target ON entity_relationships(target_entity_id);
CREATE INDEX idx_fact_entities_entity ON fact_entities(entity_id);
```

**Entity extraction:** Hybrid approach — primarily via the existing Gemini 2.5 Flash extraction call (add an `entities` field to the structured extraction schema), supplemented by known-entity matching against the existing entities table. Using the LLM is preferred over pure regex because voice transcripts lack reliable capitalization and punctuation, making regex-based proper noun detection fragile.

```typescript
// Added to extraction schema
entities: [
  {
    name: string, // "Alice Chen"
    type: string, // "person" | "project" | "tool" | "company" | "concept"
    relationships: [
      {
        target: string, // "Neura"
        relationship: string, // "works_on"
      },
    ],
  },
];
```

Cost impact is negligible — entity fields are added to the existing extraction prompt, not a separate LLM call.

**Files to modify:**

- `packages/core/src/stores/pglite-store.ts` — Migration, entity CRUD, relationship queries
- `packages/core/src/memory-extractor.ts` — Add `entities` field to extraction schema, store extracted entities + relationships
- `packages/types/src/memory.ts` — `Entity`, `EntityRelationship`, `FactEntity` types
- `packages/types/src/providers.ts` — Entity methods on `DataStore`

### B3. Timeline Queries

**Problem:** "What changed this week?" or "When did we decide on Postgres?" requires scanning all facts by date, which isn't currently supported.

**Solution:** A `getTimeline()` method that returns facts and entity changes within a date range, ordered chronologically.

```typescript
async getTimeline(
  from: Date,
  to: Date,
  entityFilter?: string
): Promise<TimelineEntry[]> {
  // Query facts created/invalidated in range
  // Query entity relationships created/invalidated in range
  // Merge and sort chronologically
}
```

**New memory tool:** `get_timeline` — voice-callable. "What's changed since Monday?" → returns chronological summary.

**Files to modify:**

- `packages/core/src/stores/pglite-store.ts` — `getTimeline()` query
- `packages/core/src/tools.ts` — `get_timeline` tool definition
- `packages/core/src/memory-manager.ts` — Timeline formatting for voice response
- `packages/types/src/tools.ts` — `GetTimelineArgs` type

### B4. Fact Invalidation Tool

**Problem:** The AI can store facts but can't mark them as no longer true. If a user says "I left Company A", the old fact persists until extraction happens to overwrite it.

**Solution:** An `invalidate_fact` memory tool that sets `valid_to = NOW()` on a fact by ID or content match.

**Files to modify:**

- `packages/core/src/tools.ts` — `invalidate_fact` tool definition, add to `MEMORY_TOOL_NAMES` set and `getToolDefs` filter
- `packages/core/src/memory-manager.ts` — `invalidateFact()` method
- `packages/core/src/stores/pglite-store.ts` — `invalidateFact()` store method

> **Tool registration note:** All new tools (`get_timeline`, `invalidate_fact`, `memory_stats`) must be added to the `MEMORY_TOOL_NAMES` set and the conditional `getToolDefs` filter logic in `tools.ts` so they are included when `includeMemory: true`.

---

## Sub-phase C — Organization & Tiers

**Goal:** As memory grows past 100+ facts, flat organization breaks down. Formalize memory into tiers with explicit budgets, and add hierarchical structure.

### C1. Formalized Memory Tiers

**Problem:** The current system loads identity + profile + preferences + 20 facts + 3 summaries with a global 2000-token budget. This is implicit tiering. As memory grows, the 20-fact limit becomes a bottleneck and priority trimming is blunt.

**Solution:** Explicit 4-tier memory stack with per-tier budgets.

| Tier | Name              | What's Loaded                                                | Token Budget | Loading Strategy                                           |
| ---- | ----------------- | ------------------------------------------------------------ | ------------ | ---------------------------------------------------------- |
| L0   | Identity          | Base personality, behavioral rules                           | ~200         | Always loaded, every session                               |
| L1   | Essential Context | User profile, top preferences (strength > 1.5), pinned facts | ~400         | Always loaded, every session                               |
| L2   | Session Context   | Recent facts by relevance, recent summaries, active entities | ~800         | Loaded on session start, refreshed on topic change         |
| L3   | Deep Search       | Verbatim transcript search, historical facts, expired facts  | Unlimited    | On-demand only (via `recall_memory` or automatic fallback) |

**Wake-up cost:** ~700 tokens (L0 + L1 + static tool instructions) for lightweight sessions. Full context: ~1500 tokens (L0-L2 + tool instructions). L3 is never pre-loaded.

> **Token budget note:** Static tool instructions (vision tool hints, ~100 tokens) are currently injected alongside identity in the prompt builder. These must be accounted for in the L0 budget or moved to a fixed pre-tier allocation. The estimates above include this overhead.

**Implementation:**

```typescript
// memory-manager.ts
interface MemoryTierConfig {
  l0Budget: number; // default: 200
  l1Budget: number; // default: 400
  l2Budget: number; // default: 800
}

async buildSystemPrompt(tierConfig?: MemoryTierConfig): Promise<string> {
  const l0 = await this.buildL0(); // identity
  const l1 = await this.buildL1(); // profile + top preferences + pinned facts
  const l2 = await this.buildL2(); // recent facts + summaries + entities
  return this.assembleTiers(l0, l1, l2, tierConfig);
}
```

**Files to modify:**

- `packages/core/src/memory-manager.ts` — Tier-aware prompt assembly
- `packages/core/src/memory-prompt-builder.ts` — Refactor into tier builders
- `packages/types/src/config.ts` — `MemoryTierConfig` in `CoreConfig`

### C2. Hierarchical Tags

**Problem:** Flat `category` field (`project`, `technical`, `business`, `personal`, `general`) doesn't scale. Two project facts about different projects are in the same bucket.

**Solution:** Replace flat `category` with a hierarchical `path` using dot notation.

```
project.neura.architecture
project.neura.memory
project.clientX.api
technical.typescript
personal.preferences.communication
```

**Schema migration:**

```sql
ALTER TABLE facts ADD COLUMN tag_path TEXT; -- dot-separated hierarchy
CREATE INDEX idx_facts_tag_path ON facts USING btree (tag_path);

-- Migrate existing data
UPDATE facts SET tag_path = category WHERE tag_path IS NULL;
```

**Query by prefix:** `WHERE tag_path LIKE 'project.neura.%'` retrieves all Neura project facts.

**Extraction update:** The extraction prompt gets updated to produce `tag_path` instead of flat `category`. Backward-compatible — `category` column stays, `tag_path` is additive.

**Files to modify:**

- `packages/core/src/stores/pglite-store.ts` — Migration, update queries to use `tag_path`
- `packages/core/src/memory-extractor.ts` — Update extraction schema to produce `tag_path`
- `packages/types/src/memory.ts` — Add `tagPath` to `FactEntry`

### C3. Cross-Reference Detection

**Problem:** Facts about the same entity in different categories are isolated. A person fact and a project fact mentioning the same person have no link.

**Solution:** Use the entity-relationship table from Sub-phase B to automatically link facts that share entities. The `fact_entities` junction table enables queries like "all facts mentioning Alice" across categories.

**Integration with recall:** When `recall_memory` returns a fact mentioning entity X, also surface related facts via `fact_entities` join.

```sql
-- Find related facts through shared entities
SELECT DISTINCT f2.*
FROM fact_entities fe1
JOIN fact_entities fe2 ON fe1.entity_id = fe2.entity_id
JOIN facts f2 ON fe2.fact_id = f2.id
WHERE fe1.fact_id = $1
  AND fe2.fact_id != $1
  AND f2.valid_to IS NULL
LIMIT 5;
```

**Files to modify:**

- `packages/core/src/memory-manager.ts` — Related facts expansion in `recallMemory()`
- `packages/core/src/stores/pglite-store.ts` — `getRelatedFacts()` query

### C4. Memory Statistics Tool

**Problem:** No way to understand the state of memory — how many facts, how stale, what categories. Useful for debugging and user transparency.

**Solution:** A `memory_stats` tool callable via voice.

```typescript
{
  name: 'memory_stats',
  description: 'Get statistics about stored memories',
  handler: async () => ({
    totalFacts: 142,
    activeFacts: 128,
    expiredFacts: 14,
    topCategories: { 'project.neura': 45, 'technical': 32, 'personal': 18 },
    totalEntities: 23,
    totalRelationships: 67,
    oldestFact: '2026-01-15',
    newestFact: '2026-04-08',
    totalTranscriptsIndexed: 1847,
    storageEstimate: '12.4 MB'
  })
}
```

**Files to modify:**

- `packages/core/src/tools.ts` — `memory_stats` tool definition
- `packages/core/src/stores/pglite-store.ts` — `getMemoryStats()` aggregate query
- `packages/types/src/tools.ts` — `MemoryStatsResult` type

---

## Execution Order & Dependencies

```
Sub-phase A (Recall Quality)           Sub-phase B (Temporal & Relational)
┌──────────────────────────┐           ┌──────────────────────────┐
│ A1. Hybrid retrieval     │           │ B1. Temporal tracking    │
│ A2. LLM reranking       │           │ B2. Entity relationships │
│ A3. Transcript indexing  │           │ B3. Timeline queries     │──→ depends on B1+B2
│ A4. Config pipeline      │──→ A1+A2 │ B4. Invalidation tool    │──→ depends on B1
└──────────────────────────┘           └──────────────────────────┘
           │                                      │
           └──────────────┬───────────────────────┘
                          ▼
              Sub-phase C (Organization & Tiers)
              ┌──────────────────────────┐
              │ C1. Memory tiers         │
              │ C2. Hierarchical tags    │
              │ C3. Cross-references     │──→ depends on B2
              │ C4. Memory stats tool    │
              └──────────────────────────┘
```

**Sub-phases A and B can run in parallel.** Sub-phase C depends on B2 (entity tables) for cross-references.

Within each sub-phase, items are ordered by dependency and should be done sequentially.

---

## Migration Strategy

All schema changes are additive (new columns, new tables). No destructive migrations. Existing data stays intact.

**Migration approach:**

1. Each sub-phase adds its migrations to the PGlite store's `initSchema()` method
2. Use `IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for idempotency
3. Existing `category` field stays alongside new `tag_path` — backfilled during migration
4. Backup service automatically captures new tables/columns

**Backup backward compatibility:** The `MemoryBackup` interface in `@neura/types` must handle old backups that lack new fields (`validFrom`, `validTo`, `supersededBy`, `tagPath`). The `importMemories()` method should apply sensible defaults for missing fields: `validFrom = createdAt`, `validTo = null`, `tagPath = category`. Old backups must import cleanly without data loss.

**DataStore interface:** Adding `searchFactsHybrid`, `searchTranscripts`, `invalidateFact`, `getTimeline`, `getRelatedFacts`, `getMemoryStats`, and entity CRUD methods significantly expands the `DataStore` interface. If a second implementation is created (e.g., native Postgres for cloud deployment), it must implement all new methods. Consider making advanced methods optional (return empty results if unimplemented) to allow incremental adoption.

**Rollback:** Drop new columns/tables. Existing data untouched.

---

## Success Criteria

### Sub-phase A

- [ ] `recall_memory` returns relevant results for keyword-exact queries that cosine-only misses
- [ ] Reranking demonstrably reorders candidates (log before/after ranking)
- [ ] Transcript search returns verbatim quotes from past sessions
- [ ] Retrieval strategy is configurable via core config

### Sub-phase B

- [ ] Facts have `valid_from`/`valid_to` populated
- [ ] Conflicting facts are auto-superseded during extraction
- [ ] `invalidate_fact` tool works via voice
- [ ] `get_timeline` returns chronological fact/entity changes for a date range
- [ ] Entities and relationships are extracted and stored

### Sub-phase C

- [ ] System prompt assembly uses explicit tier budgets
- [ ] Wake-up cost is measurably lower (~700 tokens vs ~2000)
- [ ] Facts use hierarchical `tag_path`
- [ ] `recall_memory` surfaces related facts via shared entities
- [ ] `memory_stats` tool returns accurate aggregate statistics

---

## Cost Impact

| Operation                          | Current                  | After Phase 5b                                              |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------- |
| Extraction (per session, 5-15 min) | ~$0.002                  | ~$0.007 (+ transcript embeddings + entity extraction)       |
| Extraction (per session, 30+ min)  | ~$0.003                  | ~$0.015 (more transcript chunks to embed)                   |
| Recall (per query)                 | ~$0.001 (embedding only) | ~$0.002 (embedding + optional rerank)                       |
| System prompt wake-up              | ~2000 tokens             | ~700 tokens (L0+L1+tool instructions), ~1500 tokens (L0-L2) |
| Storage growth                     | ~50 bytes/fact           | ~80 bytes/fact (+ temporal cols) + entity tables            |

**Net:** Slightly higher per-session cost (~$0.005-0.012 more depending on session length) but significantly better recall quality and lower per-session token usage. The token savings in system prompts offset the extraction cost increase over many interactions.

---

## Test Plan

Each sub-phase should include tests for:

**Sub-phase A:**

- `pglite-store.test.ts` — `searchFactsHybrid()` returns results matching both vector and text queries
- `memory-manager.test.ts` — `rerank()` reorders candidates, fallback to transcript search triggers correctly
- Integration test: end-to-end recall with hybrid+rerank pipeline

**Sub-phase B:**

- `pglite-store.test.ts` — Temporal columns populated, `invalidateFact()` sets `valid_to`, supersession logic
- `memory-extractor.test.ts` — Entity extraction from sample transcripts
- `tools.test.ts` — `get_timeline` and `invalidate_fact` tool handlers

**Sub-phase C:**

- `memory-prompt-builder.test.ts` — Tier budget enforcement, L0+L1 fits within 600 tokens
- `pglite-store.test.ts` — Hierarchical tag queries, `getRelatedFacts()`, `getMemoryStats()`
- `tools.test.ts` — `memory_stats` tool handler returns correct aggregates
