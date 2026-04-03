# Neura Roadmap

## Vision

Neura is a proactive, autonomous AI operating system. It combines real-time voice conversation, continuous visual understanding, and autonomous worker agents — all driven by discovery and execution loops that make the system think and act on its own, not just react to user input.

---

## Current State

Phase 2a (alpha) and Phase 2b (MVP) are complete. The platform is a fully functional monorepo with 7 packages, a persistent service architecture, and 98+ unit tests.

### What's built

- **Hybrid voice + vision** — Grok Eve for voice, Gemini Live for continuous vision watcher, bridged via tool calls
- **Persistent core service** — Core runs as an OS-managed background service (launchd, systemd, Windows Service stub), independent of any client
- **`neura` CLI** — 11 commands to install, configure, and manage core: `install`, `start`, `stop`, `restart`, `status`, `config`, `logs`, `open`, `update`, `version`, `uninstall`
- **Desktop app** — Electron with setup wizard, tray icon, global hotkey, auto-update
- **Web UI** — React 19 + Vite 6 + Tailwind v4, connects to core via WebSocket
- **Design system** — 11 shared React components, 6 hooks, Storybook, industrial precision aesthetic
- **Provider adapter layer** — Pluggable voice/vision providers behind typed interfaces
- **SQLite persistence** — Sessions, transcripts, cost tracking
- **Optional web UI serving** — Core serves pre-built UI from `~/.neura/ui/` if present

### Architecture (validated)

```
Camera/Screen (every 2s) → Core → Gemini Live WS (watcher, 3-6 min visual memory)
Mic audio → Core → Grok WS (Eve voice)
                    └─ tool call → text query to watcher → Grok speaks result
```

---

## Architecture

### Core design principle: persistent daemon with disposable clients

Core is **always** a standalone background service. Clients connect and disconnect freely — no client owns the core lifecycle. The `neura` CLI installs and manages the service. Any client (desktop, web, mobile) connects via WebSocket.

```
                    neura install (CLI)
                         │
              auto-assigns port, registers OS service
                         │
                         ▼
              ┌─────────────────────┐
              │    Neura Core       │  ws://localhost:{port}
              │    (OS service)     │  GET /health
              │                     │  GET / (web UI if installed)
              └──────────┬──────────┘
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
        Desktop        Web UI      Mobile
        (Electron)    (browser)    (future)
```

The core has zero knowledge of Electron, browsers, or mobile apps. Clients have zero knowledge of Grok, Gemini, or workers. The WebSocket protocol is the only contract.

### Package structure

```
packages/
├── types/          # Pure types — protocol, tools, config, provider/store interfaces
├── utils/          # Shared runtime — Logger (pino), audio/frame constants
├── design-system/  # Shared React components, hooks, CSS tokens, Storybook
├── core/           # Standalone server — orchestrator, providers, tools, stores,
│                   #   optional UI static mount. Runs as OS service, Docker, or dev.
├── cli/            # CLI for installing/managing core as persistent OS service.
│                   #   Platform service managers (Windows, macOS, Linux).
├── ui/             # React web UI — takes a WebSocket URL as config, nothing else.
├── desktop/        # Electron client — tray, hotkeys, auto-update, setup wizard.
│                   #   Currently spawns core; planned: attach to running service.
├── workers/        # Worker runtime, built-in worker types, MCP integrations (planned)
├── relay/          # Optional local relay for hybrid mode (planned)
├── mobile/         # React Native client (planned)
├── extension/      # Browser extension (planned)
├── obs/            # OBS plugin/overlay (planned)
└── vscode/         # VS Code extension (planned)
docs/
├── roadmap.md                  # This file
└── cli-service-architecture.md # CLI & persistent core service spec
```

### How components relate

