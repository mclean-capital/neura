# Neura Project Roadmap

## Current State (v1.0)

Neura is a self-configuring AI assistant that stores its own configuration, instructions, and memories in PostgreSQL. The agent can read and modify its own behavior at runtime.

### What's built

- **Core agent framework** — `src/agent/core.ts` with `streamText`/`generateText`, multi-provider support (Anthropic, OpenAI, Google), database-driven config via `agents` + `agent_instructions` tables
- **Four protocols in a single process:**
  - `POST /chat` — REST chat endpoint with streaming (AI SDK `streamText`)
  - `GET /v1/models` · `POST /v1/chat/completions` — OpenAI-compatible API for Open WebUI and other clients
  - `POST /a2a` — A2A JSON-RPC agent-to-agent protocol (`src/a2a/handler.ts`)
  - `POST|GET|DELETE /mcp` — MCP HTTP streamable transport with session management (`src/mcp/transport.ts`)
- **Conversation persistence** — full message history stored in PostgreSQL (`conversations` + `messages` tables), conversation ID resolution across all endpoints
- **Single agent tool** — `shell_execute` (`src/agent/tools/shell.ts`) for running psql queries and system commands, with dangerous-command blocking
- **Database-driven identity** — agent config, personality, and priority-ordered instructions loaded from PostgreSQL at runtime, with hardcoded fallback defaults
- **Self-configuration protocol** — the agent can modify its own instructions, memories, and config by writing SQL through `shell_execute`
- **Open WebUI integration** — conversation ID deduplication via `X-OpenWebUI-Chat-Id` header
- **Testing & CI** — 77+ Vitest tests across 8 files, GitHub Actions CI workflow
- **Health endpoint** — `GET /health` with database connectivity check

### Database schema

Eight tables: `agents`, `agent_instructions`, `users`, `memories`, `conversations`, `messages`, `tools`, `config` — plus the `agent_tools` join table. The `tools` and `agent_tools` tables exist in the schema but are not yet used by the tool-loading code.

---

## Phase 1: Agent Tool Expansion

**Goal:** Give the agent more capabilities beyond raw shell commands. New tools follow the existing pattern in `src/agent/tools/shell.ts` and are registered in `src/agent/tools/index.ts`.

### 1.1 Web Fetch

Add a tool that lets the agent retrieve web pages and call external APIs.

- **File:** `src/agent/tools/web-fetch.ts`
- **Scope:** HTTP GET/POST with configurable timeout, response size limits, content-type handling (HTML-to-text, JSON passthrough)
- **Why:** The agent currently cannot access any information outside its database and the local filesystem

### 1.2 Memory Management

Structured CRUD tool for the `memories` table, replacing the current approach of writing raw SQL via `shell_execute`.

- **File:** `src/agent/tools/memory.ts`
- **Operations:** `create`, `list`, `search` (by category/keyword), `update`, `delete`
- **Why:** Reduces prompt overhead (no SQL generation), enforces schema constraints, makes memory operations more reliable

### 1.3 Database Query

Read-only SQL execution via the `pg` pool directly, bypassing the `psql` subprocess.

- **File:** `src/agent/tools/db-query.ts`
- **Scope:** SELECT queries only (reject writes), parameterized to prevent injection, row/size limits
- **Why:** Faster than spawning `psql`, removes the runtime dependency on `psql` being on PATH for read operations

### 1.4 Dynamic Tool Loading

Refactor `getTools()` to load tool registrations from the `agent_tools` + `tools` tables at runtime, enabling database-driven tool configuration.

- **File:** `src/agent/tools/registry.ts` (new), updates to `src/agent/tools/index.ts`
- **Scope:** Map tool rows to built-in implementations, support enabling/disabling tools per agent via database
- **Why:** The `tools` and `agent_tools` tables already exist in the schema but are unused — this completes the database-first configuration story

---

## Phase 2: Observability & Tracing

**Goal:** Understand what the agent is doing, how long it takes, and how much it costs.

### 2.1 AI SDK Telemetry

Enable the `experimental_telemetry` option on `streamText` and `generateText` calls in `src/agent/core.ts`.

- **Scope:** Configure telemetry metadata (agent slug, conversation ID, model ID), integrate with OpenTelemetry if a collector is configured
- **Why:** AI SDK has built-in telemetry support that just needs to be turned on

### 2.2 Request Tracing

Add Express middleware that assigns a trace ID to every incoming request and correlates it through Pino logs.

- **File:** `src/server/middleware/tracing.ts`
- **Scope:** Generate or accept `X-Trace-Id` header, attach to Pino child logger, include in all response headers
- **Why:** Correlating logs across a multi-step agent execution is currently impossible

### 2.3 Agent Step Logging

Add an `onStepFinish` callback to `streamText`/`generateText` in `src/agent/core.ts` that logs each tool call, token usage, and timing.

- **Scope:** Tool name, input/output size, duration, cumulative token count per request
- **Why:** Understanding multi-step agent behavior requires per-step visibility, not just final results

### 2.4 Health Endpoint Expansion

Extend `src/server/routes/health.ts` with runtime metrics.

- **Scope:** Process uptime, request count (total + per-endpoint), average latency, active connections, last agent execution time
- **Why:** Basic operational visibility without requiring a full metrics stack

---

## Phase 3: Semantic Search & RAG

