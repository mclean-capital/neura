# Neura CLI & Persistent Core Service

> Implementation spec for `neura` CLI, persistent core daemon, and client coexistence model.

## Overview

Neura Core becomes a standalone OS-managed background service. The `neura` CLI is the primary interface for installing, configuring, and managing it. Any client (desktop, web, mobile) connects to the running core over WebSocket — no client owns the core lifecycle.

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

---

## Install Paths

Two equivalent install methods — both produce the same result.

### Path 1: Shell Script (no prerequisites)

```bash
# macOS / Linux
curl -fsSL https://neura.sh/install | bash

# Windows PowerShell
irm https://neura.sh/install.ps1 | iex
```

The shell script:

1. Detects OS (`uname -s`) and architecture (`uname -m`)
2. Downloads the CLI binary from GitHub releases
3. Downloads the Core binary from GitHub releases
4. Places both in `~/.neura/bin/` and `~/.neura/core/`
5. Adds `~/.neura/bin` to PATH (appends to shell rc files)
6. Runs `neura install` (interactive wizard + service registration)

Windows variant (`install.ps1`) uses `irm`/`iex`, detects arch via registry, modifies PATH via `[Environment]::SetEnvironmentVariable`.

### Path 2: npm Global Install (developers)

```bash
npm install -g @neura/cli
neura install
```

Requires Node.js >= 22. The `neura install` command downloads the core binary from GitHub releases at install time.

### End State (both paths)

```
~/.neura/
├── config.json              # API keys, port, voice, preferences
├── core/
│   └── neura-core(.exe)     # Core binary (from GitHub releases)
├── ui/                      # Pre-built web UI (optional, from GitHub releases)
│   ├── index.html
│   └── assets/
├── bin/
│   └── neura(.exe)          # CLI binary (shell script install only)
├── pgdata/                  # PGlite data directory (WASM Postgres + pgvector)
├── logs/
│   ├── core.log             # Core stdout (rolling)
│   └── core.error.log       # Core stderr
├── service/                 # Platform-specific service config (generated)
│   ├── neura-core.xml       # Windows: winsw config
│   ├── com.neura.core.plist # macOS: launchd plist
│   └── neura-core.service   # Linux: systemd unit
└── pgdata/                  # PGlite data directory (WASM Postgres + pgvector)
                             # Stores sessions, transcripts, memory, facts, preferences
```

---

## Binary Distribution

### Build: Bun Compile

All binaries are standalone executables built via `bun build --compile`. Cross-compiled from CI for all platforms in a single job.

```bash
# CLI binary
bun build packages/cli/src/index.ts --compile \
  --target=bun-<os>-<arch> --outfile neura-cli

# Core binary
bun build packages/core/src/server/server.ts --compile \
  --target=bun-<os>-<arch> --outfile neura-core
```

### Release Assets (GitHub Releases)

```
neura-cli-linux-x64.tar.gz
neura-cli-linux-arm64.tar.gz
neura-cli-darwin-x64.tar.gz
neura-cli-darwin-arm64.tar.gz
neura-cli-windows-x64.zip
neura-core-linux-x64.tar.gz
neura-core-linux-arm64.tar.gz
neura-core-darwin-x64.tar.gz
neura-core-darwin-arm64.tar.gz
neura-core-windows-x64.zip
```

Naming convention: `neura-{component}-{os}-{arch}.{tar.gz|zip}`

### Download at Install Time

When `neura install` runs (whether from npm or shell script), it:

1. Checks if `~/.neura/core/neura-core` exists and its version
2. Resolves latest version from GitHub API (`/releases/latest`)
3. Downloads the platform-correct core binary
4. Extracts to `~/.neura/core/`
5. Verifies with a health check after service start

`neura update` repeats steps 2-5 for both CLI and core binaries.

---

## Configuration Model

### `~/.neura/config.json`

```json
{
  "port": 18742,
  "voice": "eve",
  "apiKeys": {
    "xai": "sk-...",
    "google": "AI..."
  },
  "service": {
    "autoStart": true,
    "logLevel": "info"
  }
}
```

**Security:** File permissions restricted to owner-only (`chmod 600` on Unix, ACL-restricted on Windows). Same model as `~/.docker/config.json`, `~/.aws/credentials`, `~/.openclaw/openclaw.json`.

### Port Strategy

Ports are assigned differently depending on deployment mode:

