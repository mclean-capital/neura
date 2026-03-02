# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start dev server (tsx watch with auto-reload)
npm run build        # compile TypeScript to dist/
npm start            # run production build
npm run db:init      # initialize DB schema + seed data
npm run typecheck    # type-check without emitting
npm test             # run all tests (vitest)
npm run test:watch   # run tests in watch mode
npm run test:coverage # run tests with coverage report
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

### Installing psql client only

PostgreSQL runs in Docker, but `psql` must be available on the host PATH for the agent's `shell_execute` tool.

**macOS (Homebrew):**

```bash
brew install libpq
# libpq is keg-only — add to PATH:
# Intel Mac:  echo 'export PATH="/usr/local/opt/libpq/bin:$PATH"' >> ~/.zshrc
# Apple Silicon: echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
psql --version
```

**Windows (Git Bash / MSYS2):**

```bash
curl -L -o /tmp/pgsql.zip \
  "https://get.enterprisedb.com/postgresql/postgresql-17.4-1-windows-x64-binaries.zip"
unzip -o /tmp/pgsql.zip \
  "pgsql/bin/psql.exe" "pgsql/bin/libpq.dll" "pgsql/bin/libintl-*.dll" \
  "pgsql/bin/libssl-*.dll" "pgsql/bin/libcrypto-*.dll" \
  "pgsql/bin/libiconv-*.dll" "pgsql/bin/zlib*.dll" -d /tmp
mkdir -p ~/bin && cp /tmp/pgsql/bin/* ~/bin/
psql --version
```

## Open WebUI integration

Requires **Open WebUI v0.6.17+** with `ENABLE_FORWARD_USER_INFO_HEADERS=True` set in the container env. This makes Open WebUI send `X-OpenWebUI-Chat-Id` (a UUID) on every request, which Neura uses to avoid creating duplicate conversations.

**Conversation ID precedence** in `src/server/routes/openai.ts`:
1. `X-Conversation-Id` header (direct API callers)
2. `X-OpenWebUI-Chat-Id` header (Open WebUI)
3. `chat_id` body field (future clients)
4. New UUID (fallback)

All values are trimmed and UUID-validated. Mismatched headers produce a warning log. Missing IDs from all sources also log a warning.

## Verification workflow

After making changes, run checks in this order:

1. **Always (after every change):** `npm run typecheck` and `npm run lint`
2. **After functional changes:** `npm test` — all 77+ tests must pass, 0 failures
3. **After major changes** (new features, multi-file refactors, bug fixes, dependency updates): run a Codex review for 3rd-party feedback

### Codex review

Use OpenAI Codex CLI as an independent reviewer after major changes. This is not a gate like lint/typecheck — it's advisory feedback to catch blind spots.

```bash
# Review uncommitted changes (preferred)
codex exec review --uncommitted --full-auto

# Follow up on a review session (session ID is in the output header)
codex exec resume <SESSION_ID> "<follow-up prompt>" --full-auto

# Review changes against a base branch
codex exec review --base main --full-auto
```

**Important rules:**
- Codex findings are **advisory, not authoritative**. Validate each finding against the codebase before acting. When in doubt, ask the user.
- Codex's sandbox cannot run `npm test` (spawn EPERM) — ignore any findings about test runner failures inside Codex.
- On Windows Git Bash, use the subcommand form (`codex exec review`) not `/review` (which gets path-expanded).
- Use `--full-auto` for reviews. Do not combine `--yolo` with `--full-auto`.

## Testing

Tests use Vitest with `pool: "forks"` (clean process per file to avoid import-time side effect leaks from `env.ts` and `connection.ts`). Test files live alongside source (`src/**/*.test.ts`) and are excluded from production builds via `tsconfig.build.json`.

**Mocking strategy:** Tests mock at module boundaries using `vi.mock()`. Three primary mock targets: `db/connection.js` (DB access), `db/conversations.js` (DB in routes), `agent/core.js` (LLM + prompt loading). Route tests use supertest against isolated Express apps (not the full `createApp()`).

**Regression tests:** Tests marked `[REGRESSION]` in comments guard against specific bugs that were fixed. These must not be removed.

## Lint rules

ESLint 9 flat config with typescript-eslint type-checked rules. The `no-unsafe-*` and `no-explicit-any` rules are intentionally set to **warn** (not error) because the codebase has legitimate uses in error handlers, Express body parsing, and pg generics. Do not "fix" these warnings by adding suppression comments — they are expected.
