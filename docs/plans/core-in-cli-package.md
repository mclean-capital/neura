# Plan: Bundle Core Into the CLI npm Package (Alt E)

**Status:** Draft — pending review
**Target version:** v1.11.0
**Author:** 2026-04-10

---

## Positioning

**Neura is voice-first.** Wake-word detection is a core feature, not a nice-to-have. `onnxruntime-node` is a required runtime dependency — the install either fully succeeds (voice works) or fails loudly. There is no "graceful degradation without voice" path. If a user can't install `onnxruntime-node`, they can't use Neura — and we want them to know that immediately, not discover it silently at the first wake attempt.

---

## Problem

The current architecture has two distribution channels:

1. **CLI** — published to npm as `@mclean-capital/neura`, small (~50 kB)
2. **Core** — published to GitHub releases as platform-specific tarballs (`neura-core-{os}-{arch}.tar.gz`)

On `neura install`, the CLI downloads the core tarball from GitHub releases into `~/.neura/core/`. The core tarball currently ships `server.bundled.mjs` + a copy of `@electric-sql/pglite`, but **nothing else**. When the core starts, it crashes because `onnxruntime-node` is missing:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'onnxruntime-node'
```

This was caught by the first real end-to-end soft-launch test (user's MacBook Pro Intel, Node 24.14.1 via nvm).

### Secondary issues we want to fix at the same time

1. **Two distribution channels are strictly worse than one.** Every update requires bumping both the CLI on npm and the core on GitHub releases, keeping them in sync. The failure mode we just hit was exactly this kind of sync bug — the core-build workflow forgot to copy a required native dep.

2. **Shipped core `package.json` references workspace deps** (`@neura/types`, `@neura/utils`). If anyone runs `npm install` inside `~/.neura/core/`, it 404s on those private workspace packages. Same class of bug we fixed in the CLI itself.

3. **The core-build workflow is fragile** — it builds a Linux-based tarball and hand-copies individual dependency files. Adding any new native dep requires workflow changes. This is the opposite of how modern Node CLIs ship.

4. **No deterministic dep tree** — even if we fixed the missing copy, every user's core would depend on whatever happened to be in `packages/core/node_modules` when the tarball was assembled.

---

## Decision: Alt E (bundle core into the CLI npm package)

After researching how [OpenClaw](https://github.com/openclaw/openclaw) distributes its similar local-first AI assistant via npm (187 MB unpacked, 26K files, single package with all deps, `optionalDependencies` only for truly-optional features), the clearly-best option is to **eliminate the GitHub release tarball for core entirely** and ship the core bundle + all its runtime dependencies inside the CLI's npm package.

### Architecture after this change

```
@mclean-capital/neura/                          ← single npm package, no more GitHub tarball
├── dist/                                       ← CLI compiled output
│   ├── index.js
│   ├── commands/ ...
│   ├── service/ ...
│   └── ...
├── core/                                       ← core bundle, shipped IN the CLI package
│   ├── server.bundled.mjs
│   ├── server.bundled.mjs.map
│   ├── stores/
│   │   └── *.js
│   └── version.txt
├── LICENSE
├── README.md
└── package.json                                ← CLI deps + core runtime deps combined
```

Installed globally via `npm install -g @mclean-capital/neura@latest`:

```
$NVM_NODE/lib/node_modules/@mclean-capital/neura/
├── dist/
├── core/
├── node_modules/                               ← npm resolves everything at install time
│   ├── onnxruntime-node/                       ← native binaries auto-fetched for platform
│   ├── @electric-sql/pglite/
│   ├── @google/genai/
│   ├── express/
│   └── ...
├── LICENSE
├── README.md
└── package.json
```

### Why this is the right call

|                               | Old (two-artifact)                              | New (Alt E)                                             |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Artifacts                     | CLI on npm + 5 core tarballs on GitHub releases | **Single CLI package on npm**                           |
| Missing native deps possible? | Yes (the bug we hit)                            | **No — npm resolves full tree**                         |
| Cross-platform natives        | Manual per-platform copy logic in CI            | **Standard npm install**                                |
| Update flow for user          | `neura update` (custom download)                | **`npm install -g @mclean-capital/neura@latest`**       |
| CI complexity                 | `core-build.yml` + matrix + copy logic          | **Just publish the CLI**                                |
| Determinism                   | Whatever was in CI's node_modules at build      | **Lockfile-based resolution**                           |
| Versioning                    | CLI version must sync to core release tag       | **One version, one source of truth**                    |
| How similar projects ship     | Rare                                            | **OpenClaw, OpenCode, esbuild, swc, sharp** all do this |
| Wake word detection           | Silently broken if workflow misses a copy       | **Either fully works or install fails loudly**          |

### Trade-offs (honest)

| Trade-off                                                 | Impact                                                                                     | Acceptable?                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| CLI npm package grows from ~50 kB to ~200-250 MB unpacked | Larger download on first install                                                           | **Yes** — OpenClaw ships 187 MB and is successful. This is the industry norm for native-dep-heavy CLIs. |
| Longer initial `npm install -g` (download + extract)      | ~20-40s vs current ~5s                                                                     | **Yes** — one-time cost, no per-install surprises                                                       |
| Disk footprint ~250 MB in global node_modules             | Same as runtime-install option                                                             | **Yes** — normal for native-dep CLIs                                                                    |
| Lose the ability to independently version core and CLI    | CLI and core always ship together                                                          | **Yes** — we already version them together in practice                                                  |
| Desktop app's core bundling is now divergent from CLI     | Desktop still uses electron-builder to package core; no longer uses GitHub release tarball | **Yes** — desktop already has its own flow via electron-builder                                         |

---

## Implementation Plan

### Phase 1 — Merge core runtime deps into CLI's `package.json`

**File:** `packages/cli/package.json`

**Add `dependencies`:**

Everything in `packages/core/package.json` that isn't a `@neura/*` workspace dep:

```json
{
  "dependencies": {
    // Existing CLI deps
    "@inquirer/prompts": "^7",
    "chalk": "^5",
    "commander": "^13",
    "ws": "^8.20.0",

    // Core runtime deps (newly added)
    "@electric-sql/pglite": "<version>",
    "@google/genai": "<version>",
    "dotenv": "<version>",
    "express": "<version>",
    "onnxruntime-node": "<version>",
    "pino": "<version>"
  }
}
```

Exact versions come from the current `packages/core/package.json`. Pin them exactly (no `^`) so the bundled core always runs against known-good dep versions.

**Update `files` array** to include the `core/` directory:

```json
"files": ["dist", "core", "README.md", "LICENSE"]
```

### Phase 2 — Ship core bundle inside the CLI package

**New build step in `packages/cli/package.json`:**

```json
"scripts": {
  "build": "tsc -p tsconfig.build.json && npm run build:bundle-core",
  "build:bundle-core": "node ../../tools/bundle-core-into-cli.mjs"
}
```

**New file:** `tools/bundle-core-into-cli.mjs`

```js
#!/usr/bin/env node
/**
 * Copy the core build output into the CLI package's `core/` directory
 * so it ships inside @mclean-capital/neura on npm.
 *
 * Called from packages/cli's build script after tsc finishes.
 * Prerequisite: packages/core must already be built
 * (turbo handles this via the workspace build graph).
 */

