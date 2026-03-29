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

### Run Neura

```bash
git clone https://github.com/mclean-capital/neura.git
cd neura
npm install

# Set up your API keys
cp packages/core/.env.example packages/core/.env
# Edit .env with your XAI_API_KEY and GOOGLE_API_KEY

# Start core + UI (two terminals)
npm run dev -w @neura/core    # Core server at http://localhost:3002
npm run dev -w @neura/ui      # UI at http://localhost:5173
```

Open [http://localhost:5173](http://localhost:5173), click **Start Session**, then toggle the mic. Share your camera or screen and ask "what do you see?"

## Project Structure

```
packages/
├── shared/      # Protocol types, tool types, audio constants
├── core/        # Voice session, vision watcher, tools, server
└── ui/          # React 19 + Vite 6 + Tailwind v4 app
docs/
└── roadmap.md   # Full roadmap and architecture
```

## Development

```bash
npm run typecheck       # typecheck all packages (turbo)
npm run lint            # lint all packages (turbo)
npm run lint:fix        # lint + autofix (turbo)
npm run format          # format all files (prettier)
npm run format:check    # check formatting (prettier)
npm run test            # run tests (turbo + vitest)
npm run build           # build all packages (turbo)
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). Enforced by commitlint + husky.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the full roadmap covering:

- Monorepo architecture and core/ui separation
- I/O roadmap (file upload, clipboard, system audio, web search)
- Client platforms (desktop app, mobile, browser extension, VS Code, OBS)
- Real-time video mode (gaming, movies, sports, education)
- Worker system (autonomous agents for research, code, documents)
- Discovery and execution loops (proactive AI behavior)
- Deployment strategy (local-first, cloud, hybrid, self-hosted)
- Open source ecosystem model
- Competitive landscape analysis

## License

MIT
