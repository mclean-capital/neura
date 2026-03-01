# Neura

A database-driven, self-configuring AI assistant with multi-provider LLM support, A2A protocol integration, and MCP server capabilities.

Neura stores its own configuration, instructions, and memories in PostgreSQL — and can modify them at runtime through tool calls. It exposes a streaming chat API, an [A2A](https://google.github.io/A2A/) JSON-RPC endpoint for agent-to-agent communication, and an [MCP](https://modelcontextprotocol.io/) server for integration with tools like Claude Desktop.

## Architecture

```
Client
  │
  ├─ POST /chat ──────────► Agent Core ──► AI SDK v6 ──► LLM (Anthropic/OpenAI/Google)
  │                              │                            │
  │                              ├─ System Prompt Builder     ├─ Tool Calls
  │                              │   (loads from DB)          │   └─ shell_execute
  │                              │                            │       └─ psql, files, etc.
  │                              └─ Tool Registry             │
  │                                                           ▼
  ├─ /v1/chat/completions ► OpenAI Adapter ► Agent Core  LLM Response
  │   /v1/models                                          (streamed or full)
  │
  ├─ POST /a2a ───────────► A2A Handler ──► Agent Core
  │
  ├─ POST /mcp ───────────► MCP Transport ──► MCP Server
  │
  └─ GET /health ─────────► DB Health Check
```

### Key design decisions

- **Node 24+** with native ESM — no transpiler needed at runtime
- **Express 5** for modern async middleware and error handling
- **AI SDK v6** for a unified interface across LLM providers
- **Database-driven config** — agents, instructions, and memories live in PostgreSQL so the agent can read and modify its own behavior
- **Multi-protocol** — REST chat, A2A JSON-RPC, and MCP all served from one process

## Quick start

### Prerequisites

- Node.js >= 24.0.0
- PostgreSQL 17+ with `psql` on PATH (the agent calls `psql` at runtime via `shell_execute`)
- At least one LLM API key (Anthropic, OpenAI, or Google)

#### Installing PostgreSQL

- **macOS**: `brew install postgresql@17` (includes the `psql` client)
- **Windows**: `winget install PostgreSQL.PostgreSQL` or use the [installer](https://www.postgresql.org/download/windows/)
- **Docker** (alternative): `docker run -d --name postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:17` — you'll still need `psql` on the host for the agent's runtime queries

### Setup

```bash
git clone <repo-url> && cd neura
npm install
cp .env.example .env   # edit with your values
```

### Database

```bash
npm run db:create   # create the database (safe to re-run)
npm run db:init     # apply schema + seed data
```

### Run

```bash
npm run dev      # development with auto-reload
npm run build    # compile TypeScript
npm start        # production
```

Startup output:

```
Neura server running on port 3000
Health:  http://localhost:3000/health
Chat:    http://localhost:3000/chat
A2A:     http://localhost:3000/.well-known/agent-card.json
MCP:     http://localhost:3000/mcp
OpenAI:  http://localhost:3000/v1/chat/completions
```

## Environment variables

| Variable                       | Required | Default       | Description                                                  |
| ------------------------------ | -------- | ------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                 | Yes      | —             | PostgreSQL connection string                                 |
| `PORT`                         | No       | `3000`        | Server port                                                  |
| `LOG_LEVEL`                    | No       | `info`        | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `NODE_ENV`                     | No       | `development` | `development` \| `production` \| `test`                      |
| `ANTHROPIC_API_KEY`            | No       | —             | Claude API key                                               |
| `OPENAI_API_KEY`               | No       | —             | OpenAI API key                                               |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No       | —             | Google Gemini API key                                        |
| `API_KEY`                      | No       | —             | Protects `/v1/*` OpenAI-compatible endpoints                 |

At least one LLM API key is needed. The default agent uses Anthropic.

## API

### `GET /health`

Returns service health and database connectivity status.

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "services": { "database": "connected" }
}
```

Returns `503` with `"status": "degraded"` if the database is unreachable.

### `POST /chat`

Send a message to the agent. Streams by default.

```bash
# Streaming (default)
curl -N -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What can you do?"}'

# Non-streaming
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What can you do?", "stream": false}'
```

| Field     | Type    | Default | Description                                |
| --------- | ------- | ------- | ------------------------------------------ |
| `message` | string  | —       | Required. The user message                 |
| `stream`  | boolean | `true`  | Stream the response via SSE or return JSON |

Non-streaming response:

```json
{ "response": "I can help you with..." }
```

### `GET /.well-known/agent-card.json`

A2A agent discovery. Returns the agent card describing capabilities and skills.

### `POST /a2a`

A2A JSON-RPC endpoint. Implements `tasks/send` for executing tasks.

```bash
curl -X POST http://localhost:3000/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tasks/send",
    "params": {
      "messages": [{ "role": "user", "parts": [{ "type": "text", "text": "Hello" }] }]
    },
    "id": 1
  }'
```

### `POST /mcp` · `GET /mcp` · `DELETE /mcp`

MCP HTTP streamable transport. Exposes a `shell_execute` tool for database queries and system commands. Compatible with Claude Desktop and other MCP clients.

Sessions are managed via the `mcp-session-id` header.

### `GET /v1/models`

Lists available agents as OpenAI-compatible model entries.

```bash
curl http://localhost:3000/v1/models
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint. Works with Open WebUI and other OpenAI-compatible clients.