```
┌─────────────────────────────────────────────────────┐
│  neura install (CLI)                                 │
│  ├── Writes ~/.neura/config.json (API keys, port)    │
│  ├── Downloads core binary → ~/.neura/core/          │
│  ├── Downloads web UI → ~/.neura/ui/ (optional)      │
│  └── Registers OS service (launchd/systemd/Windows planned) │
└──────────────────────┬──────────────────────────────┘
                       │ starts
                       ▼
┌─────────────────────────────────────────────────────┐
│  core (ws://localhost:{port})                        │
│  ├── Grok WS (voice)           GET /health           │
│  ├── Gemini WS (watcher)       GET / (web UI)        │
│  ├── Tools (describe_camera, describe_screen, time)  │
│  ├── Cost tracker              SQLite persistence    │
│  └── Future: discovery loop, workers, skills         │
└──────────────────────┬──────────────────────────────┘
                       │ any client connects
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      desktop        web UI      mobile
      (Electron)    (browser)    (future)
      ├── Audio     ├── Audio    ├── Audio
      ├── Camera    ├── Camera   ├── Camera
      ├── Screen    ├── Screen   └── Push
      ├── Tray      └── Text       notifications
      └── Hotkey
```

### Port strategy

| Mode                    | Default                           | Override                    | Stored Where           |
| ----------------------- | --------------------------------- | --------------------------- | ---------------------- |
| **Local (CLI install)** | Auto-assigned (18000-19000 range) | `neura config set port <n>` | `~/.neura/config.json` |
| **Cloud / Docker**      | `3002`                            | `PORT` env var              | Environment            |
| **Dev (`npm run dev`)** | `3002`                            | `.env` / `PORT` env var     | Environment            |

Config priority: `PORT` env var > `config.json` > `3002` fallback.

### Deployment modes

The same packages deploy in different configurations. No code changes, just where processes run:

| Mode                | Core runs                                 | UI connects to            | Workers run       | State layer |
| ------------------- | ----------------------------------------- | ------------------------- | ----------------- | ----------- |
| **Local (CLI)**     | OS service on user's machine              | `localhost:{port}`        | Local processes   | SQLite      |
| **Local (Desktop)** | Spawned by Electron (planned: OS service) | `localhost:{port}`        | Local processes   | SQLite      |
| **Cloud**           | Cloud server (Docker)                     | `wss://neura.example.com` | Cloud containers  | Postgres    |
| **Hybrid**          | Cloud server                              | Local relay → cloud       | Cloud containers  | Postgres    |
| **Self-hosted**     | Docker on user's server                   | User's domain             | Docker containers | Postgres    |

### Transport strategy

**WebSocket now, WebRTC selectively later.**

WebSocket is the right starting point — LLM API latency (1-3 seconds) dwarfs the ~30ms transport difference vs WebRTC. WebSocket is simpler to deploy and already proven.

| Phase               | Transport                 | Why                                                       |
| ------------------- | ------------------------- | --------------------------------------------------------- |
| **Current**         | WebSocket everywhere      | Simple, works, ships fast                                 |
| **Mobile**          | Evaluate WebRTC for media | UDP handles flaky mobile networks better                  |
| **Real-time video** | WebRTC for high-FPS video | 30 FPS gaming/sports benefits from binary media transport |

---

## Install Paths

Two equivalent install methods — both produce the same result.

### Path 1: CLI (recommended)

```bash
# macOS / Linux
curl -fsSL https://neura.sh/install | bash

# Windows PowerShell
irm https://neura.sh/install.ps1 | iex

# Or via npm (requires Node.js >= 22)
npm install -g @neura/cli
neura install
```

### Path 2: Desktop App

Download from neura.ai or GitHub releases. The desktop app connects to a running core — if core isn't installed, the setup wizard handles it.

### End state

```
~/.neura/
├── config.json              # API keys, port, voice, preferences
├── core/
│   └── neura-core(.exe)     # Core binary (from GitHub releases)
├── ui/                      # Pre-built web UI (optional)
│   ├── index.html
│   └── assets/
├── pgdata/                  # PGlite data directory (WASM Postgres + pgvector)
├── logs/
│   ├── core.log
│   └── core.error.log
└── service/                 # Platform-specific service config
```

---

## I/O Roadmap

### Inputs