import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORE_DIST = join(ROOT, 'packages/core/dist');
const CLI_CORE = join(ROOT, 'packages/cli/core');

if (!existsSync(CORE_DIST)) {
  console.error('Core dist not found. Run `turbo run build --filter=@neura/core` first.');
  process.exit(1);
}

// Clean
rmSync(CLI_CORE, { recursive: true, force: true });
mkdirSync(CLI_CORE, { recursive: true });

// Copy bundle + sourcemap
cpSync(join(CORE_DIST, 'server.bundled.mjs'), join(CLI_CORE, 'server.bundled.mjs'));
cpSync(join(CORE_DIST, 'server.bundled.mjs.map'), join(CLI_CORE, 'server.bundled.mjs.map'));

// Copy stores (dynamically imported, not bundled by esbuild)
const storesSrc = join(CORE_DIST, 'stores');
const storesDst = join(CLI_CORE, 'stores');
if (existsSync(storesSrc)) {
  cpSync(storesSrc, storesDst, { recursive: true });
}

// Write version marker (synced from root package.json by the release workflow)
const rootPkg = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(await import('fs').then((fs) => fs.readFileSync(join(ROOT, 'package.json'))))
  )
);
writeFileSync(join(CLI_CORE, 'version.txt'), rootPkg.version + '\n');

