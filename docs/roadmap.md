# Neura Roadmap

## Vision

Neura is a proactive, autonomous AI operating system. It combines real-time voice conversation, continuous visual understanding, and autonomous worker agents — all driven by two core loops that make the system think and act on its own, not just react to user input.

---

## Current State (Prototypes)

Three prototypes validated the core I/O architecture:

| Prototype | What it proved |
|---|---|
| **gemini-live** | Gemini 3.1 Flash Live API works for real-time voice + function calling |
| **grok** | Grok Eve voice is the benchmark for naturalness and quality |
| **hybrid** | Grok Eve + Gemini watcher is the winning combo — voice + continuous vision with temporal context |

### Hybrid architecture (validated)

```
Camera/Screen (every 2s) → Server → Gemini Live WS (watcher, 3-6 min visual memory)
Mic audio → Server → Grok WS (Eve voice)
                       └─ tool call → text query to watcher → Grok speaks result
```

---

## Architecture: Monorepo Evolution

### Core design principle: network boundary between core and UI

The core is **always** a standalone server process. Clients connect to it via WebSocket. This single principle enables seamless transitions between local, cloud, and hybrid deployment — the UI only changes a URL.

```
UI knows one thing: a WebSocket URL
  ├── Local mode:   ws://localhost:3002/ws
  ├── Cloud mode:   wss://neura.example.com/ws
  └── Hybrid mode:  ws://localhost:3002/ws → relay → cloud core
```

The core has zero knowledge of Electron, browsers, or mobile apps. Clients have zero knowledge of Grok, Gemini, or workers. The WebSocket protocol is the only contract.

### Package structure

```
packages/
├── core/              # Standalone server — orchestrator, Grok session, Gemini watcher,
│                      #   tool system, discovery/execution loops, worker management.
│                      #   Runs the same whether spawned by Electron, Docker, or systemd.
├── ui/                # React web UI — takes a WebSocket URL as config, nothing else.
│                      #   Shared between desktop, web, and any embedded context.
├── desktop/           # Electron launcher — spawns core as child process, wraps ui,
│                      #   adds OS features (tray, hotkeys, auto-update, system audio).
│                      #   This is the MVP distribution (downloadable app).
├── shared/            # Types, audio codecs, protocol definitions, state interfaces
├── workers/           # Worker runtime, built-in worker types, MCP integrations
├── relay/             # Optional local relay for hybrid mode (low-latency A/V proxy)
├── mobile/            # React Native — reuses ui components, connects to core URL
├── extension/         # Browser extension
├── obs/               # OBS plugin/overlay
└── vscode/            # VS Code extension
prototypes/            # Experiments (keep for R&D)
docs/                  # Roadmap, architecture, ADRs
```

### How each package relates

```
┌─────────────────────────────────────────────────────────────────┐
│  desktop (Electron)                                             │
│  ├── Spawns core as child_process.fork()                        │
│  ├── Loads ui in BrowserWindow                                  │
│  ├── Adds: tray icon, global hotkey, system audio, auto-update  │
│  └── Settings UI: mode toggle (local / cloud / hybrid)          │
│         │                              │                        │
│         ▼                              ▼                        │
│    core (localhost:3002)          ui (renderer)                  │
│    ├── Grok WS (voice)           ├── Connects to ws://...       │
│    ├── Gemini WS (watcher)       ├── Audio I/O                  │
│    ├── Workers                   ├── Camera/screen capture      │
│    ├── Discovery/Exec loops      └── Transcript + tool results  │
│    └── SQLite                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Deployment mode transition

The same packages deploy in different configurations. No code changes, just where processes run:

| Mode | Core runs | UI connects to | Workers run | State layer |
|---|---|---|---|---|
| **Local (MVP)** | Electron spawns locally | `localhost:3002` | Child processes | SQLite |
| **Cloud** | Cloud server | `wss://neura.example.com` | Cloud containers | Postgres |
| **Hybrid** | Cloud server | Local relay → cloud | Cloud containers | Postgres |
| **Self-hosted** | Docker on user's server | User's domain | Docker containers | Postgres |

The user toggles modes in settings — no reinstall, no migration:

```
Settings → Mode:
  ○ Local    (runs on this machine, your API keys)
  ○ Cloud    (neura.ai — always on, multi-device, sign in)
  ○ Hybrid   (cloud brain + local audio/video speed)
```