| Capability           | Status  | Description                                               |
| -------------------- | ------- | --------------------------------------------------------- |
| Voice (mic)          | Done    | PCM audio → Grok via WebSocket relay                      |
| Camera video         | Done    | JPEG every 2s → Gemini watcher                            |
| Screen share         | Done    | JPEG every 2s → Gemini watcher (browser getDisplayMedia)  |
| Text input           | Done    | Text box → Grok                                           |
| File/document upload | Planned | Drag & drop PDF, image, code files for analysis           |
| Clipboard            | Planned | "Analyze what I just copied" — system clipboard access    |
| System audio         | Planned | Desktop audio capture (game sounds, video playing, music) |
| Web search           | Planned | Enable Grok's native `web_search` and `x_search` tools    |
| Webhooks             | Planned | External events triggering the discovery loop             |
| Scheduled triggers   | Planned | Cron/timer-based discovery loop activation                |

### Outputs

| Capability         | Status  | Description                                        |
| ------------------ | ------- | -------------------------------------------------- |
| Voice (Eve)        | Done    | Grok audio → speaker playback                      |
| Transcripts        | Done    | Input/output transcription in UI                   |
| Tool transparency  | Done    | Watcher responses visible in UI                    |
| Cost indicator     | Done    | Real-time session cost with voice/vision breakdown |
| Structured text    | Planned | Code blocks, markdown, links rendered properly     |
| Image generation   | Planned | "Draw a diagram of this architecture"              |
| File export        | Planned | Save transcripts, export conversation history      |
| Push notifications | Planned | Proactive alerts to connected clients              |
| SMS/messaging      | Planned | Text the user when they're not connected           |
| Persistent memory  | Planned | Conversation context across sessions (Phase 3)     |

---

## Pricing & Cost Analysis

### API pricing (as of March 2026)

| Provider                  | Model                  | Pricing model                | Rate                                                              |
| ------------------------- | ---------------------- | ---------------------------- | ----------------------------------------------------------------- |
| **Grok Voice Agent**      | Grok (Eve)             | Flat per-minute (wall-clock) | $0.05/min ($3.00/hr)                                              |
| **Gemini 3.1 Flash Live** | Watcher (vision)       | Per-minute                   | Video in: $0.002/min, Audio in: $0.005/min, Audio out: $0.018/min |
| **Gemini 2.5 Flash**      | Vision REST (fallback) | Per-token                    | $3.00/1M input, $2.00/1M output                                   |

### Estimated session costs (hybrid)

| Duration | Grok voice | Gemini watcher (video in) | Gemini query responses | **Total**  |
| -------- | ---------- | ------------------------- | ---------------------- | ---------- |
| 5 min    | $0.25      | $0.01                     | ~$0.00                 | **~$0.26** |
| 15 min   | $0.75      | $0.03                     | ~$0.01                 | **~$0.79** |
| 30 min   | $1.50      | $0.06                     | ~$0.02                 | **~$1.58** |
| 1 hour   | $3.00      | $0.12                     | ~$0.04                 | **~$3.16** |

**Key notes:**

- Grok charges for wall-clock connection time (silence costs money)
- Gemini watcher video input is very cheap (~$0.12/hr)
- Grok has an observed ~30 min session limit, requiring reconnection for longer sessions
- Cost transparency is built into the UI — real-time session cost indicator with voice/vision breakdown

---

## Client Platforms

### Tier 1 — Built / building

| Client                  | Status  | Key features                                      |
| ----------------------- | ------- | ------------------------------------------------- |
| **Web**                 | Done    | Camera, screen share, full UI                     |
| **Electron desktop**    | Done    | Clipboard, system audio, global hotkey, tray icon |
| **CLI**                 | Done    | Service management, config, health checks         |
| **React Native mobile** | Planned | Camera, push notifications, background audio      |

### Tier 2 — High value

| Client                 | Why                                        | Key features                                                   |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| **Browser extension**  | Vision on any webpage without screen share | "Explain this page," overlay UI, context from active tab       |
| **VS Code extension**  | Coding assistant with voice + vision       | Voice commands, sees your editor, explains errors, writes code |
| **OBS plugin/overlay** | Streaming/gaming buddy                     | Scene awareness, chat interaction, on-stream AI                |

### Tier 3 — Explore