| Mode                    | Default                                              | Override                    | Stored Where           |
| ----------------------- | ---------------------------------------------------- | --------------------------- | ---------------------- |
| **Local (CLI install)** | Auto-assigned (first free port in 18000-19000 range) | `neura config set port <n>` | `~/.neura/config.json` |
| **Cloud / Docker**      | `3002`                                               | `PORT` env var              | Environment            |
| **Dev (`npm run dev`)** | `3002`                                               | `.env` / `PORT` env var     | Environment            |

**Local auto-assignment:** During `neura install`, the CLI scans the 18000-19000 range for a free port (randomized start to avoid multi-install collisions). This avoids clashing with common dev server ports (3000-9000). The user can override at install time or anytime via `neura config set port <number>`.

**Cloud predictable default:** Docker and cloud stay at 3002 because containers own their network namespace (no clashes) and load balancers need a known port. Override with `PORT` env var.

**Client discovery:** Every client finds the port the same way — read `~/.neura/config.json` → `port` field. No hardcoded ports in client code.

### Config Priority (in core)

```
PORT env var  >  config.json port  >  3002 (fallback default)
```

This means:

- **Local (OS service):** Reads port from `config.json` (set during install)
- **Docker/cloud:** `PORT` env var overrides everything
- **Development:** `.env` file via dotenv (existing behavior preserved)

### Core Config Loading

New file: `packages/core/src/config/config.ts`

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function loadConfig() {
  const neuraHome = process.env.NEURA_HOME || join(homedir(), '.neura');
  const configPath = join(neuraHome, 'config.json');

  let file: Record<string, any> = {};
  if (existsSync(configPath)) {
    file = JSON.parse(readFileSync(configPath, 'utf-8'));
  }

  return {
    port: int(process.env.PORT) ?? file.port ?? 3002,
    apiKeys: {
      xai: process.env.XAI_API_KEY ?? file.apiKeys?.xai ?? '',
      google: process.env.GOOGLE_API_KEY ?? file.apiKeys?.google ?? '',
    },
    voice: process.env.NEURA_VOICE ?? file.voice ?? 'eve',
    pgDataPath: process.env.PG_DATA_PATH ?? file.pgDataPath ?? join(neuraHome, 'pgdata'),
    neuraHome,
  };
}
```

---

## Service Registration

### Windows — winsw (via node-windows)

```xml
<!-- ~/.neura/service/neura-core.xml -->
<service>
  <id>neura-core</id>
  <name>Neura Core</name>
  <description>Neura AI assistant core service</description>
  <executable>{NEURA_HOME}\core\neura-core.exe</executable>
  <workingdirectory>{NEURA_HOME}</workingdirectory>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>3</keepFiles>
  </log>
  <onfailure action="restart" delay="5 sec"/>
  <env name="NEURA_HOME" value="{NEURA_HOME}"/>
</service>
```

- Requires admin (UAC prompt fires automatically via node-windows)
- Service appears in Windows Services Manager
- Auto-restarts on crash with exponential backoff

### macOS — launchd Agent

```xml
<!-- ~/Library/LaunchAgents/com.neura.core.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.neura.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>{NEURA_HOME}/core/neura-core</string>
  </array>
  <key>WorkingDirectory</key><string>{NEURA_HOME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{NEURA_HOME}/logs/core.log</string>
  <key>StandardErrorPath</key><string>{NEURA_HOME}/logs/core.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NEURA_HOME</key><string>{NEURA_HOME}</string>
  </dict>
</dict>
</plist>
```

- User-level agent (no sudo required)
- Starts on login, auto-restarts via KeepAlive
- Managed via `launchctl load/unload`

### Linux — systemd User Service

```ini
# ~/.config/systemd/user/neura-core.service
[Unit]
Description=Neura Core Service
After=network.target

[Service]
Type=simple
ExecStart={NEURA_HOME}/core/neura-core
WorkingDirectory={NEURA_HOME}
Restart=on-failure
RestartSec=5
Environment=NEURA_HOME={NEURA_HOME}

[Install]
WantedBy=default.target
```

- User-level service (no root required)
- Managed via `systemctl --user enable/start/stop`
- Auto-restarts on failure

### Service Lifecycle Commands (mapped to OS primitives)

| CLI Command     | Windows                           | macOS                        | Linux                                 |
| --------------- | --------------------------------- | ---------------------------- | ------------------------------------- |
| `neura start`   | `sc start neura-core`             | `launchctl load -w <plist>`  | `systemctl --user start neura-core`   |
| `neura stop`    | `sc stop neura-core`              | `launchctl unload <plist>`   | `systemctl --user stop neura-core`    |
| `neura restart` | stop + start                      | unload + load                | `systemctl --user restart neura-core` |
| `neura status`  | `sc query neura-core` + `/health` | `launchctl list` + `/health` | `systemctl --user status` + `/health` |

---

## Health Endpoint

Add to `packages/core/src/server/server.ts`:

```typescript
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    port: PORT,
    version: process.env.npm_package_version ?? 'unknown',
  });
});
```

Used by:

- `neura status` — checks if core is alive
- `neura install` — verifies service started successfully
- Desktop app — probes before connecting WebSocket
- Docker `HEALTHCHECK` — container health monitoring
- Cloud load balancers — routing decisions

---

## CLI Commands

### Full Command Reference

```bash
# Install & setup
neura install                    # Interactive wizard + service registration
neura uninstall                  # Remove service, optionally clean ~/.neura

