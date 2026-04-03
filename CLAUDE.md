# CLAUDE.md

## Architecture

Monorepo with workspace root `packages/*`.

Each client platform is a standalone app with its own UI. Clients share only the WebSocket protocol (`@neura/types`) — no client depends on another client's code. Core is a standalone server with zero knowledge of any client.

```
packages/types          @neura/types          — protocol types, tool types, config interfaces (pure types, zero runtime deps)
packages/utils          @neura/utils          — shared runtime utilities (Logger, audio/frame constants)
packages/design-system  @neura/design-system  — shared React components, hooks, CSS tokens, Storybook
packages/core           @neura/core           — voice session, vision watcher, tools, server
packages/cli            @neura/cli            — CLI for installing/managing core as OS service
packages/ui             @neura/ui             — web client (React + Vite)
packages/desktop        @neura/desktop        — desktop client (Electron + React), spawns core
```

## Commands

```bash
npm install                          # install all workspace deps
npm run dev -w @neura/core           # core server → http://localhost:3002
npm run dev -w @neura/ui             # UI dev server → http://localhost:5173
npm run dev -w @neura/desktop        # Electron app (starts core + UI + Electron)
npm run dev -w @neura/design-system  # Storybook → http://localhost:6006
npm run dev -w @neura/cli            # CLI dev mode (via tsx)
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

- **utils** — node env, tests for audio constants and Logger
- **core** — node env, unit tests for cost-tracker, tools, voice-session (mocked `ws`), sqlite-store
- **cli** — node env, tests for config, health, port, service detection, download, commands
- **design-system** — jsdom env, hook tests (`useWebSocket`) and component tests (`StatusBadge`, `CostIndicator`)

Test files live in `src/__tests__/` (design-system) or alongside source (`src/*.test.ts`). Component/hook tests use `@testing-library/react`.

## Packages

### types

Pure types package — zero runtime dependencies. Defines the WebSocket protocol contract between core and all clients, plus provider and store interfaces.

- `protocol.ts` — `ClientMessage` / `ServerMessage` discriminated unions
- `tools.ts` — `ToolDefinition`, `ToolCallResult`, `VisionToolArgs`
- `config.ts` — `CoreConfig`, `UIConfig` interfaces
- `providers.ts` — `VoiceProvider`, `VisionProvider`, `DataStore`, `ProviderPricing`, `SessionRecord`, `TranscriptEntry`

### utils

Shared runtime utilities used by core and clients.

- `logger.ts` — `Logger` class wrapping pino (structured logging with namespaces)
- `constants.ts` — `AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`, `AUDIO_FORMAT`, `FRAME_CAPTURE_INTERVAL_MS`

### core

Standalone server with provider adapter layer and pluggable storage.

- `server.ts` — Express + WebSocket, typed message routing, optional SQLite persistence
- `voice-session.ts` — Factory wrapper, delegates to active voice provider
- `vision-watcher.ts` — Factory wrapper, delegates to active vision provider
- `providers/grok-voice.ts` — Grok (xAI Realtime API) voice provider with reconnect, transcript seeding, 28-min proactive reconnect
- `providers/gemini-vision.ts` — Gemini Live vision provider, one session per source (camera/screen independent)
- `stores/sqlite-store.ts` — `SqliteStore` implementing `DataStore` (sessions + transcripts)
- `tools.ts` — `describe_camera`, `describe_screen`, `get_current_time`
- `cost-tracker.ts` — Per-source cost estimator, accepts `ProviderPricing`

```bash
cd packages/core
# Set env vars: XAI_API_KEY, GOOGLE_API_KEY, optionally DB_PATH
npm run dev             # http://localhost:3002
```

### cli

CLI tool for installing and managing Neura Core as a persistent OS background service.

- `src/index.ts` — Commander.js entry point, 11 commands
- `src/config.ts` — Load/save `~/.neura/config.json`
- `src/health.ts` — HTTP health check client for `/health` endpoint
- `src/port.ts` — Auto-assign free port in 18000-19000 range
- `src/download.ts` — GitHub release asset downloader (placeholder until release pipeline)
- `src/service/` — Platform-specific service managers (Windows, macOS, Linux)
- `src/commands/` — install, uninstall, start, stop, restart, status, config, logs, open, update, version

Config lives at `~/.neura/config.json`. Port priority: `PORT` env var > config.json > default (0 = not yet assigned). See `docs/cli-service-architecture.md` for full spec.

### ui

React 19 + Vite 6 + Tailwind v4 app. Session is off by default (no auto-charge). Independent media toggles (mic, camera, screen share). Real-time cost indicator with voice/vision breakdown.

```bash
npm run dev -w @neura/ui   # http://localhost:5173 (proxies /ws → :3002)
```

### desktop

Electron desktop client with its own React renderer. Spawns core as a child process. Has its own UI independent of `packages/ui` — each client platform owns its frontend. Depends on `@neura/types`, `@neura/utils`, and `@neura/design-system`.

- `src/main/` — Electron main process (core-manager, tray, hotkey, store, updater)
- `src/renderer/` — React app (hooks, components, wizard, settings)
- `src/preload/` — contextBridge for secure IPC

```bash
npm run dev -w @neura/desktop       # dev mode (starts core + Electron)
npm run pack -w @neura/desktop      # build unpacked app
npm run dist:win -w @neura/desktop  # build Windows installer
```

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, and aesthetic direction are defined there. Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match DESIGN.md.

## Environment

Requires Node >= 22. Each package defines its own env vars in `.env.example`.