### MVP distribution (desktop app)

The MVP ships as a downloadable desktop app, not a git repo:

```
Build pipeline:
  packages/core + packages/ui + packages/desktop
      ↓
  electron-builder
      ↓
  Neura-Setup-1.0.0.exe  (Windows, ~80-120MB)
  Neura-1.0.0.dmg        (Mac)
  Neura-1.0.0.AppImage   (Linux)
      ↓
  Published to neura.ai/download + GitHub releases
      ↓
  Auto-update channel for future versions
```

User experience:
```
1. Download from neura.ai
2. Install (like any app)
3. First-run wizard: enter API keys, pick voice
4. Click "Start" → tray icon appears
5. Talk, share screen, share camera — it just works
```

No terminal. No git. No npm. No .env files. The open source repo exists for contributors, but users never touch it.

### Core server abstraction

Every client connects via WebSocket to the core. The protocol is simple:

```
Client → Server:  audio, text, videoFrame, screenFrame
Server → Client:  audio, transcript, toolCall, toolResult, workerStatus, notification
```

Each client only implements: audio I/O, video capture (optional), and platform-specific UI.

### Transport strategy

**WebSocket now, WebRTC selectively later.**

WebSocket is the right starting point — LLM API latency (1-3 seconds) dwarfs the ~30ms transport difference vs WebRTC. WebSocket is simpler to deploy (any server, any CDN) and already proven in the prototypes.

| Phase | Transport | Why |
|---|---|---|
| **MVP** | WebSocket everywhere | Simple, works, ships fast |
| **Clients (mobile)** | Evaluate WebRTC for media | UDP handles flaky mobile networks better |
| **Real-time video** | WebRTC for high-FPS video | 30 FPS gaming/sports benefits from binary media transport |

When WebRTC is needed, adopt a hybrid approach: WebSocket for signaling/control/text, WebRTC for audio and video streams. The protocol layer stays the same — we just move heavy media to a faster pipe.

---

## I/O Roadmap

### Inputs

| Capability | Status | Description |
|---|---|---|
| Voice (mic) | Done | PCM audio → Grok via WebSocket relay |
| Camera video | Done | JPEG every 2s → Gemini watcher |
| Screen share | Done | JPEG every 2s → Gemini watcher (browser getDisplayMedia) |
| Text input | Done | Text box → Grok |
| File/document upload | Planned | Drag & drop PDF, image, code files for analysis |
| Clipboard | Planned | "Analyze what I just copied" — system clipboard access |
| System audio | Planned | Desktop audio capture (game sounds, video playing, music) |
| Web search | Planned | Enable Grok's native `web_search` and `x_search` tools |
| Webhooks | Planned | External events triggering the discovery loop |
| Scheduled triggers | Planned | Cron/timer-based discovery loop activation |

### Outputs

| Capability | Status | Description |
|---|---|---|
| Voice (Eve) | Done | Grok audio → speaker playback |
| Transcripts | Done | Input/output transcription in UI |
| Tool transparency | Done | Watcher responses visible in UI |
| Structured text | Planned | Code blocks, markdown, links rendered properly |
| Image generation | Planned | "Draw a diagram of this architecture" |
| File export | Planned | Save transcripts, export conversation history |
| Push notifications | Planned | Proactive alerts to connected clients |
| SMS/messaging | Planned | Text the user when they're not connected |
| Persistent memory | Planned | Conversation context across sessions |

---

## Pricing & Cost Analysis

### API pricing (as of March 2026)

| Provider | Model | Pricing model | Rate |
|---|---|---|---|
| **Grok Voice Agent** | Grok (Eve) | Flat per-minute (wall-clock) | $0.05/min ($3.00/hr) |
| **Gemini 3.1 Flash Live** | Watcher (vision) | Per-minute | Video in: $0.002/min, Audio in: $0.005/min, Audio out: $0.018/min |
| **Gemini 2.5 Flash** | Vision REST (fallback) | Per-token | $3.00/1M input, $2.00/1M output |

### Estimated session costs (hybrid prototype)

The hybrid runs two concurrent API sessions: Grok for voice (flat rate) and Gemini watcher for vision (per-minute video input). Since Grok handles all voice output, the Gemini watcher only incurs video input + occasional audio output costs when queried.

