#!/usr/bin/env node
/**
 * Copy the core build output into the CLI package so it ships inside
 * @mclean-capital/neura on npm.
 *
 * Called from packages/cli's build script after tsc finishes. Turbo's
 * `build` task depends on `^build`, which guarantees packages/core has
 * already been built by the time this runs.
 *
 * Source layout (produced by packages/core/scripts/bundle.ts):
 *   packages/core/dist/
 *     core/
 *       server.bundled.mjs
 *       server.bundled.mjs.map
 *       version.txt
 *     stores/
 *       index.js
 *       index.js.map
 *       package.json
 *
 * Target layout (same shape, just copied):
 *   packages/cli/core/
 *     server.bundled.mjs
 *     server.bundled.mjs.map
 *     version.txt
 *   packages/cli/stores/
 *     index.js
 *     index.js.map
 *     package.json
 *
 * IMPORTANT: the stores bundle lives at `packages/cli/stores/`, NOT
 * `packages/cli/core/stores/`. This is because `lifecycle.ts` dynamically
 * imports `'../stores/index.js'`, and that path is resolved relative to
 * the bundle file URL at runtime. From `packages/cli/core/server.bundled.mjs`,
 * `'../stores/index.js'` resolves to `packages/cli/stores/index.js` — a
 * SIBLING of `core/`, not a child.
 *
 * The source dist/ now mirrors this exact layout so running the unpackaged
 * bundle directly (packages/core/dist/core/server.bundled.mjs) also works.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORE_DIST = join(ROOT, 'packages/core/dist');
const CORE_DIST_CORE = join(CORE_DIST, 'core');
const CORE_DIST_STORES = join(CORE_DIST, 'stores');
const CLI_PKG = join(ROOT, 'packages/cli');
const CLI_CORE = join(CLI_PKG, 'core');
const CLI_STORES = join(CLI_PKG, 'stores');

// Always build core fresh before copying. Under turbo, `^build` already
// ensures this, but someone running `npm run build -w @mclean-capital/neura`
// directly bypasses turbo and could end up shipping a stale core bundle
// that doesn't match current src/. `turbo run build` is idempotent and
// cache-hit on repeat, so this is effectively free when nothing changed.
const isWindows = process.platform === 'win32';
const coreBuild = isWindows
  ? spawnSync('npx.cmd turbo run build --filter=@neura/core', {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    })
  : spawnSync('npx', ['turbo', 'run', 'build', '--filter=@neura/core'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
if (coreBuild.status !== 0) {
  console.error('Core build failed; cannot bundle into CLI.');
  process.exit(1);
}

if (!existsSync(join(CORE_DIST_CORE, 'server.bundled.mjs'))) {
  console.error('Core bundle not found at packages/core/dist/core/server.bundled.mjs after build.');
  process.exit(1);
}

// Clean target dirs
rmSync(CLI_CORE, { recursive: true, force: true });
rmSync(CLI_STORES, { recursive: true, force: true });
mkdirSync(CLI_CORE, { recursive: true });
mkdirSync(CLI_STORES, { recursive: true });

// Copy the core/ directory (server bundle, sourcemap, version.txt).
cpSync(CORE_DIST_CORE, CLI_CORE, { recursive: true });

// Copy the stores/ directory (bundled index.js with @neura/utils inlined,
// sourcemap, ESM package.json sidecar). PGlite stays external — it must
// load from node_modules at runtime so its WASM/data assets resolve via
// its own import.meta.url.
if (!existsSync(join(CORE_DIST_STORES, 'index.js'))) {
  console.error('Core stores bundle not found at packages/core/dist/stores/index.js after build.');
  process.exit(1);
}
cpSync(CORE_DIST_STORES, CLI_STORES, { recursive: true });

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
console.log(`Bundled core → packages/cli/core + packages/cli/stores (version ${rootPkg.version})`);