```bash
# Non-streaming (default)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"neura","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"neura","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

When `API_KEY` is set, include `Authorization: Bearer <key>` in requests to `/v1/*` endpoints.

#### Open WebUI configuration

Connect via Settings → Connections → OpenAI API:
- **URL**: `http://<host>:3000/v1`
- **API Key**: value of `API_KEY` env var (or any string if auth is disabled)

## Database schema

Initialized with `npm run db:init`. Key tables:

| Table                | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `agents`             | Agent profiles — model, temperature, personality, max tokens   |
| `agent_instructions` | Priority-ordered instruction modules per agent                 |
| `users`              | User profiles with JSONB preferences                           |
| `memories`           | Cross-conversation memory (facts, preferences, context, tasks) |
| `conversations`      | Conversation sessions                                          |
| `messages`           | Message history (user, assistant, system, tool roles)          |
| `tools`              | Tool registry with JSON Schema definitions                     |
| `agent_tools`        | Agent-to-tool assignments                                      |
| `config`             | Key-value configuration store                                  |

The seed data creates a default "neura" agent with three instruction modules (`memory-management`, `self-awareness`, `conversation-tracking`) and registers the `shell_execute` tool.

## Agent system

### Self-configuration

Neura's system prompt is assembled at runtime from the database:

1. A core prompt defining identity and database access patterns
2. Agent personality from the `agents` table
3. Instructions from `agent_instructions`, ordered by priority

The agent accesses its own database through the `shell_execute` tool via `psql "$DATABASE_URL"`, so it can update its own instructions, store memories, and modify its configuration. This requires `psql` to be on the host's PATH.

### Supported models

Configure via the `model_id` column in the `agents` table:

| Provider  | Format              | Example                              |
| --------- | ------------------- | ------------------------------------ |
| Anthropic | `anthropic/<model>` | `anthropic/claude-sonnet-4-20250514` |
| OpenAI    | `openai/<model>`    | `openai/gpt-4o`                      |
| Google    | `google/<model>`    | `google/gemini-2.0-flash`            |

### Tools

| Tool            | Description                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `shell_execute` | Run shell commands with safety guards (blocked patterns for destructive ops, 30s timeout, 50KB output cap) |

## Project structure

```
src/
├── index.ts                 # Entry point — DB check, server start
├── env.ts                   # Zod-validated environment config
├── lib/
│   └── logger.ts            # Pino logger (pretty in dev, JSON in prod)
├── server/
│   ├── app.ts               # Express app factory
│   └── routes/
│       ├── health.ts        # GET /health
│       ├── chat.ts          # POST /chat
│       └── openai.ts        # /v1/models, /v1/chat/completions
├── agent/
│   ├── core.ts              # streamText / generateText with multi-provider support
│   ├── system-prompt.ts     # DB-driven prompt assembly
│   └── tools/
│       ├── index.ts         # Tool registry
│       └── shell.ts         # Shell execution with safety guards
├── db/
│   ├── connection.ts        # pg pool + typed query helper
│   ├── schema.sql           # Full schema (9 tables + indexes)
│   └── seed.sql             # Default agent, instructions, user, tool
├── a2a/
│   ├── agent-card.ts        # Agent discovery card
│   ├── handler.ts           # JSON-RPC router (tasks/send, get, cancel)
│   └── executor.ts          # A2A → Agent Core bridge
└── mcp/
    ├── server.ts            # MCP server with shell_execute tool
    └── transport.ts         # HTTP streamable transport + session management
```

## Scripts

| Script         | Command                                     | Description                                |
| -------------- | ------------------------------------------- | ------------------------------------------ |
| `dev`          | `tsx watch --env-file=.env src/index.ts`    | Development server with auto-reload        |
| `start`        | `node --env-file=.env dist/index.js`        | Production server (requires `build` first) |
| `build`        | `tsc`                                       | Compile TypeScript to `dist/`              |
| `db:create`    | `tsx scripts/db-create.ts`                  | Create the database (idempotent)           |
| `db:init`      | `tsx scripts/db-init.ts`                    | Initialize database schema and seed data   |
| `lint`         | `eslint src/`                               | Check for lint issues                      |
| `lint:fix`     | `eslint src/ --fix`                         | Auto-fix lint issues                       |
| `format`       | `prettier --write "src/**/*.ts"`            | Format all source files                    |
| `format:check` | `prettier --check "src/**/*.ts"`            | Check formatting (CI)                      |
| `typecheck`    | `tsc --noEmit`                              | Type-check without emitting                |

## Testing

An interactive A2A test client is included:

```bash
node test-a2a.mjs
```

This opens a multi-turn conversation loop (up to 6 turns) that sends messages via the A2A endpoint and displays agent responses. Type `quit` to exit early.

## Tech stack

| Layer      | Technology                                  |
| ---------- | ------------------------------------------- |
| Runtime    | Node.js >= 24, ESM                          |
| Language   | TypeScript 5.7, strict mode                 |
| Server     | Express 5                                   |
| AI         | Vercel AI SDK v6, multi-provider            |
| Database   | PostgreSQL via `pg`                         |
| Protocols  | REST, OpenAI-compat, A2A (JSON-RPC), MCP    |
| Logging    | Pino 10                                     |
| Validation | Zod                                         |
| Linting    | ESLint 9 (flat config) + typescript-eslint  |
| Formatting | Prettier 3                                  |

## License

MIT