| Client             | Why                                | Key features                                    |
| ------------------ | ---------------------------------- | ----------------------------------------------- |
| **Discord bot**    | Voice channel presence with vision | Screen share in calls, community interaction    |
| **Smart glasses**  | Camera + mic on your face          | Hands-free, always-on vision                    |
| **Car mode**       | Hands-free, audio only             | Simplified UI, driving-safe interaction         |
| **Embedded/kiosk** | Physical spaces                    | Raspberry Pi + camera, reception desk, workshop |

---

## Real-time Video Mode

An enhanced video mode for scenarios where real-time visual understanding is critical. The standard watcher (~0.5 FPS) works for static content. This mode increases frame rate, adds system audio, and optimizes for low-latency interaction.

### Requirements

| Requirement                 | Details                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| **Adaptive frame rate**     | 2-5 FPS baseline, motion detection to burst higher during fast action  |
| **System audio capture**    | Desktop audio alongside mic — AI hears what the user hears             |
| **Push-to-talk option**     | When system audio is active, VAD may false-trigger. Hotkey alternative |
| **Non-intrusive responses** | Spatial audio or dedicated channel — don't talk over content           |
| **Context priming**         | Tell the watcher what it's looking at ("this is a D&D RPG")            |
| **Low latency**             | Watcher query + Grok response < 2-3 seconds                            |

### Use cases

**Gaming** — AI sees game state and advises, reacts to events proactively, tracks objectives/inventory, stream overlay integration.

**Movie/TV** — "Who is that actor?", "What just happened?", proactive trivia during slow moments.

**Sports** — Real-time play analysis, rules explanation, highlight detection.

**Education** — Live note-taking from lectures, "pause and explain that concept", auto-summarize.

**Work** — Dashboard monitoring with AI commentary, pair programming, meeting assistant.

**Creative** — Art/design review, music production feedback, video editing suggestions.

---

## Memory & Identity System

Persistent memory that survives across sessions, restarts, and client reconnections. Loaded into the voice provider system prompt so the AI knows who it's talking to and what it's been working on.

### Memory architecture

| Layer             | Storage                    | What goes here                                                   |
| ----------------- | -------------------------- | ---------------------------------------------------------------- |
| **Identity**      | `identity` table           | Personality, behavioral boundaries, tone — learned from feedback |
| **Long-term**     | `facts` table + pgvector   | Durable knowledge with vector embeddings — semantic recall       |
| **Preferences**   | `preferences` table        | Behavioral corrections and confirmations — high-weight rules     |
| **User profile**  | `user_profile` table       | Operator role, goals, expertise — learned from conversation      |
| **Sessions**      | `sessions` + `transcripts` | Session records, transcripts, cost data — structured queries     |
| **Summaries**     | `session_summaries` table  | Auto-generated end-of-session summaries for continuity           |
| **Tasks/workers** | DB tables (planned)        | Active tasks, worker state, schedules                            |

### Memory flow

```
Session starts → Load identity + user profile + preferences + recent facts + summaries
                    ↓
              Inject into system prompt (token-budgeted, priority-ordered)
                    ↓
              AI has full context: who it is, who you are,
              what it's been working on, what happened recently
                    ↓
Conversation ends → Extraction pipeline (Gemini 2.5 Flash)
  (idle timeout)     extracts facts, preferences, profile updates
                     generates embeddings (Gemini Embedding)
                     stores everything in DB for next session
```

### Design principles

- **Voice-first** — users never edit files. Everything learned through conversation
- **DB-first** — all memory in PGlite (local) or Postgres (cloud). Queryable, portable, vector-searchable
- **Automatic** — AI manages its own memory via extraction pipeline and memory tools
- **Portable** — same SQL dialect local and cloud. Migration is `pg_dump` / `pg_restore`

See [Phase 3 architecture document](phase3-memory.md) for detailed design.

---

## Discovery Loop

The discovery loop is what makes Neura proactive instead of reactive. It continuously evaluates context and decides if action is needed — without waiting for the user to ask.

### Trigger sources