console.log(`Bundled core into ${CLI_CORE}`);
```

**Updated `packages/cli/tsconfig.build.json`:**

No change needed — dist/ already excludes the new `core/` directory because tsc only processes `src/`.

**Turbo task graph** (`turbo.json`):

Already wires `@mclean-capital/neura:build` to depend on `^build`, which will build `@neura/core` first. Verify no additional changes needed.

### Phase 3 — Rewrite CLI's core path resolution

**File:** `packages/cli/src/download.ts` — rewrite `getCoreBinaryPath()` and `hasCoreBinary()` to look inside the CLI's own install location instead of `~/.neura/core/`.

```ts
import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * Return the path to the core bundle shipped inside the CLI's npm package.
 *
 * The CLI's built output lives at:
 *   $NPM_GLOBAL/lib/node_modules/@mclean-capital/neura/dist/commands/install.js
 *
 * The core bundle lives at:
 *   $NPM_GLOBAL/lib/node_modules/@mclean-capital/neura/core/server.bundled.mjs
 *
 * From any dist/*.js file, the core is at ../core/server.bundled.mjs.
 */
export function getCoreBinaryPath(): string {
  // __dirname for ESM: derive from import.meta.url
  const currentFile = fileURLToPath(import.meta.url);
  const cliDistDir = dirname(currentFile); // .../dist/
  return resolve(cliDistDir, '..', 'core', 'server.bundled.mjs');
}

export function hasCoreBinary(): boolean {
  return existsSync(getCoreBinaryPath());
}

export function getInstalledCoreVersion(): string | null {
  const versionFile = join(dirname(getCoreBinaryPath()), 'version.txt');
  if (!existsSync(versionFile)) return null;
  return readFileSync(versionFile, 'utf-8').trim();
}
```

**Delete from `download.ts`:** `downloadCore()`, `getLatestVersion()`, `getPlatformTarget()`. They're no longer needed.

### Phase 4 — Update `neura install` command

**File:** `packages/cli/src/commands/install.ts`

Remove the "download core binary" section entirely — core is shipped with the CLI. Just confirm `hasCoreBinary()` returns true (sanity check) and proceed to service registration.

```ts
// Sanity check — core should always be present because it ships in the npm package
if (!hasCoreBinary()) {
  console.log(
    chalk.red(
      '  ✗ Core binary not found at expected location. This indicates a broken\n' +
        '    installation. Try: npm install -g @mclean-capital/neura@latest'
    )
  );
  return;
}
```

Service registration logic stays the same — it points at `getCoreBinaryPath()` which now returns the path inside the npm install.

### Phase 5 — Rewrite `neura update` command

**File:** `packages/cli/src/commands/update.ts`

Update becomes "tell the user to npm install and restart the service":

```ts
import chalk from 'chalk';
import { execSync } from 'child_process';
import { getServiceManager } from '../service/manager.js';

