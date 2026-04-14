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
- **core** — node env, unit tests for cost-tracker, tools, voice-session (mocked `ws`), pglite-store, memory, discovery, skills, workers
- **cli** — node env, tests for config, health, port, service detection, download, commands
- **design-system** — jsdom env, hook tests (`useWebSocket`) and component tests (`StatusBadge`, `CostIndicator`)

Test files live in `src/__tests__/` (design-system) or co-located alongside source in domain subdirectories (`memory/memory-manager.test.ts`). Component/hook tests use `@testing-library/react`.

## Packages

### types

Pure types package — zero runtime dependencies. Defines the WebSocket protocol contract between core and all clients, plus provider and store interfaces.

- `protocol.ts` — `ClientMessage` / `ServerMessage` discriminated unions (includes `PresenceStateMessage`, `ManualStartMessage`)
- `tools.ts` — `ToolDefinition`, `ToolCallResult`, `VisionToolArgs`
- `config.ts` — `CoreConfig`, `UIConfig`, `NeuraConfigFile` interfaces (includes `assistantName`)
- `providers.ts` — `VoiceProvider`, `VisionProvider`, `DataStore` (session + memory methods), `ProviderPricing`, `SessionRecord`, `TranscriptEntry`
- `memory.ts` — Memory types: `IdentityEntry`, `UserProfileEntry`, `FactEntry`, `PreferenceEntry`, `SessionSummaryEntry`, `MemoryContext`, `ExtractionResult`
- `adapters.ts` — Provider adapter interfaces: `TextAdapter`, `STTAdapter`, `TTSAdapter`, `VisionAdapter`, `EmbeddingAdapter`
- `workers.ts` — Worker types: `WorkerStatus`, `WorkerTaskType`, worker lifecycle interfaces
- `skills.ts` — Skill types: `SkillLocation`, `NeuraSkill`, skill format interfaces

### utils

Shared runtime utilities used by core and clients.

- `logger.ts` — `Logger` class wrapping pino (structured logging with namespaces)
- `constants.ts` — `AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`, `AUDIO_FORMAT`, `FRAME_CAPTURE_INTERVAL_MS`
- `timer.ts` — `IntervalTimer` class (async-safe setInterval wrapper with `.unref()` lifecycle)

### core

Standalone server with provider adapter layer and pluggable storage. Organized into domain directories with TypeScript classes for stateful services. Includes discovery loop (proactive task notifications), shared-secret auth, and voice-managed work items.

**Directory structure:**

- `server/` — Express HTTP + WebSocket server, lifecycle management, per-client state machines, `auth.ts` (shared-secret token verification, timing-safe comparison)
- `memory/` — `MemoryManager`, `ExtractionPipeline`, `Reranker`, `BackupService`, prompt builder
- `presence/` — `PresenceManager` state machine (PASSIVE/ACTIVE/IDLE), `OnnxWakeDetector` (on-device ONNX inference via livekit-wakeword pipeline)
- `tools/` — Tool definitions and handlers split by domain (vision, time, memory, presence, tasks, skills, worker-control)
- `providers/` — `GrokVoiceProvider` (xAI Realtime API), `GeminiVisionProvider` (Live API), `PipelineVoiceProvider` (STT→LLM→TTS), voice-session/vision-watcher factories
- `adapters/` — Provider adapters: `DeepgramSTTAdapter`, `ElevenLabsTTSAdapter`, `OpenAITTSAdapter`, `OpenAICompatibleTextAdapter`, `OpenAICompatibleEmbeddingAdapter`, `SnapshotVisionAdapter`
- `stores/` — `PgliteStore` facade (WASM PostgreSQL 17 + pgvector), split into query modules (migrations, mappers, session/memory/search/entity/work-item/worker/backup queries)
- `cost/` — `CostTracker` per-session cost estimation
- `discovery/` — `DiscoveryLoop` proactive task notifications via Gemini
- `config/` — `loadConfig()` with env > config.json > defaults priority
- `skills/` — `loadNeuraSkills()`, `SkillRegistry`, `SkillWatcher` — runtime skill loading from `SKILL.md` files
- `workers/` — `AgentWorker`, `PiRuntime` (pi-coding-agent), `VoiceFanoutBridge`, `ClarificationBridge`, `WorkerCancellation`; `WorkerRuntime` interface
- `registry/` — `ProviderRegistry` — manages provider instances and capability-based routing