| Duration | Grok voice | Gemini watcher (video in) | Gemini query responses | **Total** |
|---|---|---|---|---|
| 5 min | $0.25 | $0.01 | ~$0.00 | **~$0.26** |
| 15 min | $0.75 | $0.03 | ~$0.01 | **~$0.79** |
| 30 min | $1.50 | $0.06 | ~$0.02 | **~$1.58** |
| 1 hour | $3.00 | $0.12 | ~$0.04 | **~$3.16** |

**Key notes:**
- Grok charges for wall-clock connection time (silence costs money)
- Gemini watcher video input is very cheap (~$0.12/hr)
- Gemini query responses cost audio output ($0.018/min) only for the seconds the watcher is actively responding — negligible
- Grok has an observed ~30 min session limit (not officially documented as a hard cap), requiring reconnection for longer sessions
- Gemini transcription (input/output) generates additional text output tokens on top of audio tokens — small but nonzero cost

### Cost transparency UX

The always-on Grok voice connection provides the best conversational experience but incurs wall-clock charges during silence. Rather than degrading UX with idle disconnects or push-to-talk modes, the product should be transparent:

- **Session cost indicator** — while connected, show a small, non-intrusive badge in the UI indicating the session is active and charges may apply (e.g., "Session active" with a subtle indicator)
- **Session summary** — when the user disconnects, optionally show estimated session cost based on duration
- **Settings control** — let users configure auto-disconnect timeout if they prefer cost savings over always-on availability