export async function updateCommand(): Promise<void> {
  console.log(chalk.dim('  Updating Neura...'));
  console.log();
  console.log(chalk.dim('  Running: npm install -g @mclean-capital/neura@latest'));

  try {
    execSync('npm install -g @mclean-capital/neura@latest', {
      stdio: 'inherit',
    });
  } catch {
    console.log(chalk.red('  ✗ npm install failed. Check your network or run manually.'));
    return;
  }

  console.log(chalk.dim('  Restarting core service...'));
  try {
    const svc = await getServiceManager();
    svc.restart();
    console.log(chalk.green('  ✓ Neura updated and restarted'));
  } catch (err) {
    console.log(
      chalk.yellow(
        '  Update complete but restart failed: ' +
          (err instanceof Error ? err.message : String(err))
      )
    );
    console.log(chalk.dim('  Run `neura restart` manually.'));
  }
}
```

### Phase 6 — Delete the GitHub release core tarball pipeline

**Delete:** `.github/workflows/core-build.yml`

**Update:** `.github/workflows/release.yml` — remove the `core-build` job that calls `core-build.yml`.

**Update:** `packages/core/package.json` — move `@neura/types`, `@neura/utils` to `devDependencies` so any future `npm install` in core doesn't 404. This is defense in depth; the new architecture never runs `npm install` in core directly.

### Phase 7 — Tests

1. **CLI tests** — update any tests that reference `downloadCore` or `~/.neura/core/` to reflect the new resolution path.

2. **Integration smoke test** (new):
   - Build the CLI
   - Pack it via `npm pack`
   - Extract to a temp dir
   - Verify `core/server.bundled.mjs` exists
   - Verify `package.json` lists `onnxruntime-node` as a hard dependency
   - Verify `dist/index.js` is present and executable

3. **`tools/bundle-core-into-cli.mjs`** — minimal smoke test that runs the script after a core build.

### Phase 8 — Docs

1. **`packages/cli/README.md`** — update the install section:

   ```bash
   # Install (one command, downloads CLI + core + voice dependencies)
   npm install -g @mclean-capital/neura

   # Set up config, register service, start core
   neura install

   # Update later:
   neura update   # runs npm install under the hood
   ```

2. **Root `README.md`** — lead with the voice-first positioning:

   > **Neura is a voice-first AI operating system.** Talk to it with a wake word from any device — no click-to-start, no tap-to-speak.

3. **`CLAUDE.md`** — note that core is bundled into the CLI and core-build tarballs are deprecated.

### Phase 9 — Release

Ship as **v1.11.0** via semantic-release. `feat(cli):` commit triggers a minor bump. Pipeline:

1. Semantic-release commits `1.11.0` version bump
2. CLI publish workflow (now the only publish workflow):
   - Checkout tag
   - Sync version
   - `turbo run build --filter=@neura/core` (builds core bundle)
   - `turbo run build --filter=@mclean-capital/neura` (builds CLI + runs bundle-core step)
   - Strip devDependencies
   - `npm publish --access public --provenance` via OIDC

First user-visible install:

```bash
npm install -g @mclean-capital/neura@latest
neura install
# → voice works immediately because onnxruntime-node is resolved via standard npm install
```

---

## Voice-First Guarantees

To make sure we never regress on "voice works or install fails":

### 1. `onnxruntime-node` is in `dependencies`, not `optionalDependencies`

If npm can't install it (no native binary for the user's platform, disk full, network dropped), **the entire `npm install -g @mclean-capital/neura` fails with a clear error**. The user never ends up with a half-broken install where voice silently doesn't work.

### 2. Core imports `onnxruntime-node` at the top level, not lazily

```ts
// packages/core/src/presence/onnx-wake-detector.ts
import * as ort from 'onnxruntime-node'; // stays as a direct import
```

If the import fails at core startup, the core process crashes immediately with a clear error, the launchd service marks it as failed, and `neura install`'s health check reports "Core did not respond." The user knows something is broken.

### 3. Pin exact version of `onnxruntime-node`

```json
"onnxruntime-node": "1.22.0"   // no caret, no tilde
```

This prevents transitive dep drift between users and ensures the wake-word model files match the runtime version.

### 4. `neura install` tests wake detection during the health check

After the health check confirms core is running, `neura install` can optionally call `/health` and check a new field like `wakeDetection: "active" | "disabled"`. If it's not active, show a yellow warning:

```
✓ Core running on ws://localhost:18841
⚠ Wake detection is disabled — voice activation will not work
  Check: neura logs | grep -i onnx