```bash
cd packages/core
# Configure ~/.neura/config.json with providers + routing (v3 schema)
# Or set env vars: NEURA_PROVIDER_XAI_API_KEY, NEURA_PROVIDER_GOOGLE_API_KEY
npm run dev             # http://localhost:3002
```

### cli

CLI tool + bundled core service, published to npm as `@mclean-capital/neura`. Since v1.11.0 the core ships **inside** the CLI npm package — there's no separate GitHub release tarball. `npm install -g @mclean-capital/neura` fetches the CLI plus the core bundle plus all native runtime deps (`onnxruntime-node`, `@electric-sql/pglite`) in one step.

- `src/index.ts` — Commander.js entry point
- `src/config.ts` — Load/save `~/.neura/config.json`, auth token generation (256-bit)
- `src/health.ts` — HTTP health check client for core's `/health` endpoint
- `src/port.ts` — Auto-assign free port in 18000-19000 range
- `src/download.ts` — Resolves the bundled core path (no more download logic; core lives at `<pkg>/core/server.bundled.mjs` inside the CLI's npm install)
- `src/update-check.ts` — Background update check against npm registry (detached child process + local cache)
- `src/version.ts` — Reads CLI version from adjacent package.json via createRequire
- `src/service/` — Platform-specific service managers (Windows stub, macOS launchd, Linux systemd). Service files reference `process.execPath` + the bundled core path.
- `src/commands/` — install, uninstall, start, stop, restart, status, config, logs, open, update, version, backup, restore, chat, listen
- `core/` — bundled core output (copied in from packages/core/dist at build time by `tools/bundle-core-into-cli.mjs`)

Config lives at `~/.neura/config.json`. Port priority: `PORT` env var > config.json > default (0 = not yet assigned). See `docs/cli-service-architecture.md` for full spec.

### ui

React 19 + Vite 6 + Tailwind v4 app. Connects to core in PASSIVE mode with auto-mic. On-device ONNX wake word detection activates voice session; manual Start button as fallback. Presence indicator (PASSIVE/ACTIVE). Independent media toggles (camera, screen share). Real-time cost indicator with voice/vision breakdown.

```bash
npm run dev -w @neura/ui   # http://localhost:5173 (proxies /ws → :3002)
```

### desktop

Electron desktop client with its own React renderer. Spawns core as a child process. Has its own UI independent of `packages/ui` — each client platform owns its frontend. Depends on `@neura/types`, `@neura/utils`, and `@neura/design-system`.

- `src/main/` — Electron main process (`CoreManager`, `UIServer`, tray, hotkey, store, updater)
- `src/renderer/` — React app (hooks, components, wizard, settings)
- `src/preload/` — contextBridge for secure IPC

```bash
npm run dev -w @neura/desktop       # dev mode (starts core + Electron)
npm run pack -w @neura/desktop      # build unpacked app
npm run dist:win -w @neura/desktop  # build Windows installer
```

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, and aesthetic direction are defined there. Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match DESIGN.md.

## Code Style

**Classes vs Functions:**

- Stateful services with lifecycle (start/stop, connect/close) → TypeScript class
- Pure computations, config loading, utilities → plain functions
- React components → functional (idiomatic React)
- CLI command handlers → functions (idiomatic CLI)

**Class conventions:**

- `private` for internal state, `private readonly` for immutable deps
- Constructor takes options object for >2 parameters
- Static `async create()` factory for async initialization (private constructor)
- Implements interface from `@neura/types` when the type crosses package boundaries

**File organization:**

- One class or closely related set of functions per file
- Co-located tests: `foo.ts` + `foo.test.ts` in the same directory
- Barrel `index.ts` in each domain directory
- Domain directories group by concern: server, memory, presence, tools, providers, adapters, stores, cost, discovery, config, skills, workers, registry

## Environment

Requires Node >= 22. Each package defines its own env vars in `.env.example`.