| Source                | Example                                                    |
| --------------------- | ---------------------------------------------------------- |
| **Timer**             | Every 5 minutes, check if any monitored dashboards changed |
| **Webhook**           | GitHub push event → check if CI passed → notify user       |
| **Calendar**          | Meeting in 15 min → prep briefing doc, remind user         |
| **Email/messages**    | New urgent email → summarize and push audio notification   |
| **Worker completion** | Research worker finished → report results to user          |
| **Context change**    | User opened a new app (vision) → offer relevant help       |
| **External APIs**     | Stock price hit threshold → alert user                     |
| **Scheduled**         | Daily morning briefing, weekly summary                     |

### Decision engine

```
Trigger received
    │
    ├── Is user connected? ──→ Push audio/text to active client
    │
    ├── Is this urgent? ──→ SMS/push notification to phone
    │
    ├── Does this need a worker? ──→ Spawn worker, track work item
    │
    ├── Does this need user input? ──→ Queue prompt, deliver when available
    │
    └── Is this informational? ──→ Store in context, mention when relevant
```

### Configuration

Discovery loop behavior is configured via a heartbeat checklist stored in the DB (editable via CLI or voice):

```
Default heartbeat tasks (every 30 minutes):
- Check email for urgent items
- Review calendar for upcoming meetings (15 min window)
- Check monitored GitHub repos for new issues/PRs
- Scan screen context for relevant changes (if connected)
```

Cost-optimized: heartbeat runs in an isolated session (~2-5K tokens) with only the checklist and minimal memory context loaded.

---

## Skill Registry

Skills are extensible capabilities loaded at runtime. Each skill is a directory with a `SKILL.md` file describing when and how to use it.

### Structure

```
~/.neura/skills/
├── describe-camera/
│   └── SKILL.md
├── describe-screen/
│   └── SKILL.md
├── check-email/
│   └── SKILL.md
├── summarize-meeting/
│   └── SKILL.md
└── research-topic/
    └── SKILL.md
```

### How skills work

- YAML frontmatter describes when the skill triggers
- Markdown body provides instructions (loaded only when triggered)
- No recompilation — add a directory, restart core, skill is available
- Self-extensible: the agent can write new skills autonomously

---

## Worker System

Workers are autonomous agents spawned by the orchestrator to get real tasks done. The orchestrator tracks them in real-time and reports status to the user via voice.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  CORE ORCHESTRATOR                                  │
│                                                     │
│  Real-time layer          Worker pool               │
│  ├── Grok (voice)         ├── Worker A [running]    │
│  ├── Gemini (vision)      ├── Worker B [waiting]    │
│  └── Tool system          └── Worker C [watching]   │
│                                                     │
│  State layer (DB)                                   │
│  ├── Work items + references                        │
│  ├── Worker status + history                        │
│  └── User preferences + memory                     │
└─────────────────────────────────────────────────────┘
```

### Worker types (planned)

| Type              | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| **Research**      | Web search, document analysis, competitive intelligence        |
| **Code**          | Write, test, and deploy code changes                           |
| **Document**      | Draft emails, reports, summaries, presentations                |
| **Monitor**       | Watch deployments, dashboards, feeds — alert on changes        |
| **Data**          | ETL, analysis, visualization, database queries                 |
| **Communication** | Send emails, Slack messages, schedule meetings                 |
| **Integration**   | API calls, webhook management, third-party service interaction |

### Execution loop

The execution loop drives autonomous task completion:

```
Check pending work items
    │
    ├── Worker idle? ──→ Assign next queued task
    ├── Worker stuck? ──→ Retry, escalate, or reassign
    ├── Worker done? ──→ Store result, chain next task
    ├── Needs approval? ──→ Queue for user review
    └── All clear? ──→ Sleep until next trigger
```

### Voice interaction with workers

```
User: "Research the top 5 competitors in real-time AI voice APIs
       and put together a comparison doc"

Core: "On it — I've spawned a worker for that. Want me to check in
       periodically or just let you know when it's done?"

User: "Check in every couple minutes"

Core: (2 min later) "Quick update — found 3 competitors so far:
       OpenAI Realtime, Hume AI, and ElevenLabs. Still digging."

