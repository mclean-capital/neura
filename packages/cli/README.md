# @mclean-capital/neura

> **A voice-first, proactive AI operating system.** Say the wake word and talk to Neura from any device — no click-to-start, no tap-to-speak.

Neura is a self-hosted AI assistant that runs as a persistent background service on your machine. It's always listening for the wake word via on-device ONNX inference (zero cloud cost while passive), streams voice conversations via Grok's Eve voice when active, and continuously watches your camera or screen through a Gemini Live vision watcher. It remembers what you've talked about across sessions, manages your tasks, and proactively reminds you about deadlines.

This package is the full Neura distribution: **the CLI, the core service, and all runtime dependencies** ship together as one npm install. No separate downloads, no matching platform tarballs — one command installs everything.

## Install

```bash
npm install -g @mclean-capital/neura
```

This fetches the CLI **plus** the bundled core service and its native dependencies (`onnxruntime-node` for wake-word detection, `@electric-sql/pglite` for local storage). If `onnxruntime-node` fails to install, the whole install fails loudly — voice is a required feature, not an optional one.

Requires **Node.js >= 22**.

## Quick start

```bash
neura install     # interactive setup: API keys, auto-port, service registration
                  # (auto-starts the core service)
neura listen      # voice chat (mic + speaker, wake-word ready)
# OR:
neura chat        # text chat from your terminal
```

After `neura install` completes, core runs as a background OS service (launchd on macOS, systemd on Linux). Say your wake word — by default **"jarvis"** — and Neura activates a voice session. Stop talking for 5 minutes and it drops back to passive listening.

## Update

```bash
neura update
# equivalent to: npm install -g @mclean-capital/neura@latest && neura restart
```

The `neura update` command runs `npm install -g @mclean-capital/neura@latest` and restarts the core service so the new version takes effect.

### Upgrading from v1.10.x or earlier

v1.11.0 moved the core service bundle from a separate GitHub release tarball into the CLI's npm package itself. Older CLIs expect the tarball layout and **cannot self-update to v1.11.0**. If you're on v1.10.x and `neura update` prints a 404 or "Download failed" error, bootstrap manually:

```bash
npm install -g @mclean-capital/neura@latest
neura install   # rewrites service file to point at the new bundled core path
```

After this one-time step, `neura update` works normally for all future upgrades.

## Commands

### Setup & service lifecycle

| Command           | Description                                |
| ----------------- | ------------------------------------------ |
| `neura install`   | Interactive setup wizard + service install |
| `neura start`     | Start the core service                     |
| `neura stop`      | Stop the core service                      |
| `neura restart`   | Restart the core service                   |
| `neura status`    | Show service status, port, uptime, health  |
| `neura update`    | Download the latest core binary            |
| `neura uninstall` | Remove service and optionally clean data   |

### Client commands

| Command        | Description                                 |
| -------------- | ------------------------------------------- |
| `neura chat`   | Interactive text chat over WebSocket        |
| `neura listen` | Voice chat (mic capture + speaker playback) |
| `neura open`   | Open the web UI in your default browser     |

### Configuration & data

| Command                        | Description                  |
| ------------------------------ | ---------------------------- |
| `neura config list`            | Show all configuration       |
| `neura config set <key> <val>` | Set a config value           |
| `neura config get <key>`       | Get a config value           |
| `neura logs`                   | Tail core service logs       |
| `neura backup`                 | Create a memory backup       |
| `neura restore`                | Restore memories from backup |

## Voice client notes

`neura listen` uses optional native audio dependencies:

- **`decibri`** — microphone capture via PortAudio
- **`speaker`**, **`@picovoice/pvspeaker-node`**, or **`sox`** — speaker playback

These are marked as `optionalDependencies` so `npm install -g @mclean-capital/neura` won't fail if your platform lacks the required build tools. If audio init fails at runtime, `neura listen` will print install instructions for your platform.

## API keys

Neura uses:

- **xAI (Grok)** — voice conversation. Get a key at [console.x.ai](https://console.x.ai/).
- **Google (Gemini)** — vision watcher, memory embeddings, wake word transcription. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Both keys are set during `neura install` and stored in `~/.neura/config.json` with restricted file permissions.

## Security

- The core server binds to `localhost` only — not exposed on the LAN.
- All WebSocket and HTTP requests require a 256-bit bearer token auto-generated on install.
- The token is stored in `~/.neura/config.json` (Unix `0600` permissions).
- `neura chat`, `neura listen`, `neura open`, `neura backup`, and `neura restore` automatically load and pass the token.

## Links

- **Full README**: https://github.com/mclean-capital/neura#readme
- **Roadmap**: https://github.com/mclean-capital/neura/blob/main/docs/roadmap.md
- **Issues**: https://github.com/mclean-capital/neura/issues

## License

MIT © McLean Capital
