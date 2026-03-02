# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start dev server (tsx watch with auto-reload)
npm run build        # compile TypeScript to dist/
npm start            # run production build
npm run db:init      # initialize DB schema + seed data
npm run typecheck    # type-check without emitting
npm run lint         # lint (0 errors expected, warnings are intentional)
npm run lint:fix     # auto-fix lint issues
npm run format       # format all source files
npm run format:check # check formatting (CI gate)
```

## Architecture

Neura is a self-configuring AI assistant that stores its own configuration, instructions, and memories in PostgreSQL. The agent can read and modify its own behavior at runtime via the `shell_execute` tool (which runs psql commands against its database).

**Single process, four protocols:**
- `POST /chat` — REST chat endpoint (streaming by default via AI SDK `streamText`)
- `GET /v1/models` · `POST /v1/chat/completions` — OpenAI-compatible API (for Open WebUI, etc.)
- `POST /a2a` — A2A JSON-RPC (agent-to-agent, implements `tasks/send`)
- `POST|GET|DELETE /mcp` — MCP HTTP streamable transport with session management

**Agent execution flow:**
1. `getAgentConfig()` loads agent row + instructions from PostgreSQL (falls back to hardcoded defaults if DB unavailable)
2. `buildSystemPrompt()` assembles: core prompt → personality → priority-ordered instructions
3. `resolveModel()` parses `provider/model-name` string and returns AI SDK provider instance
4. `streamText()`/`generateText()` runs the agent with tools, capped at 10 steps via `stepCountIs(10)`

**Key patterns:**
- All `.js` import extensions (ESM with Node16 module resolution)
- Express 5 async middleware — errors propagate to the global handler in `app.ts`
- Agent config lives in `agents` + `agent_instructions` tables; the agent queries these via `psql "$DATABASE_URL" -t -A -c "SQL"`
- `psql` must be on PATH — it's a runtime dependency for the agent's `shell_execute` tool
- `ModelMessage` (not `CoreMessage`) is the AI SDK v6 message type
- `maxOutputTokens` (not `maxTokens`) is the AI SDK v6 token limit setting
- Unused function params prefixed with `_` (e.g., `_req`, `_next`) to satisfy no-unused-vars

## Environment

Requires Node >= 24. Environment validated with Zod in `src/env.ts`. Required: `DATABASE_URL`. At least one LLM API key needed (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`). Default agent uses Anthropic.

### Installing psql on Windows

PostgreSQL runs in Docker, but `psql` must be available on the host PATH for the agent's `shell_execute` tool. On Windows (Git Bash / MSYS2), install the client binaries without a full PostgreSQL installer:

```bash
# Download PostgreSQL binaries (zip, no installer)
curl -L -o /tmp/pgsql.zip \
  "https://get.enterprisedb.com/postgresql/postgresql-17.4-1-windows-x64-binaries.zip"

# Extract only psql and its DLL dependencies
unzip -o /tmp/pgsql.zip \
  "pgsql/bin/psql.exe" "pgsql/bin/libpq.dll" "pgsql/bin/libintl-*.dll" \
  "pgsql/bin/libssl-*.dll" "pgsql/bin/libcrypto-*.dll" \
  "pgsql/bin/libiconv-*.dll" "pgsql/bin/zlib*.dll" -d /tmp

# Copy to ~/bin (already on PATH in Git Bash)
mkdir -p ~/bin && cp /tmp/pgsql/bin/* ~/bin/

# Verify
psql --version
```

## Lint rules

ESLint 9 flat config with typescript-eslint type-checked rules. The `no-unsafe-*` and `no-explicit-any` rules are intentionally set to **warn** (not error) because the codebase has legitimate uses in error handlers, Express body parsing, and pg generics. Do not "fix" these warnings by adding suppression comments — they are expected.
