# CLAUDE.md

## Architecture

Monorepo with workspace root `packages/*`.

Core and UI always communicate over a WebSocket boundary — core is a standalone server with zero knowledge of Electron/browser, UI takes a WebSocket URL as config. This enables local → cloud → hybrid deployment with zero code changes.

```
packages/shared     @neura/shared    — protocol types, tool types, config constants
packages/core       @neura/core      — voice session, vision watcher, tools, server
packages/ui         @neura/ui        — React app (Vite), independent media toggles
```

## Commands

```bash
npm install                          # install all workspace deps
npm run dev -w @neura/core           # core server → http://localhost:3002
npm run dev -w @neura/ui             # UI dev server → http://localhost:5173
```

## Tooling

```bash
npm run typecheck                    # typecheck all packages (turbo)
npm run lint                         # lint all packages (turbo)
npm run lint:fix                     # lint + autofix (turbo)
npm run format                       # format all files (prettier)
npm run format:check                 # check formatting (prettier)
npm run test                         # run tests (turbo + vitest)
npm run build                        # build all packages (turbo)
```

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by commitlint via husky commit-msg hook. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

## Testing

Each package has its own `vitest.config.ts`. Run all tests via turbo:

```bash
npm run test                         # all packages (canonical)
npm run test -w @neura/core          # single package
```

- **shared** — node env, contract tests for audio constants
- **core** — node env, unit tests for cost-tracker, tools, voice-session (mocked `ws`)
- **ui** — jsdom env, hook tests (`useWebSocket`) and component tests (`StatusBadge`, `CostIndicator`)

Test files live alongside source (`src/*.test.ts`, `src/**/*.test.tsx`). UI tests use `@testing-library/react`.

## Packages

### shared

Pure types package — zero runtime dependencies. Defines the WebSocket protocol contract between core and UI.

- `protocol.ts` — `ClientMessage` / `ServerMessage` discriminated unions
- `tools.ts` — `ToolDefinition`, `ToolCallResult`, `VisionToolArgs`
- `config.ts` — `CoreConfig`, `UIConfig`, audio constants

### core

Standalone server extracted from the hybrid prototype. Provider-agnostic module names.

- `server.ts` — Express + WebSocket, typed message routing
- `voice-session.ts` — Voice session (currently Grok Eve) with reconnect, transcript seeding, 28-min proactive reconnect
- `vision-watcher.ts` — Vision watcher (currently Gemini Live), one session per source (camera/screen independent)
- `tools.ts` — `describe_camera`, `describe_screen`, `get_current_time`
- `cost-tracker.ts` — Per-source cost estimator (voice + camera + screen tracked independently)

```bash
cd packages/core
cp .env.example .env   # add XAI_API_KEY + GOOGLE_API_KEY
npm run dev             # http://localhost:3002
```

### ui

React 19 + Vite 6 + Tailwind v4 app. Session is off by default (no auto-charge). Independent media toggles (mic, camera, screen share). Real-time cost indicator with voice/vision breakdown.

```bash
npm run dev -w @neura/ui   # http://localhost:5173 (proxies /ws → :3002)
```

## Environment

Requires Node >= 22. Each package defines its own env vars in `.env.example`.
