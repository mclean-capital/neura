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

### Run the hybrid prototype

```bash
git clone https://github.com/mclean-capital/neura.git
cd neura
npm install

# Set up your API keys
cp prototypes/hybrid/.env.example prototypes/hybrid/.env
# Edit .env with your XAI_API_KEY and GOOGLE_API_KEY

# Start the hybrid prototype
npm run dev -w @neura/hybrid-live
```

Open [http://localhost:3002](http://localhost:3002), click the mic button, and start talking to Eve. Share your camera or screen and ask "what do you see?"

### Other prototypes

```bash
npm run dev -w @neura/gemini-live    # Gemini voice only (localhost:3000)
npm run dev -w @neura/grok-live      # Grok voice only (localhost:3001)
```

## Project Structure

```
prototypes/
├── gemini-live/     # Gemini 3.1 Flash Live API — voice + function calling
├── grok/            # Grok Voice Agent API — Eve voice
└── hybrid/          # Grok Eve voice + Gemini continuous vision watcher
docs/
└── roadmap.md       # Full roadmap and architecture
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