Future optimization: Gemini Live could serve as a cheaper always-on perception layer ($0.42/hr vs Grok's $3.00/hr for silence) since it charges per-token (silence = free). Grok would connect on-demand for voice responses only. This is architecturally viable but trades voice quality (Eve loses tone/emotion context from raw audio). Keeping full audio to Grok preserves the best experience.

---

## Client Platforms

### Tier 1 — Build first

| Client | Why | Key features |
|---|---|---|
| **Web** | Already built, universal access | Camera, screen share, full UI |
| **Electron desktop** | System-level access | Clipboard, system audio, global hotkey, tray icon |
| **React Native mobile** | Always-with-you assistant | Camera, push notifications, background audio |

### Tier 2 — High value

| Client | Why | Key features |
|---|---|---|
| **Browser extension** | Vision on any webpage without screen share | "Explain this page," overlay UI, context from active tab |
| **VS Code extension** | Coding assistant with voice + vision | Voice commands, sees your editor, explains errors, writes code |
| **OBS plugin/overlay** | Streaming/gaming buddy (see below) | Scene awareness, chat interaction, on-stream AI |

### Tier 3 — Explore

| Client | Why | Key features |
|---|---|---|
| **Discord bot** | Voice channel presence with vision | Screen share in calls, community interaction |
| **Smart glasses** | Camera + mic on your face (see research items) | Hands-free, always-on vision |
| **CLI/terminal** | Developer workflow | Voice in the terminal, pipe output to AI |
| **Car mode** | Hands-free, audio only | Simplified UI, driving-safe interaction |
| **Watch companion** | Quick voice queries | Tap to talk, status glances |
| **Embedded/kiosk** | Physical spaces | Raspberry Pi + camera, reception desk, workshop |

---

## Real-time Video Mode

An enhanced video mode for any scenario where real-time visual understanding is critical. The standard watcher (~0.5 FPS, one frame every 2 seconds) works for static or slow-moving content. This mode increases the frame rate, adds system audio capture, and optimizes for low-latency interaction.

### Requirements

| Requirement | Details |
|---|---|
| **Adaptive frame rate** | 2-5 FPS baseline, with motion detection to burst higher during fast action. Configurable per use case |
| **System audio capture** | Desktop audio alongside mic — AI hears what the user hears (game sounds, video dialogue, music) |
| **Push-to-talk option** | When system audio is active, VAD may false-trigger. Hotkey or controller button as alternative |
| **Non-intrusive responses** | Spatial audio or dedicated audio channel — don't talk over the content |
| **Context priming** | Tell the watcher what it's looking at ("this is a D&D RPG", "we're watching a sci-fi film", "this is a live dashboard") |
| **Low latency** | Watcher query + Grok response < 2-3 seconds |

### Use cases

**Gaming**
- "What should I do here?" — AI sees the game state and advises
- "Did you see that?" — temporal context means it actually saw it
- AI reacts to game events proactively (boss fight, death, achievement)
- Co-pilot mode — AI tracks objectives, inventory, map for the player
- Stream integration — AI overlay on stream, reacts to chat, scene-aware (OBS)

**Movie/TV watching**
- "Who is that actor?" — AI identifies from the frame
- "What just happened?" — AI has temporal context of the last few minutes
- "Explain that reference" — AI understands the scene in context
- Proactive trivia — AI shares relevant facts during slow moments

**Sports viewing**
- Real-time play analysis and stats
- Rules explanation as situations arise
- Historical context ("last time these teams met...")
- Highlight detection — AI flags key moments

**Education/lectures**
- Live note-taking from video lectures
- "Pause and explain that concept" — AI saw the slide/whiteboard
- Auto-summarize at the end of a lecture segment

**Work/productivity**
- Live dashboard monitoring with AI commentary
- Pair programming — AI watches your screen and offers suggestions
- Meeting assistant — AI watches the shared screen in a video call
- Remote assistance — technician shares camera, AI guides them

**Creative**
- Art/design review — "What do you think of this composition?"
- Music production — AI sees the DAW, hears the audio, gives feedback
- Video editing — AI watches the timeline and suggests cuts

---

## Worker System

Workers are autonomous agents spawned by the orchestrator to get real tasks done. The orchestrator tracks them in real-time and reports status to the user.

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

### Worker capabilities

Each worker is an autonomous agent with:
- **Specific task** with clear objectives and success criteria
- **Tool access** — web browsing, code execution, file system, APIs, MCP servers
- **Progress reporting** — streams status back to the orchestrator
- **Error handling** — retries, fallbacks, escalation to user
- **Sandboxed execution** — security boundary for code/shell tasks

### Worker lifecycle

```
Spawn → Running → [Checkpoint] → [Waiting for input] → Complete
                       ↓                   ↓
                  Report status       Prompt user
                  to orchestrator     via voice/notification
```

### Worker types (planned)

| Type | Description |
|---|---|
| **Research** | Web search, document analysis, competitive intelligence |
| **Code** | Write, test, and deploy code changes |
| **Document** | Draft emails, reports, summaries, presentations |
| **Monitor** | Watch deployments, dashboards, feeds — alert on changes |
| **Data** | ETL, analysis, visualization, database queries |
| **Communication** | Send emails, Slack messages, schedule meetings |
| **Integration** | API calls, webhook management, third-party service interaction |

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

## Discovery Loop

The discovery loop is what makes Neura proactive instead of reactive. It continuously evaluates context and decides if action is needed — without waiting for the user to ask.

### Trigger sources

| Source | Example |
|---|---|
| **Timer** | Every 5 minutes, check if any monitored dashboards changed |
| **Webhook** | GitHub push event → check if CI passed → notify user |
| **Calendar** | Meeting in 15 min → prep briefing doc, remind user |
| **Email/messages** | New urgent email → summarize and push audio notification |
| **Worker completion** | Research worker finished → report results to user |
| **Context change** | User opened a new app (vision) → offer relevant help |
| **External APIs** | Stock price hit threshold → alert user |
| **Scheduled** | Daily morning briefing, weekly summary |

### Decision engine

When triggered, the discovery loop evaluates context and decides:

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

### State management

```
Discovery loop → creates work items → stores in DB
                                         ├── Work item ID
                                         ├── Trigger source
                                         ├── Priority
                                         ├── Status
                                         ├── Assigned worker (if any)
                                         ├── Result/output reference
                                         └── Timestamps
```

---

## Execution Loop

The execution loop drives autonomous task completion. It ensures workers make progress, handles failures, and chains dependent tasks.

### Trigger sources

| Source | Example |
|---|---|
| **Timer** | Poll worker status every N seconds |
| **Worker event** | Worker reports progress, completion, or error |
| **Dependency resolution** | Task A completed → unblock Task B |
| **User input** | User approves/rejects worker output → next step |
| **Retry schedule** | Failed task → exponential backoff retry |

### Loop behavior

```
Check pending work items
    │
    ├── Worker idle? ──→ Assign next queued task
    │
    ├── Worker stuck? ──→ Retry, escalate, or reassign
    │
    ├── Worker done? ──→ Store result, notify orchestrator,
    │                     chain next task if dependent
    │
    ├── Needs approval? ──→ Queue for user review,
    │                       prompt via best available channel
    │
    └── All clear? ──→ Sleep until next trigger
```

### Execution guarantees

- **At-least-once** — failed tasks retry with backoff
- **Idempotent workers** — safe to re-run
- **Checkpointing** — workers save progress, can resume after crash
- **Timeout** — max execution time per worker, escalation on breach
- **Audit trail** — full history of decisions, actions, and outcomes in DB

---

## Deployment Strategy

### Architecture options

| Model | Description | Pros | Cons |
|---|---|---|---|
| **Cloud-hosted SaaS** | Core runs in cloud, clients connect via internet | Scales, no user setup, always updated | Latency, ongoing server costs, data leaves device |
| **Local-first** | Core runs on user's machine, connects to APIs directly | Lowest latency, privacy, no server costs | Requires setup, machine must be on, no mobile without LAN |
| **Hybrid** | Core in cloud for orchestration + workers, local relay for low-latency audio/video | Best of both, workers run 24/7 even when user is offline | More complex, two runtimes |
| **Edge/self-hosted** | User deploys their own instance (Docker, bare metal) | Full control, enterprise-friendly, air-gapped option | User manages infra |

### Recommended: Hybrid with local-first option

```
┌──────────────┐     ┌────────────────────────────┐
│ Local relay   │────→│ Cloud core                  │
│ (on machine)  │←────│ ├── Orchestrator             │
│               │     │ ├── Discovery/Execution loop │
│ ├── Audio I/O │     │ ├── Worker pool              │
│ ├── Video     │     │ ├── State layer (DB)         │
│ └── Low-lat   │     │ └── API connections          │
│    proxy      │     │     (Grok, Gemini)           │
└──────────────┘     └────────────────────────────┘
```

- **Local relay** handles latency-sensitive audio/video routing (on the user's machine or LAN)
- **Cloud core** runs the orchestrator, workers, discovery/execution loops, and state persistence
- **Local-first mode** available for users who want everything on their machine — core runs locally, connects to LLM APIs directly
- **Self-hosted option** for enterprise/privacy — Docker compose with everything bundled

### Infrastructure considerations

| Component | Cloud option | Local option |
|---|---|---|
| **Core server** | Fly.io, Railway, AWS ECS | Node.js process on user machine |
| **State layer** | Postgres (Supabase, Neon) | SQLite |
| **Worker runtime** | Cloud containers, serverless functions | Local processes, Docker |
| **File storage** | S3, R2 | Local filesystem |
| **WebSocket** | Cloud core with sticky sessions | localhost or LAN |
| **Auth** | OAuth, API keys | Local-only, no auth needed |

---

## MVP Definition

### Target user

Power users who want an AI assistant that sees, hears, and acts — not just chats. Early adopters comfortable with providing their own API keys, but who expect a real app experience, not a developer setup.

### MVP scope (what ships)

| Feature | Included | Notes |
|---|---|---|
| **Desktop app** | Yes | Electron — download, install, run. Win/Mac/Linux |
| **Voice conversation** | Yes | Grok Eve, natural conversation |
| **Camera vision** | Yes | Continuous watcher with temporal context |
| **Screen sharing** | Yes | Share screen, AI describes and discusses |
| **Function calling** | Yes | describe_camera, describe_screen, time, weather, dice |
| **Text input/output** | Yes | Fallback when voice isn't available |
| **Transcript + transparency** | Yes | See what the watcher tells the voice agent |
| **First-run wizard** | Yes | API key setup, voice selection, guided onboarding |
| **System tray** | Yes | Always-on, global hotkey to activate |
| **Auto-updates** | Yes | Push updates without reinstall |
| **Local-first** | Yes | Core runs on user's machine, bring your own API keys |
| Workers | No | Phase 3 |
| Discovery/Execution loops | No | Phase 3 |
| Mobile client | No | Phase 4 |
| Cloud mode | No | Phase 4 |
| Real-time video mode | No | Phase 5 |

### MVP user experience

```
1. Download Neura from neura.ai (or GitHub releases)
2. Install like any app
3. First-run wizard:
   ├── Enter Grok API key (with link to get one)
   ├── Enter Google API key (with link to get one)
   └── Choose voice (Eve is default)
4. Click "Start" → tray icon appears
5. Talk → Eve responds naturally
6. Share camera/screen → AI sees and discusses
7. Ask anything → voice + vision working together
```

No terminal. No git. No npm. No .env files.

### MVP success criteria

- End-to-end voice + vision conversation works reliably
- Session survives 10+ minutes without issues
- Watcher provides accurate, temporally-aware descriptions
- Latency feels conversational (< 3 second round-trip for vision queries)
- Install-to-first-conversation in under 3 minutes
- Works on Windows, Mac, Linux

---

## Open Source Strategy

### Recommendation: Open core

| Layer | License | Rationale |
|---|---|---|
| **Core engine** | MIT or Apache 2.0 | Open — builds community, trust, contributions. The orchestrator, protocol, and client SDKs |
| **Worker runtime** | MIT or Apache 2.0 | Open — community-built workers expand the ecosystem |
| **Clients** | MIT or Apache 2.0 | Open — web, mobile, desktop, extensions |
| **Cloud platform** | Proprietary | Closed — managed hosting, team features, enterprise features. This is the business model |
| **Premium workers** | Proprietary or marketplace | Specialized workers, verified integrations, premium tool access |

### Why open source

- **Community** — developers build clients, workers, integrations you'd never think of
- **Trust** — users can audit what the AI sees, hears, and does
- **Adoption** — low barrier to try, easy to extend, viral growth
- **Talent** — contributors become advocates and potential hires
- **Moat is not the code** — it's the hosted platform, worker ecosystem, and user experience

### Business model (post-MVP)

| Revenue stream | Description |
|---|---|
| **Hosted platform** | Managed Neura in the cloud — no setup, scales automatically, team features |
| **API metering** | Pass-through LLM costs + margin for managed users |
| **Worker marketplace** | Premium and third-party workers, revenue share |
| **Enterprise** | Self-hosted support, SSO, audit logs, compliance, SLA |
| **Pro features** | Advanced discovery loop triggers, priority worker execution, longer session history |

### Community building

- GitHub-first development, public roadmap
- Discord for community support and feature discussion
- Contributor-friendly: good docs, labeled issues, architecture decision records
- Showcase community-built workers and clients

---

## Ecosystem Model

### Open protocol, pluggable everything

Neura is a standard, not a silo. Every layer is swappable:

| Layer | Open/Closed | Why |
|---|---|---|
| **Protocol spec** | Open | Anyone can build compatible clients/servers |
| **Core engine** | Open (MIT) | Trust, contributions, adoption |
| **Provider adapters** | Open | Community adds voice/vision providers |
| **Worker SDK** | Open | Community builds workers — the app store |
| **Client SDK** | Open | Community builds clients for any platform |
| **Official clients** | Open | Web, desktop, mobile — reference implementations |
| **Hosted platform** | Closed | The business — managed infra, auth, teams |
| **Worker marketplace** | Curated | Open to publish, curated for quality |
| **Enterprise features** | Closed | SSO, audit logs, compliance, priority support |

### Pluggable providers

```
Voice:    Grok (default) | OpenAI Realtime | ElevenLabs | local
Vision:   Gemini (default) | Claude | GPT-4V | local
Workers:  Built-in | MCP servers | Docker containers | HTTP webhooks
Storage:  SQLite (local) | Postgres (cloud) | Turso (edge)
```

### Data portability — zero lock-in

All user data is exportable: conversation history, worker results, memory, configuration. Users bring their own API keys in local mode. Even on the hosted platform, they can export everything and self-host at any time.

---

## Competitive Landscape

### Key projects compared

| Project | Stars | Voice | Continuous Vision | Workers | Proactive | Transport |
|---|---|---|---|---|---|---|
| **Neura** | — | Native (Grok) | **Yes (watcher)** | Planned | Planned | WebSocket |
| OpenAI Realtime | — | Native | No | No | No | WebSocket/WebRTC |
| LiveKit Agents | ~10k | Native | Partial | Yes | Yes | WebRTC |
| Pipecat | ~11k | Native S2S | No | Limited | Possible | WebRTC |
| OpenClaw | ~340k | Bolted on | No | Yes | Yes (cron) | Gateway WS |
| CrewAI | ~47k | No | No | Yes | Limited | None |
| AutoGen | ~56k | No | No | Yes | Limited | None |
| AIOS | ~5k | No | No | Yes | No | None |
| Open Interpreter/01 | ~63k | Push-to-talk | No | No | No | LiveKit |
| Letta/MemGPT | ~22k | No | No | Subagents | No | REST |
| Bolna | ~600 | Telephony | No | No | Outbound | WebSocket |
| Agent Zero | ~17k | Whisper | Model-based | Hierarchical | Limited | None |

### Neura's differentiators

1. **Hybrid multi-model architecture** — Two real-time API sessions (voice + vision) with cross-querying via tool calls. No one else does this.
2. **Continuous vision watcher** — Persistent Gemini Live session building 3-6 min temporal visual context. Novel pattern not found in any other project.
3. **Best-of-breed model selection** — Decoupled voice/vision lets you pick the best for each modality.
4. **Lightweight transport** — Plain WebSockets, no LiveKit/WebRTC infrastructure required.
5. **Product, not framework** — Opinionated experience vs toolkit. Neura gives you the AI companion, not the building blocks.

### What to learn from the landscape

| From | Lesson |
|---|---|
| **LiveKit Agents** | Agent handoff patterns, proactive message generation, production multi-room |
| **OpenClaw** | Cron/webhook triggers (validates discovery loop), skills marketplace model |
| **Letta/MemGPT** | Cross-session persistent memory architecture |
| **Agent Zero** | Hierarchical agent spawning, SKILL.md standard for tool/skill packaging |
| **CrewAI** | YAML-based agent/task configuration, role-based delegation patterns |
| **Pipecat** | Provider abstraction layer, pipeline composition model |

---

## Security & Privacy

Continuous audio and video capture demands deliberate security and privacy design.

### Principles

- **User controls what the AI sees and hears** — camera, screen share, and system audio are opt-in per session
- **API keys stay local** — in local-first mode, keys never leave the user's machine
- **No persistent media storage** — audio and video frames are transient (processed and discarded, not stored)
- **Worker sandboxing** — code execution workers run in isolated containers with no access to the host system
- **Transparent AI behavior** — watcher responses are visible in the UI so users can audit what the AI perceives

### Considerations for each phase

| Phase | Security concern | Mitigation |
|---|---|---|
| **MVP** | API keys in .env files | Document best practices, .gitignore enforcement |
| **Cloud core** | Audio/video transiting the internet | TLS everywhere, no server-side media persistence |
| **Workers** | Code execution, file system access | Docker sandboxing, resource limits, user approval gates |
| **Multi-user** | Data isolation between users | Tenant isolation in DB, scoped API keys, session boundaries |
| **Enterprise** | Compliance (SOC2, GDPR) | Audit logs, data residency options, self-hosted deployment |

### Privacy by design

- Vision watcher context is ephemeral (sliding window, oldest frames are discarded)
- Conversation transcripts are opt-in to persist
- No telemetry or analytics without explicit consent
- Self-hosted option for users who want zero data leaving their network

---

## API Constraints & Known Limitations

| Constraint | Details |
|---|---|
| **Grok session duration** | Observed ~30-minute limit (not officially documented as a hard cap). No session resumption mechanism |
| **Grok concurrent sessions** | 100 per team (documented) |
| **Gemini Live WS lifetime** | ~10 minutes, then server sends GoAway. Handled via session resumption (2-hour handle validity) |
| **Gemini video session** | ~2 minutes without compression. Unlimited with sliding window compression enabled |
| **Gemini response modality** | Native audio models (3.1 Flash Live) only support AUDIO output, not TEXT. Watcher uses outputAudioTranscription as workaround |
| **Gemini video frame rate** | Max 1 FPS per API spec (current prototype sends every 2s) |
| **Model identifiers** | `gemini-3.1-flash-live-preview` and Grok model names are preview identifiers — may change before GA |
| **Frame source ambiguity** | Camera and screen frames are sent to the watcher without source metadata. Both appear as generic JPEGs. The watcher infers source from visual content, which may be unreliable when both are active |

---

## Research Items

| Item | Question | Priority |
|---|---|---|
| **Smart glasses** | Does Meta Ray-Ban SDK allow custom AI endpoints? Alternative: phone companion app as relay. Also investigate Brilliant Frame and open hardware | Medium |
| **System audio capture** | Best cross-platform approach (WASAPI on Windows, CoreAudio on Mac, PulseAudio on Linux) | High |
| **Worker runtime** | Claude agents vs custom LLM agents vs plugin system? MCP server integration pattern? | High |
| **State layer** | SQLite for local? Postgres for cloud? Event sourcing for audit trail? | High |
| **Session resumption** | Grok's observed ~30-min session limit (not officially documented) — how to maintain conversation continuity across reconnects? | Medium |
| **Proactive audio** | Gemini has experimental `proactiveAudio` — monitor for availability on 3.1 | Low |
| **Deployment infra** | Evaluate Fly.io vs Railway vs AWS for cloud core. Docker compose for self-hosted | Medium |
| **Auth/identity** | OAuth providers, API key management, team/org model for cloud platform | Medium |
| **Adaptive frame rate** | Motion detection algorithms for intelligent FPS scaling (low for static, high for action) | Medium |

---

## Phases

### Phase 1 — Foundation (current)
- [x] Validate voice APIs (Gemini, Grok)
- [x] Validate hybrid architecture (Grok voice + Gemini vision)
- [x] Screen sharing + camera support
- [x] Watcher transparency in UI
- [x] Comprehensive roadmap
- [ ] Commit and stabilize prototypes

### Phase 2a — Alpha (core extraction + hardening)
- [ ] Extract hybrid prototype into `packages/core` (standalone server)
- [ ] Define WebSocket protocol spec with typed messages (`packages/shared`)
- [ ] Provider adapter layer (voice provider interface, vision provider interface)
- [ ] Source-aware vision: tag frames with metadata (`camera` / `screen`) — not merged streams
- [ ] Grok session recovery (reconnect on disconnect, context seeding from recent transcript)
- [ ] Watcher query queue (replace single `pendingQuery` with ID-based queue)
- [ ] State layer (SQLite — session history, settings, permissions)
- [ ] Structured event logging for debugging
- [ ] Session cost indicator in UI (active session badge)
- [ ] Camera/screen/mic as independent opt-in toggles (not auto-start)
- [ ] Remove mock tools (mock weather, dice) — replace with real or remove
- [ ] Build `packages/ui` (React, from prototype `public/` — rebuild, don't port)
- [ ] **Ship alpha: single OS, stable sessions, source-aware vision**

### Phase 2b — MVP (desktop app)
- [ ] Build `packages/desktop` (Electron launcher, spawns core, wraps ui)
- [ ] First-run wizard (secure API key storage, voice selection)
- [ ] System tray + global hotkey
- [ ] Auto-update via electron-updater
- [ ] Build pipeline: electron-builder → .exe / .dmg / .AppImage
- [ ] Cross-platform testing (Windows, Mac, Linux)
- [ ] Landing page at neura.ai + GitHub releases
- [ ] **Ship MVP: downloadable desktop app, open source, bring-your-own API keys**

### Phase 3 — Workers + Loops
- [ ] Worker runtime and lifecycle management
- [ ] Discovery loop (timer + webhook triggers)
- [ ] Execution loop (autonomous task completion)
- [ ] Built-in worker types: research, code, document, monitor
- [ ] Voice interaction with worker status
- [ ] Work item persistence and audit trail
- [ ] Enable Grok's `web_search` and `x_search` tools
- [ ] File/document upload

### Phase 4 — Cloud + Clients
- [ ] Cloud-hosted core (managed deployment, auth, teams)
- [ ] Mode toggle: local / cloud / hybrid (in desktop app settings)
- [ ] `packages/relay` for hybrid mode (local A/V proxy to cloud core)
- [ ] React Native mobile (`packages/mobile`)
- [ ] Browser extension (`packages/extension`)
- [ ] Persistent conversation memory (cross-session)
- [ ] Worker marketplace foundation

### Phase 5 — Real-time Video + Specialized
- [ ] Real-time video mode (adaptive FPS, system audio, push-to-talk)
- [ ] VS Code extension (voice coding assistant)
- [ ] OBS plugin (stream AI overlay)
- [ ] Smart glasses research + prototype
- [ ] Enterprise features (self-hosted, SSO, compliance)