# Service lifecycle
neura start                      # Start the core service
neura stop                       # Stop the core service
neura restart                    # Restart the core service
neura status                     # Running state, port, uptime, health

# Configuration
neura config set <key> <value>   # Set a config value
neura config get <key>           # Get a config value
neura config list                # Show all config (keys redacted)
neura config path                # Print ~/.neura path

# Utilities
neura logs                       # Tail core logs (follow mode)
neura logs --lines 100           # Last N lines
neura open                       # Open web UI in default browser
neura update                     # Download latest core binary
neura version                    # Show CLI + core versions
```

### `neura install` Flow

```
$ neura install

  Neura Core — Setup

  Platform:  Windows 11 (x64)
  Home:      C:\Users\donmc\.neura

  ▸ API Keys
    XAI_API_KEY: sk-▏
    GOOGLE_API_KEY: AI▏

  ▸ Port
    ✓ Auto-assigned: 18742
    Custom port? (leave blank to keep): ▏

  ▸ Voice
    Voice (eve): ▏

  ▸ Downloading core v1.2.0...
    ✓ neura-core-windows-x64.exe → ~/.neura/core/
    ✓ Web UI → ~/.neura/ui/

  ▸ Registering service...
    ✓ "Neura Core" registered as Windows Service
    ✓ Auto-start: enabled

  ▸ Starting core...
    ✓ Core running on ws://localhost:18742
    ✓ Health check: ok (uptime 2s)

  ▸ Config saved to ~/.neura/config.json

  Done! Connect with any client:
    Desktop:  Open the Neura desktop app
    Web:      neura open
    Status:   neura status
    Logs:     neura logs
```

### `neura status` Output

```
$ neura status

  Neura Core
  Status:    running ●
  Port:      18742
  Uptime:    2h 14m
  Health:    ok
  Version:   1.2.0
  Home:      ~/.neura
  PID:       12847
  Service:   Windows Service (auto-start: enabled)
```

---

## Desktop App Coexistence

### Principle: Desktop Attaches, Doesn't Own

The desktop app (Electron) connects to a running core — it never spawns or manages the core process. This mirrors the OpenClaw model where the macOS app attaches to the Gateway.

### Desktop Startup Flow

```
app.ready
  │
  ├─ Read port from ~/.neura/config.json (or default 3002)
  │
  ├─ Probe GET http://localhost:{port}/health
  │    │
  │    ├─ 200 OK → Core is running
  │    │    └─ Connect WebSocket → Show UI
  │    │
  │    └─ Connection refused → Core not running
  │         └─ Show setup screen:
  │              "Neura Core is not running."
  │              [Install Core]  — runs neura install flow inline
  │              [Open Terminal]  — instructions to run neura install
  │              [Start Core]    — runs neura start if already installed
