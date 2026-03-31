# CLAUDE.md

## Architecture

Monorepo with workspace root `packages/*`.

Each client platform is a standalone app with its own UI. Clients share only the WebSocket protocol (`@neura/shared`) — no client depends on another client's code. Core is a standalone server with zero knowledge of any client.

```
packages/shared         @neura/shared         — protocol types, tool types, config constants
packages/design-system  @neura/design-system  — shared React components, hooks, CSS tokens, Storybook
packages/core           @neura/core           — voice session, vision watcher, tools, server
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
- **design-system** — jsdom env, hook tests (`useWebSocket`) and component tests (`StatusBadge`, `CostIndicator`)

Test files live in `src/__tests__/` (design-system) or alongside source (`src/*.test.ts`). Component/hook tests use `@testing-library/react`.

## Packages

### shared

Pure types package — zero runtime dependencies. Defines the WebSocket protocol contract between core and all clients.

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

### desktop

Electron desktop client with its own React renderer. Spawns core as a child process. Has its own UI independent of `packages/ui` — each client platform owns its frontend. Depends only on `@neura/shared` for protocol types.

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