**Goal:** Enable meaning-based search across conversation history and memories. See [`docs/semantic-search-roadmap.md`](./semantic-search-roadmap.md) for the detailed technical spec.

### 3.1 pgvector Foundation

Install the pgvector extension and add embedding columns to `messages` and `memories` tables.

- **Schema:** `vector(1536)` columns, HNSW indexes with `vector_cosine_ops`
- **Migration:** `src/db/migrations/` — new migration adding the extension, columns, and indexes
- **Reference:** [`semantic-search-roadmap.md` § Schema changes](./semantic-search-roadmap.md#schema-changes)

### 3.2 Embedding Pipeline

Compute embeddings asynchronously after message and memory inserts.

- **File:** `src/agent/embeddings.ts`
- **Scope:** Async post-insert hook, batch backfill script for existing rows, configurable embedding model (default: OpenAI `text-embedding-3-small`)
- **Reference:** [`semantic-search-roadmap.md` § Embedding pipeline](./semantic-search-roadmap.md#embedding-pipeline)

### 3.3 Semantic Search Tool

Add a `semantic_search` tool the agent can invoke to find relevant messages and memories by meaning.

- **File:** `src/agent/tools/semantic-search.ts`
- **Scope:** Natural language query → embedding → cosine similarity search, with scope filtering (messages, memories, or both), configurable similarity threshold
- **Reference:** [`semantic-search-roadmap.md` § Agent integration](./semantic-search-roadmap.md#agent-integration)

### 3.4 Auto Context Retrieval (RAG)

Automatically inject relevant context from conversation history and memories into the system prompt before each agent turn.

- **Scope:** Query top-k similar messages/memories for the current user input, prepend as context section in `buildSystemPrompt()`
- **Why:** The agent shouldn't need to explicitly invoke a tool to recall relevant information — the most relevant context should be pre-loaded

---

## Phase 4: Agent Polish & UX

**Goal:** Make the agent smarter about managing its own context and more accessible to users.

### 4.1 Conversation Summarization

Automatically summarize long conversations to keep context windows manageable.

- **Scope:** Trigger after N messages or M tokens, store summary in `conversations.metadata`, use summary as context for continued conversations
- **Reference:** [`semantic-search-roadmap.md` § Phase 4: Advanced](./semantic-search-roadmap.md#phase-4-advanced)

### 4.2 Automatic Memory Extraction

Extract facts, preferences, and tasks from conversations without explicit user instruction.

- **Scope:** Post-conversation analysis pass, deduplicate against existing memories, assign appropriate category and importance
- **Why:** The agent currently only stores memories when explicitly told to via SQL — it should learn passively

### 4.3 Conversation History API

REST endpoints for browsing and managing past conversations.

- **File:** `src/server/routes/conversations.ts`
- **Endpoints:** `GET /conversations` (list with pagination), `GET /conversations/:id` (full message history), `DELETE /conversations/:id`
- **Why:** No way to browse conversation history outside of direct SQL queries

### 4.4 User Identification

Basic user resolution from request headers, enabling per-user memories and conversation ownership.

- **Scope:** Middleware that resolves user from `X-User-Id` or `X-OpenWebUI-User-*` headers, creates user rows on first contact, attaches to request context
- **Why:** The `users` table exists but is never populated — memories and conversations lack user attribution

---

## Phase 5: Future / Exploration

Uncommitted ideas for longer-term exploration. No specific timeline or ordering.

- **Scheduled tasks** — cron-like execution for the agent (daily summaries, periodic memory consolidation)
- **Multi-agent orchestration** — multiple agents with different specializations coordinating via A2A
- **MCP client integration** — Neura as an MCP client, consuming tools from external MCP servers
- **Voice & multimodal** — audio input/output, image understanding
- **Plugin system** — user-installable tool packages beyond the built-in set
- **Knowledge graph** — entity extraction and relationship mapping across conversations
- **Docker deployment** — single `docker-compose.yml` with Neura + PostgreSQL + Open WebUI
- **Admin UI** — web interface for managing agents, instructions, memories, and tools

---

## Guiding Principles

- **Single-developer scope** — every feature must be buildable and maintainable by one person. Prefer simple, boring solutions over clever ones.
- **Follow existing patterns** — new tools follow `src/agent/tools/shell.ts`, new routes follow `src/server/routes/chat.ts`, new tests follow the `vi.mock()` strategy described in CLAUDE.md.
- **Database-first config** — if a setting could live in the database, it should. Environment variables are for infrastructure (connection strings, API keys), not application behavior.
- **Graceful degradation** — the agent works without pgvector, without embeddings, without optional tools. Features degrade; the agent doesn't crash.
- **Test-driven** — new features ship with tests. The test count only goes up.

---

## Phase Summary

| Phase | Focus           | Key Outcome                                                   | Primary Files                                                   |
| ----- | --------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 1     | Agent Tools     | Agent can fetch web pages, manage memories, query DB directly | `src/agent/tools/`                                              |
| 2     | Observability   | Per-request tracing, per-step logging, runtime metrics        | `src/agent/core.ts`, `src/server/middleware/`                   |
| 3     | Semantic Search | Meaning-based search across all stored content                | `src/agent/embeddings.ts`, `src/agent/tools/semantic-search.ts` |
| 4     | Agent Polish    | Smarter context management, conversation APIs, user tracking  | `src/server/routes/`, `src/agent/`                              |
| 5     | Future          | Scheduling, multi-agent, voice, plugins                       | TBD                                                             |