```

### Changes to Desktop Package

| File              | Change                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `core-manager.ts` | Replace spawn logic with health-check + attach. Remove `fork()`/`spawn()` entirely.                                         |
| `store.ts`        | Read API keys and port from `~/.neura/config.json`. Keep desktop-only settings (hotkey, window position) in electron-store. |
| `SetupWizard.tsx` | Write to `~/.neura/config.json`. Can register service directly (shared logic from CLI).                                     |
| `index.ts`        | Remove `startCore()` call. Add health probe on startup.                                                                     |

### Config Split

| Setting                          | Location               | Why                            |
| -------------------------------- | ---------------------- | ------------------------------ |
| API keys, port, voice            | `~/.neura/config.json` | Shared across all clients      |
| Hotkey, window position, theme   | electron-store         | Desktop-specific UI preference |
| Launch at login, start minimized | electron-store         | Desktop-specific OS preference |

---

## Web UI Serving

Core serves the web UI as an optional static file mount. This keeps core deployment-agnostic — it works without a UI (API-only for cloud/headless) but serves one when present.

### How It Works

If `~/.neura/ui/` exists and contains an `index.html`, core serves it:

```typescript
// In server/server.ts
const uiDir = join(config.neuraHome, 'ui');
if (existsSync(join(uiDir, 'index.html'))) {
  app.use(express.static(uiDir));
  app.get('*', (_req, res, next) => {
    if (req.path.startsWith('/health') || req.path.startsWith('/ws')) return next();
    res.sendFile(join(uiDir, 'index.html')); // SPA fallback
  });
}
```

When no UI is installed, `GET /` returns a JSON info response:

```json
{
  "name": "Neura Core",
  "status": "running",
  "ws": "ws://localhost:18742/ws",
  "health": "/health",
  "ui": "not installed — run `neura update` to download"
}
```

### Install Flow

`neura install` downloads both the core binary and the pre-built UI bundle:

```
neura install
  ├── Downloads core binary → ~/.neura/core/neura-core
  ├── Downloads UI bundle   → ~/.neura/ui/index.html, assets/
  └── Registers service

neura open → opens http://localhost:{port} → serves from ~/.neura/ui/
```

### Release Assets

UI assets are distributed alongside core binaries in GitHub releases:

```
neura-ui.tar.gz              # Platform-independent (just HTML/JS/CSS)
neura-core-linux-x64.tar.gz  # Platform-specific
...
```

### `neura open`

Opens the web UI in the default browser:

- Reads port from `~/.neura/config.json`
- Probes `/health` to verify core is running
- Opens `http://localhost:{port}` in browser

---

## Cloud Deployment

Same core binary, different lifecycle wrapper.

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY neura-core .
ENV NEURA_HOME=/data
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3002/health').then(r=>r.ok?process.exit(0):process.exit(1))"

CMD ["./neura-core"]
```

```yaml
# docker-compose.yml
services:
  neura-core:
    build: .
    restart: unless-stopped
    ports:
      - '3002:3002'
    volumes:
      - neura-data:/data
    environment:
      - XAI_API_KEY=${XAI_API_KEY}
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
      - PG_DATA_PATH=/data/pgdata
      - NEURA_HOME=/data

volumes:
  neura-data:
