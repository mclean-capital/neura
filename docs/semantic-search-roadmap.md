# Semantic Search Roadmap

## Why

The current conversation and memory system stores messages as plain text with JSONB metadata. Searching across conversation history requires exact keyword matches or manual SQL queries via the agent's `shell_execute` tool. This has clear limitations:

- **Keyword mismatch**: A user asking "What did we discuss about deployment?" won't match messages that talked about "shipping to production" or "CI/CD pipeline"
- **Semantic gap**: Related concepts stored in different conversations can't be surfaced without the user knowing exact terms
- **Memory recall**: The agent's long-term memories in the `memories` table would benefit from similarity-based retrieval rather than category filtering alone

## What

### pgvector extension

PostgreSQL's [pgvector](https://github.com/pgvector/pgvector) extension adds vector storage and similarity search directly in the database. No external vector DB needed — keeps the single-database architecture.

### Embedding model choice

Options ranked by practicality:

1. **OpenAI `text-embedding-3-small`** (1536 dimensions) — low cost, good quality, already have SDK integration
2. **OpenAI `text-embedding-3-large`** (3072 dimensions) — higher quality, higher cost
3. **Local model via Ollama** — zero API cost, requires additional infrastructure

Recommendation: Start with `text-embedding-3-small` for simplicity. The dimension count is configurable via `dimensions` parameter if we want to reduce storage.

### Schema changes

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding columns
ALTER TABLE messages ADD COLUMN embedding vector(1536);
ALTER TABLE memories ADD COLUMN embedding vector(1536);

-- HNSW indexes for approximate nearest neighbor search
CREATE INDEX idx_messages_embedding ON messages
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops);
```

## How

### Hybrid search approach

Combine JSONB metadata filtering with vector similarity ranking:

1. **Filter** — Narrow candidates using existing indexes (conversation_id, agent_id, category, date ranges)
2. **Rank** — Order filtered results by cosine similarity to the query embedding
3. **Threshold** — Only return results above a configurable similarity threshold (e.g., 0.7)

```sql
-- Example: Find relevant memories for a query
SELECT id, content, 1 - (embedding <=> $1) AS similarity
FROM memories
WHERE agent_id = $2
  AND category IN ('fact', 'preference')
  AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY embedding <=> $1
LIMIT 10;
```

### Embedding pipeline

1. **On message insert** — After persisting a message in `saveAssistantMessages` or `saveUserMessage`, compute embedding asynchronously and update the row
2. **On memory insert** — Same pattern for the `memories` table
3. **Batch backfill** — One-time script to embed existing rows

### Agent integration

Add a `semantic_search` tool that the agent can invoke:

```typescript
{
  name: "semantic_search",
  description: "Search conversation history and memories by meaning",
  parameters: {
    query: { type: "string", description: "Natural language search query" },
    scope: { type: "string", enum: ["messages", "memories", "all"] },
    limit: { type: "number", default: 10 },
  },
}
```

This complements the existing `shell_execute` tool — the agent can use SQL for precise queries and semantic search for fuzzy recall.

## Migration path

### Phase 1: Foundation (current)
- Conversation and message persistence across all endpoints
- Messages stored with full content in PostgreSQL
- Agent can query history via `shell_execute` + SQL

### Phase 2: Embeddings
- Install pgvector extension
- Add embedding columns and indexes
- Implement async embedding pipeline
- Backfill existing messages

### Phase 3: Agent tools
- Add `semantic_search` tool
- Integrate into system prompt with usage guidance
- Auto-retrieve relevant context before each agent turn (RAG)

### Phase 4: Advanced
- Conversation summarization for long threads
- Topic clustering across conversations
- Automatic memory extraction from conversations

## Dependencies

- **pgvector** PostgreSQL extension (available on most managed PostgreSQL providers)
- **Embedding API** — OpenAI API key (already required for the agent) or local model
- **No new infrastructure** — everything runs in the existing PostgreSQL instance

## Estimated effort

- Phase 2 (embeddings): Schema migration + embedding service + backfill script
- Phase 3 (agent tools): New tool definition + system prompt updates
- Phase 4 (advanced): Research + experimentation, scope TBD
