# @mclean-capital/neura

> Neura CLI — install, manage, and talk to the Neura AI assistant from your terminal.

Neura is a proactive, autonomous AI operating system. It combines real-time voice conversation, continuous visual understanding, and autonomous worker agents. This CLI installs and manages the Neura core service, and also acts as a full client via `neura chat` and `neura listen`.

## Install

```bash
npm install -g @mclean-capital/neura
```

Requires Node.js >= 22.

## Quick start

```bash
neura install     # interactive setup: API keys, auto-port, service registration
neura start       # start the core service
neura chat        # text chat with Neura from your terminal
neura listen      # voice chat (mic + speaker)
```

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