```

### Fly.io / Railway

Deploy the Docker image. WebSocket support works natively. Config via platform env vars.

### Cloud Authentication (Required Before Cloud Deploy)

Core currently accepts any WebSocket connection. Before cloud deployment, add:

- Bearer token auth on WebSocket upgrade handshake
- Token configured via `config.json` or `NEURA_AUTH_TOKEN` env var
- Clients pass token in `Authorization` header or `?token=` query param

---

## Package Structure

### New: `packages/cli` (`@neura/cli`)

```
packages/cli/
├── src/
│   ├── index.ts                 # Entry point, commander setup
│   ├── commands/
│   │   ├── install.ts           # Interactive wizard + service registration
│   │   ├── uninstall.ts         # Service removal + cleanup
│   │   ├── start.ts             # Start service
│   │   ├── stop.ts              # Stop service
│   │   ├── restart.ts           # Restart service
│   │   ├── status.ts            # Health check + service state
│   │   ├── config.ts            # Get/set/list configuration
│   │   ├── logs.ts              # Tail log files
│   │   ├── update.ts            # Download latest binaries
│   │   ├── version.ts           # Show versions
│   │   └── open.ts              # Open web UI in browser
│   ├── service/
│   │   ├── manager.ts           # Cross-platform dispatcher
│   │   ├── windows.ts           # winsw/node-windows registration
│   │   ├── macos.ts             # launchd plist generation
│   │   ├── linux.ts             # systemd unit generation
│   │   └── detect.ts            # OS detection, elevation check
│   ├── config.ts                # Load/save ~/.neura/config.json
│   ├── health.ts                # HTTP health check client
│   └── download.ts              # GitHub release asset downloader
├── package.json
└── tsconfig.json
```

### Dependencies

```json
{
  "dependencies": {
    "commander": "^13.0.0",
    "@inquirer/prompts": "^7.0.0",
    "chalk": "^5.0.0",
    "node-windows": "^1.0.0",
    "@neura/types": "workspace:*"
  }
}
```

`node-windows` is only needed on Windows — conditionally imported.
macOS and Linux use direct file generation (no external deps).

---

## Implementation Phases

### Phase 1: Foundation (this PR)

1. **`packages/cli`** — Package scaffold, command structure, config loading
2. **`/health` endpoint** — Add to core server
3. **`config.ts` in core** — Load from `~/.neura/config.json` with env var override
4. **`neura install`** — Interactive wizard, writes config, downloads core (placeholder: no service registration yet, just starts core directly)
5. **`neura start/stop/status`** — Direct process management (kill/spawn) as stepping stone

### Phase 2: OS Service Registration

6. **Windows service** — winsw via node-windows, UAC handling
7. **macOS agent** — launchd plist generation + launchctl
8. **Linux service** — systemd unit generation + systemctl
9. **`neura uninstall`** — Service removal per platform

### Phase 3: Binary Distribution

10. **Bun compile CI** — GitHub Actions workflow for cross-platform builds
11. **`install.sh`** — Shell installer script (macOS/Linux)
12. **`install.ps1`** — PowerShell installer script (Windows)
13. **`neura update`** — Self-update mechanism for CLI + core binaries
14. **GitHub release automation** — Tag → build → upload assets

### Phase 4: Desktop Adaptation

15. **Remove core-manager spawn logic** — Replace with health probe + attach
16. **Shared config** — Desktop reads `~/.neura/config.json` for keys/port
17. **Setup wizard** — Can run `neura install` flow inline if core not found
18. **Config split** — Desktop-only settings stay in electron-store

### Phase 5: Cloud & Auth

19. **Dockerfile + docker-compose.yml** — Container packaging
20. **WebSocket auth** — Bearer token on upgrade handshake
21. **`neura config set auth_token`** — Token management
22. **Cloud deploy docs** — Fly.io, Railway, self-hosted guides

---

## Design Decisions

| Decision            | Choice                                                       | Rationale                                                              |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Install methods     | curl/irm script + npm global                                 | Covers end users (no Node.js) and developers                           |
| Binary format       | Bun compile                                                  | Cross-compile from CI, no runtime deps, proven (Claude Code uses this) |
| Core distribution   | GitHub releases, downloaded at install time                  | Keeps CLI small, independent update cycles                             |
| Config location     | `~/.neura/` (dotdir)                                         | Industry standard (Docker, AWS, OpenClaw)                              |
| Config format       | JSON                                                         | Simple, no parser deps, editable by hand                               |
| API key storage     | Plaintext + restricted file permissions                      | CLI standard; encrypted keychain is optional future enhancement        |
| Windows service     | node-windows (winsw)                                         | Proven, handles UAC, intelligent restart                               |
| macOS service       | launchd plist (direct generation)                            | No deps, user-level agent, no sudo                                     |
| Linux service       | systemd unit (direct generation)                             | No deps, user-level service, no root                                   |
| Desktop coexistence | Attach to running core                                       | OpenClaw model — service is primary, UI is disposable                  |
| Config sharing      | `~/.neura/config.json` for core, electron-store for UI prefs | Clean separation of shared vs. per-client state                        |
| Cloud config        | Env vars override config.json                                | Standard container pattern, zero changes to core                       |
| Local port          | Auto-assigned in 18000-19000 range                           | Avoids dev server clashes; user can override                           |
| Cloud port          | Default 3002, override via PORT env                          | Containers own their namespace; LBs need known port                    |
| Web UI serving      | Optional static mount from `~/.neura/ui/`                    | Core stays API-only by default; UI is a drop-in                        |

---

## References

- [OpenClaw architecture](https://github.com/openclaw/openclaw) — Gateway daemon, `~/.openclaw/`, CLI + desktop coexistence
- [Bun install script](https://bun.sh/install) — Shell/PowerShell installer pattern
- [Bun compile docs](https://bun.com/docs/bundler/executables) — Standalone binary generation
- [node-windows](https://github.com/coreybutler/node-windows) — Windows Service registration
- [Docker Desktop model](https://docs.docker.com/engine/daemon/) — CLI + daemon coexistence via socket/port
