# CLAUDE.md

## Architecture

Monorepo with two workspace roots: `packages/*` (production) and `prototypes/*` (experiments).

Core and UI always communicate over a WebSocket boundary — core is a standalone server with zero knowledge of Electron/browser, UI takes a WebSocket URL as config. This enables local → cloud → hybrid deployment with zero code changes.

```
packages/shared     @neura/shared    — protocol types, tool types, config constants
packages/core       @neura/core      — voice session, vision watcher, tools, server
packages/ui         @neura/ui        — React app (Vite), independent media toggles
prototypes/*                         — R&D prototypes (gemini-live, grok, hybrid)
```

## Commands

```bash
npm install                          # install all workspace deps

# Production packages
npm run dev -w @neura/core           # core server → http://localhost:3002
npm run dev -w @neura/ui             # UI dev server → http://localhost:5173

# Prototypes
npm run dev -w @neura/gemini-live    # run gemini-live prototype
npm run dev -w @neura/grok-live      # run grok prototype
npm run dev -w @neura/hybrid-live    # run hybrid prototype
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

## Prototypes

### gemini-live

Real-time voice conversation using Gemini 3.1 Flash Live API with native audio.

- **Server:** Express + WS relay to Gemini Live API (`src/server.ts`)
- **Session:** Gemini SDK wrapper with reconnection, compression, resumption (`src/session.ts`)
- **Tools:** Function calling demo — time, weather, dice (`src/tools.ts`)
- **Client:** Web Audio API mic capture (16kHz PCM) + playback (24kHz PCM) (`public/`)

```bash
cd prototypes/gemini-live
cp .env.example .env   # add your GOOGLE_API_KEY
npm run dev             # http://localhost:3000
```

### grok

Real-time voice conversation using Grok Voice Agent API (OpenAI Realtime API compatible).

- **Server:** Express + WS relay to xAI Realtime API (`src/server.ts`)
- **Session:** Raw WebSocket to `wss://api.x.ai/v1/realtime` (`src/session.ts`)
- **Tools:** Function calling demo — time, weather, dice (`src/tools.ts`)
- **Client:** Web Audio API mic capture (24kHz PCM) + playback (24kHz PCM) (`public/`)
- **Voice:** Eve (energetic female)

```bash
cd prototypes/grok
cp .env.example .env   # add your XAI_API_KEY
npm run dev             # http://localhost:3001
```

### hybrid (recommended)

Best-of-both: Grok Eve voice + Gemini continuous vision watcher. Supports camera and screen sharing.

- **Server:** Express + WS, orchestrates Grok voice + Gemini watcher (`src/server.ts`)
- **Grok session:** Eve voice, VAD, function calling (`src/grok-session.ts`)
- **Gemini watcher:** Continuous Gemini Live session receiving video every 2s, builds temporal visual context with sliding window compression (`src/gemini-watcher.ts`)
- **Tools:** `describe_camera`, `describe_screen`, time, weather, dice (`src/tools.ts`)
- **Client:** Camera + screen share + mic + transcript with watcher transparency (`public/`)

Architecture:

```
Camera/Screen (every 2s) → Server → Gemini Live WS (watcher, 3-6 min visual memory)
Mic audio → Server → Grok WS (Eve voice)
                       └─ tool call → text query to watcher → Grok speaks result
```

```bash
cd prototypes/hybrid
cp .env.example .env   # add XAI_API_KEY + GOOGLE_API_KEY
npm run dev             # http://localhost:3002
```

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
- `vision-watcher.ts` — Vision watcher (currently Gemini Live) with source-aware frames and ID-based query queue
- `tools.ts` — `describe_camera`, `describe_screen`, `get_current_time`
- `cost-tracker.ts` — Per-connection cost estimator

```bash
cd packages/core
cp .env.example .env   # add XAI_API_KEY + GOOGLE_API_KEY
npm run dev             # http://localhost:3002
```

### ui

React 19 + Vite 6 app. Independent media toggles (mic, camera, screen share can be toggled independently).

```bash
npm run dev -w @neura/ui   # http://localhost:5173 (proxies /ws → :3002)
```

## Environment

Requires Node >= 22. Each package/prototype defines its own env vars in `.env.example`.