Core: (3 min later) "Research is done. Five competitors documented
       with pricing, features, and latency benchmarks. Want me to
       read through the highlights or save it to a doc?"
```

---

## Security & Privacy

Continuous audio and video capture demands deliberate security and privacy design.

### Principles

- **User controls what the AI sees and hears** — camera, screen share, and system audio are opt-in per session
- **API keys stay local** — in local-first mode, keys never leave the user's machine
- **No persistent media storage** — audio and video frames are transient (processed and discarded)
- **Worker sandboxing** — code execution workers run in isolated containers
- **Transparent AI behavior** — watcher responses visible in UI so users can audit perception
- **Config file security** — `~/.neura/config.json` restricted to owner-only permissions

### Considerations per phase

| Phase          | Security concern                   | Mitigation                                              |
| -------------- | ---------------------------------- | ------------------------------------------------------- |
| **Current**    | API keys in config.json            | File permissions (chmod 600), OS keychain for desktop   |
| **Cloud core** | Audio/video transiting internet    | TLS everywhere, no server-side media persistence        |
| **Workers**    | Code execution, file system access | Docker sandboxing, resource limits, user approval gates |
| **Multi-user** | Data isolation between users       | Tenant isolation, scoped API keys, session boundaries   |
| **Enterprise** | Compliance (SOC2, GDPR)            | Audit logs, data residency, self-hosted deployment      |

---

## Competitive Landscape

| Project             | Stars | Voice         | Continuous Vision | Workers | Proactive  | Transport        |
| ------------------- | ----- | ------------- | ----------------- | ------- | ---------- | ---------------- |
| **Neura**           | —     | Native (Grok) | **Yes (watcher)** | Planned | Planned    | WebSocket        |
| OpenAI Realtime     | —     | Native        | No                | No      | No         | WebSocket/WebRTC |
| LiveKit Agents      | ~10k  | Native        | Partial           | Yes     | Yes        | WebRTC           |
| Pipecat             | ~11k  | Native S2S    | No                | Limited | Possible   | WebRTC           |
| OpenClaw            | ~340k | Bolted on     | No                | Yes     | Yes (cron) | Gateway WS       |
| CrewAI              | ~47k  | No            | No                | Yes     | Limited    | None             |
| AutoGen             | ~56k  | No            | No                | Yes     | Limited    | None             |
| Open Interpreter/01 | ~63k  | Push-to-talk  | No                | No      | No         | LiveKit          |

### Neura's differentiators

1. **Hybrid multi-model architecture** — Two real-time API sessions (voice + vision) with cross-querying via tool calls
2. **Continuous vision watcher** — Persistent Gemini Live session building 3-6 min temporal visual context
3. **Persistent daemon with CLI** — OS-native service management, not tied to any client's lifecycle
4. **Best-of-breed model selection** — Decoupled voice/vision lets you pick the best for each modality
5. **Product, not framework** — Opinionated experience vs toolkit

### Lessons from the landscape

| From               | Lesson                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| **autoresearch**   | Autonomous loop pattern — agent runs indefinitely, keeps/discards results, never stops          |
| **OpenClaw**       | Persistent gateway, heartbeat scheduler, `~/.openclaw/` config model, CLI + desktop coexistence |
| **LiveKit Agents** | Agent handoff patterns, proactive message generation                                            |
| **Letta/MemGPT**   | Cross-session persistent memory architecture                                                    |
| **CrewAI**         | YAML-based agent/task configuration, role-based delegation                                      |

---

## API Constraints & Known Limitations

| Constraint                   | Details                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **Grok session duration**    | Observed ~30-minute limit. Handled via proactive 28-min reconnect with transcript seeding       |
| **Grok concurrent sessions** | 100 per team (documented)                                                                       |
| **Gemini Live WS lifetime**  | ~10 minutes, then server sends GoAway. Handled via session resumption (2-hour handle validity)  |
| **Gemini video session**     | ~2 minutes without compression. Unlimited with sliding window compression                       |
| **Gemini response modality** | Native audio models only support AUDIO output. Watcher uses outputAudioTranscription workaround |
| **Gemini video frame rate**  | Max 1 FPS per API spec (current sends every 2s)                                                 |
| **Model identifiers**        | `gemini-3.1-flash-live-preview` and Grok model names are preview identifiers — may change       |

---

## Research Items

| Item                     | Question                                                                          | Priority |
| ------------------------ | --------------------------------------------------------------------------------- | -------- |
| **Smart glasses**        | Does Meta Ray-Ban SDK allow custom AI endpoints? Also investigate Brilliant Frame | Medium   |
| **System audio capture** | Best cross-platform approach (WASAPI / CoreAudio / PulseAudio)                    | High     |
| **Worker runtime**       | Claude agents vs custom LLM agents vs plugin system? MCP integration?             | High     |
| **WinSW integration**    | Complete Windows Service registration for `neura install`                         | High     |
| **Bun compile pipeline** | CI workflow for cross-platform standalone binaries                                | High     |
| **Proactive audio**      | Gemini experimental `proactiveAudio` — monitor for availability                   | Low      |
| **Auth/identity**        | OAuth, API key management, team/org model for cloud platform                      | Medium   |
| **Adaptive frame rate**  | Motion detection for intelligent FPS scaling                                      | Medium   |

---

## Phases

### Completed

#### Phase 1 — Foundation (prototypes)

- [x] Validate voice APIs (Gemini, Grok)
- [x] Validate hybrid architecture (Grok voice + Gemini vision)
- [x] Screen sharing + camera support
- [x] Watcher transparency in UI
- [x] Comprehensive roadmap

#### Phase 2a — Alpha (core extraction + hardening)

- [x] Extract hybrid prototype into `packages/core` (standalone server)
- [x] Define WebSocket protocol spec with typed messages (`@neura/types`)
- [x] Provider adapter layer (voice provider interface, vision provider interface)
- [x] Source-aware vision: tag frames with metadata (camera / screen)
- [x] Grok session recovery (reconnect, transcript seeding, 28-min proactive reconnect)
- [x] Watcher query queue (ID-based queue, sequential processing)
- [x] State layer (SQLite — session history, transcripts)
- [x] Structured logging (pino-based Logger in `@neura/utils`)
- [x] Session cost indicator in UI
- [x] Camera/screen/mic as independent opt-in toggles
- [x] Build `packages/ui` (React 19 + Vite 6 + Tailwind v4)
- [x] Build `packages/design-system` (10 components, 6 hooks, Storybook)

#### Phase 2b — MVP (desktop app + CLI)

- [x] Build `packages/desktop` (Electron, tray, hotkey, auto-update)
- [x] First-run wizard (secure API key storage, voice selection)
- [x] Build pipeline: electron-builder → .exe / .dmg / .AppImage
- [x] CI/CD pipeline: GitHub Actions → auto-build on release
- [x] Build `packages/cli` (`neura` CLI for service management)
- [x] Persistent core service architecture (launchd + systemd implemented; Windows: query/status only, install pending WinSW)
- [x] `/health` endpoint, config loading from `~/.neura/config.json`
- [x] Auto-port assignment (18000-19000 range)
- [x] Optional web UI static mount from `~/.neura/ui/`
- [x] Shared config schema in `@neura/types` (`NeuraConfigFile`)
- [x] 98+ unit tests across core + CLI
- [ ] Landing page at neura.ai (separate repo) + GitHub releases
- [ ] Bun compile release pipeline for standalone binaries
- [ ] WinSW integration for Windows Service registration

### Upcoming

#### Phase 3 — Memory & Identity ([detailed architecture](phase3-memory.md))

- [ ] Migrate sql.js → PGlite (WASM PostgreSQL 17 + pgvector)
- [ ] DataStore async migration (all methods → Promise-based)
- [ ] Auto-migrate existing `neura.db` SQLite data to PGlite
- [ ] Memory schema: identity, user_profile, facts, preferences, session_summaries
- [ ] Memory manager service layer (injection, extraction, recall)
- [ ] System prompt construction with token budget management
- [ ] Conversation boundary (idle timeout, not raw WS disconnect)
- [ ] Extraction pipeline (Gemini 2.5 Flash, ~$0.002/session)
- [ ] Vector embeddings (Gemini Embedding → pgvector `vector(768)`)
- [ ] Memory tools: `remember_fact`, `recall_memory`, `update_preference`
- [ ] Persistent conversation context across sessions

#### Phase 4 — Discovery Loop

- [ ] Heartbeat scheduler (configurable interval, default 30min)
- [ ] Heartbeat checklist (DB-stored, configurable via CLI or voice)
- [ ] Timer-based triggers
- [ ] Calendar integration (meeting prep, reminders)
- [ ] Webhook triggers (GitHub, email, external APIs)
- [ ] Vision-triggered checks (screen context change detection)
- [ ] Proactive voice notifications to connected clients
- [ ] Cost-optimized isolated heartbeat sessions

#### Phase 5 — Skill Registry

- [ ] Skill directory structure (`SKILL.md` with YAML frontmatter)
- [ ] Runtime skill loading (no recompilation)
- [ ] Extract existing tools into skill format
- [ ] User-installable skills from `~/.neura/skills/`
- [ ] Skill marketplace foundation
- [ ] Self-extensible: agent writes new skills autonomously

#### Phase 6 — Workers & Execution Loop

- [ ] Worker runtime and lifecycle management
- [ ] Execution loop (autonomous task completion)
- [ ] Built-in worker types: research, code, document, monitor
- [ ] Voice interaction with worker status
- [ ] Work item persistence and audit trail
- [ ] Worker sandboxing (Docker containers)
- [ ] Enable Grok's `web_search` and `x_search` tools
- [ ] File/document upload

#### Phase 7 — Cloud & Clients

- [ ] Cloud-hosted core (managed deployment, auth, teams)
- [ ] WebSocket auth (bearer token on upgrade handshake)
- [ ] Docker + docker-compose packaging
- [ ] Fly.io / Railway deployment guides
- [ ] Mode toggle: local / cloud / hybrid
- [ ] `packages/relay` for hybrid mode (local A/V proxy to cloud core)
- [ ] React Native mobile (`packages/mobile`)
- [ ] Browser extension (`packages/extension`)
- [ ] Worker marketplace

#### Phase 8 — Real-time Video & Specialized

- [ ] Real-time video mode (adaptive FPS, system audio, push-to-talk)
- [ ] VS Code extension (voice coding assistant)
- [ ] OBS plugin (stream AI overlay)
- [ ] Smart glasses research + prototype
- [ ] Enterprise features (self-hosted, SSO, compliance)

---

## Open Source Strategy

### Open core model

| Layer               | License                 | Rationale                                       |
| ------------------- | ----------------------- | ----------------------------------------------- |
| **Core engine**     | MIT                     | Open — builds community, trust, contributions   |
| **CLI + clients**   | MIT                     | Open — web, desktop, mobile, extensions         |
| **Worker runtime**  | MIT                     | Open — community-built workers expand ecosystem |
| **Cloud platform**  | Proprietary             | Closed — managed hosting, teams, enterprise     |
| **Premium workers** | Proprietary/marketplace | Specialized workers, verified integrations      |

### Business model (post-MVP)

| Revenue stream         | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| **Hosted platform**    | Managed Neura in the cloud — no setup, scales, team features  |
| **API metering**       | Pass-through LLM costs + margin for managed users             |
| **Worker marketplace** | Premium and third-party workers, revenue share                |
| **Enterprise**         | Self-hosted support, SSO, audit logs, compliance, SLA         |
| **Pro features**       | Advanced discovery triggers, priority workers, longer history |

### Ecosystem model

Neura is a standard, not a silo. Every layer is swappable:

```
Voice:    Grok (default) | OpenAI Realtime | ElevenLabs | local
Vision:   Gemini (default) | Claude | GPT-4V | local
Workers:  Built-in | MCP servers | Docker containers | HTTP webhooks
Storage:  SQLite (local) | Postgres (cloud) | Turso (edge)
```

All user data is exportable. Users bring their own API keys in local mode. Even on the hosted platform, they can export everything and self-host at any time.
