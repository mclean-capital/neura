# Neura

A proactive, autonomous AI operating system. Real-time voice conversation, continuous visual understanding, and autonomous worker agents — driven by discovery and execution loops that think and act on their own.

## How It Works

Neura uses a hybrid multi-model architecture: **Grok** handles voice conversation (Eve voice) while **Gemini** runs as a continuous vision watcher that builds temporal visual context. The two are bridged via tool calls — when you ask "what do you see?", the voice model queries the watcher, which has been watching your camera or screen the entire time.

```
Camera/Screen (every 2s) → Gemini Live (watcher, 3-6 min visual memory)
Mic audio → Grok (Eve voice)
                └─ tool call → text query to watcher → Grok speaks result
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- A [Grok API key](https://console.x.ai/) (xAI)
- A [Google API key](https://aistudio.google.com/apikey) (Gemini)

### Setup

```bash
git clone https://github.com/mclean-capital/neura.git
cd neura
npm install

# Set up your API keys
cp packages/core/.env.example packages/core/.env
# Edit .env with your XAI_API_KEY and GOOGLE_API_KEY
```

### Run the Web UI

```bash
# Two terminals:
npm run dev -w @neura/core    # Core server → http://localhost:3002
npm run dev -w @neura/ui      # Web UI → http://localhost:5173
```

Open [http://localhost:5173](http://localhost:5173), click **Start Session**, toggle the mic. Share your camera or screen and ask "what do you see?"

### Run the Desktop App

```bash
npm run dev -w @neura/desktop   # Starts core + renderer + Electron
```

## Project Structure

```
packages/
├── types/          # Pure types — protocol, tools, config, provider/store interfaces
├── utils/          # Shared runtime — Logger (pino), audio/frame constants
├── design-system/  # Shared React components, hooks, CSS tokens, Storybook
├── core/           # Voice providers, vision providers, stores, tools, server
├── ui/             # Web client — React 19 + Vite 6 + Tailwind v4
└── desktop/        # Desktop client — Electron, spawns core, own React renderer
docs/
└── roadmap.md      # Full roadmap and architecture
```

## Command Reference

### Development

| Command                         | Description                                    |
| ------------------------------- | ---------------------------------------------- |
| `npm run dev -w @neura/core`    | Start core server (port 3002)                  |
| `npm run dev -w @neura/ui`      | Start web UI dev server (port 5173)            |
| `npm run dev -w @neura/desktop` | Start desktop app (core + renderer + Electron) |

### Code Quality

| Command                | Description                    |
| ---------------------- | ------------------------------ |
| `npm run typecheck`    | Typecheck all packages (turbo) |
| `npm run lint`         | Lint all packages (turbo)      |
| `npm run lint:fix`     | Lint + autofix (turbo)         |
| `npm run format`       | Format all files (prettier)    |
| `npm run format:check` | Check formatting (prettier)    |
| `npm run test`         | Run all tests (turbo + vitest) |

### Build

| Command                           | Description                               |
| --------------------------------- | ----------------------------------------- |
| `npm run build`                   | Build all packages (turbo)                |
| `npm run build -w @neura/types`   | Build types                               |
| `npm run build -w @neura/core`    | Build core (tsc + esbuild bundle)         |
| `npm run build -w @neura/desktop` | Build desktop (renderer + main + preload) |

### Release

| Command                          | Description                              |
| -------------------------------- | ---------------------------------------- |
| `npm run release:win`            | Full build + Windows installer (.exe)    |
| `npm run release:mac`            | Full build + macOS installer (.dmg)      |
| `npm run release:linux`          | Full build + Linux installer (.AppImage) |
| `npm run pack -w @neura/desktop` | Build unpacked app (for testing)         |

Release outputs are written to `packages/desktop/release/`.

### Single-Package Commands

| Command                            | Description         |
| ---------------------------------- | ------------------- |
| `npm run test -w @neura/core`      | Run core tests only |
| `npm run test -w @neura/ui`        | Run UI tests only   |
| `npm run lint -w @neura/desktop`   | Lint desktop only   |
| `npm run typecheck -w @neura/core` | Typecheck core only |

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by commitlint + husky
- All UI/visual decisions follow `DESIGN.md`
- Each client platform owns its own UI — clients share only `@neura/types`

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the full roadmap covering:

- Monorepo architecture and core/ui separation
- I/O roadmap (file upload, clipboard, system audio, web search)
- Client platforms (desktop app, mobile, browser extension, VS Code, OBS)
- Real-time video mode (gaming, movies, sports, education)
- Worker system (autonomous agents for research, code, documents)
- Discovery and execution loops (proactive AI behavior)
- Deployment strategy (local-first, cloud, hybrid, self-hosted)

## License

MIT
