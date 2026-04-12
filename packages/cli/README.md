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

### Supported platforms

| Platform                            | Supported |
| ----------------------------------- | :-------: |
| macOS — Apple Silicon (M1/M2/M3/M4) |    Yes    |
| macOS — Intel (x64)                 |  **No**   |
| Windows — x64 / arm64               |    Yes    |
| Linux — x64 / arm64                 |    Yes    |

**Intel Macs are not supported.** Neura's wake-word detector runs on
`onnxruntime-node`, and upstream dropped Intel Mac (`darwin/x64`) binaries
starting with version 1.24. Because voice is a required feature — not an
optional one — `npm install -g @mclean-capital/neura` will appear to
succeed but core will crash at startup with
`Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'`.

If you're on an Apple Silicon Mac but see the `darwin/x64` error, you've
installed the Intel build of Node under Rosetta. Reinstall Node as arm64:

```bash
nvm uninstall <version>
arch -arm64 nvm install <version>
```

For true Intel Macs, there's no workaround short of self-building against
an older onnxruntime-node — we recommend running Neura on a supported
machine instead.

## Quick start

```bash
neura install     # interactive setup: API keys, auto-port, service registration
                  # (auto-starts the core service)
neura listen      # voice chat (mic + speaker, wake-word ready)
# OR:
neura chat        # text chat from your terminal
```

After `neura install` completes, core runs as a background OS service — launchd on macOS, systemd on Linux, a Scheduled Task (or Startup folder shim as fallback) on Windows. Say your wake word — by default **"neura"** — and Neura activates a voice session. Stop talking for 5 minutes and it drops back to passive listening.

### Windows notes

Windows doesn't have a clean "run as background service" path for a voice-first assistant. A proper Windows Service (via `sc.exe`, nssm, or WinSW) runs in **Session 0**, which is isolated from every interactive user session and cannot access the user's microphone or audio devices — a hard blocker for wake-word detection. So on Windows we use a per-user **Scheduled Task** instead, registered by `schtasks.exe` with `/SC ONLOGON /RL LIMITED`. No UAC prompt, no admin rights, no bundled binaries.

If `schtasks /Create` refuses (some corporate / GPO-locked Windows configurations require elevation even for user-level tasks), `neura install` transparently falls back to a `neura-core.cmd` launcher in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`. The core still starts on next logon — `neura install` will tell you which path was taken so you know what to expect.

Trade-offs you should know about on Windows:

- **The core only runs while you're logged in.** When you log out, it stops; when you log back in, Windows starts it again. There's no pre-login boot. If you need 24/7 availability, use macOS or Linux.
- **Status telemetry is thinner** than a real service. `neura status` reports up/down by pid, but there's no Windows event-log integration or automatic crash-restart policy beyond "start fresh on next logon".
- **The Task Scheduler path is manageable from the GUI.** Open Task Scheduler and look for `neura-core` under the top-level Task Scheduler Library. If you took the Startup folder fallback, the shim is at the path above — delete the file to disable.

`neura config set` works normally on Windows. The launcher shim only exports `NEURA_HOME`, so the core re-reads `config.json` on every restart — same behavior as macOS and Linux. Changes take effect on the next `neura restart` without needing `neura install`.

## Update

```bash
neura update
```

**Always use `neura update`** to upgrade. It stops the running core before calling `npm install -g @mclean-capital/neura@latest` so the old core's native binaries (`onnxruntime_binding.node`, `onnxruntime.dll`) aren't file-locked when npm tries to replace them. After the install completes it re-registers the service and starts the new core automatically.

**Do not run `npm install -g @mclean-capital/neura` directly while the core is running.** On Windows, the running core holds exclusive file locks on its loaded native binaries, and npm will emit noisy `EPERM: operation not permitted` warnings when it can't clean up the temp directory it swapped out. The install still succeeds but the warnings are alarming and the old core stays running on the port through the upgrade, which can confuse the re-registration step. If you need to install manually for any reason, stop the core first:

```bash
neura stop
npm install -g @mclean-capital/neura@latest
neura install   # re-registers service, starts new core
```

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