```

This turns a silent failure into a visible one.

### 5. `version.txt` ships with the core bundle

So `neura version` always reports the correct core version even though it's now resolved from the CLI package's install location.

---

## Risks & Mitigations

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                         |
| -------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Users on unsupported platforms can't install `onnxruntime-node`      | Low        | High   | Document exact supported platforms in README; fail loudly at `npm install -g`                                                      |
| CLI package size concerns users                                      | Medium     | Low    | 200-250 MB is normal; OpenClaw is 187 MB; document in README                                                                       |
| `npm install -g` hangs on slow connections                           | Low        | Medium | `npm install` shows its own progress; no additional action needed                                                                  |
| Symlinking / path resolution breaks with nvm when user switches Node | Medium     | High   | Service file references `process.execPath` + absolute core path at install time; `neura install` must be re-run after nvm switches |
| Core bundle + deps together exceed npm tarball size limits           | Low        | Medium | npm limit is 10 GB; we'll be ~100 MB packed; not a concern                                                                         |
| Existing users on v1.10.x see "core not found" after upgrade         | Low        | Medium | Old `~/.neura/core/` is stale but harmless; `neura install` rewrites the service file to point at the new location                 |
| Desktop app bundling breaks                                          | Low        | Medium | Desktop uses electron-builder with its own core bundling path; unaffected by CLI changes                                           |
| `tools/bundle-core-into-cli.mjs` runs before core is built           | Low        | Medium | Turbo's `^build` dependency ensures core builds first                                                                              |

---

## Open Questions

1. **Should we vendor a lockfile?** Since native deps are critical, shipping a lockfile guarantees every user gets the exact same dep tree. `npm publish` includes `package-lock.json` by default if present in the package dir. **Recommendation: yes, vendor the lockfile**.

2. **Can users on truly restricted environments (no npm registry access for native deps) install at all?** No — and that's OK for soft launch. Document it. Users who need offline installs can `npm pack` on a connected machine and transfer the tarball.

3. **What happens to existing `~/.neura/core/` directories on upgrade?** Harmless leftover. We can add a cleanup step to `neura install` (Phase 4) that removes `~/.neura/core/` if it exists, since core no longer lives there.

4. **Does this change the minimum Node version?** `onnxruntime-node` requires Node >=16. We already require >=22. No change.

---

## Success Criteria

A fresh install on a new machine completes with:

```bash
npm install -g @mclean-capital/neura      # single command, installs CLI + core + deps
neura --version                            # 1.11.0
neura install                              # no core download step; registers service; reports healthy
neura status                               # running, port, uptime, version
neura logs -n 20                           # shows "wake word detection active" line
```

And manually confirm:

```bash
# Say the wake word with mic on
# → session activates, transcription appears in logs
```

If wake detection is the entire value proposition, then "`say the wake word, watch it activate`" is the success criterion.

Also:

- `npm view @mclean-capital/neura@1.11.0` shows the new version live
- `curl $(npm root -g)/@mclean-capital/neura/core/server.bundled.mjs` exists
- No `~/.neura/core/` directory is required (legacy path)
- Core-build workflow is deleted from `.github/workflows/`
- Total unpacked package size ~200-250 MB

---

## Upgrade path for existing v1.10.x users

### One-time manual bootstrap required

The `neura update` command in v1.10.x and earlier still calls the old
`downloadCore()` → GitHub releases flow. Since v1.11.0 deletes the
core-build tarball pipeline, those legacy CLIs will hit 404s when they
try to self-update.

**Required manual step for existing v1.10.x users:**

```bash
# This bypasses the old updater and pulls v1.11.0 directly from npm
npm install -g @mclean-capital/neura@latest
neura install     # rewrites service files to point at the new bundled core
```

After this one-time bootstrap, `neura update` works normally (runs
`npm install -g` under the hood and re-registers the service).

**Communicating this:**

- Call it out explicitly in the v1.11.0 release notes
- Add a prominent section to `packages/cli/README.md` under "Upgrading"
- Include it in the GitHub release body

This is a one-time break that affects only the single user testing the
soft launch; no production users exist yet.

---

## Out of scope

- Windows service registration (still pending WinSW, separate phase)
- Offline/air-gapped install
- Automated upgrade path for pre-v1.11.0 CLIs (documented manual workaround above)
- Rollback mechanism (follow-up if needed)
- Removing `packages/core/` as a standalone package (it's still needed for desktop's bundle — just no longer published as a tarball)
