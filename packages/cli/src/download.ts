import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolve the core bundle that ships inside this CLI package.
 *
 * Layout after npm install -g @mclean-capital/neura:
 *
 *   $NPM_GLOBAL/lib/node_modules/@mclean-capital/neura/
 *     dist/
 *       index.js              ← CLI entry
 *       commands/
 *         install.js          ← import.meta.url lives here at runtime
 *       service/
 *       ...
 *     core/
 *       server.bundled.mjs    ← what we want to run as the service
 *       stores/
 *       version.txt
 *     node_modules/
 *       onnxruntime-node/     ← resolved via Node's module lookup from core/
 *       @electric-sql/pglite/
 *
 * From any file under dist/, we walk up to the package root and resolve
 * `core/server.bundled.mjs` from there. This keeps the resolution stable
 * regardless of which dist file does the import.
 */

/** Absolute path to the core bundle (server.bundled.mjs). */
export function getCoreBinaryPath(): string {
  // import.meta.url of this module. When compiled, this file lives at
  // <pkg-root>/dist/download.js, so ../core/server.bundled.mjs resolves
  // correctly from either dev (tsx src/download.ts) or prod (dist/download.js).
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile); // .../dist or .../src
  const pkgRoot = resolve(thisDir, '..');
  return join(pkgRoot, 'core', 'server.bundled.mjs');
}

/** True if the core bundle exists at its expected ship location. */
export function hasCoreBinary(): boolean {
  return existsSync(getCoreBinaryPath());
}

/**
 * Read the version marker written by tools/bundle-core-into-cli.mjs.
 * Returns null if the marker is missing.
 */
export function getInstalledCoreVersion(): string | null {
  const versionFile = join(dirname(getCoreBinaryPath()), 'version.txt');
  if (!existsSync(versionFile)) return null;
  return readFileSync(versionFile, 'utf-8').trim();
}

/**
 * Absolute path to the directory of ONNX wake-word models shipped
 * inside the CLI npm package.
 *
 * Layout:
 *
 *   $NPM_GLOBAL/lib/node_modules/@mclean-capital/neura/models/
 *     melspectrogram.onnx      ← shared mel spectrogram encoder (~1 MB)
 *     embedding_model.onnx     ← shared speech embedding model (~1.3 MB)
 *     jarvis.onnx              ← "hey jarvis" classifier (~170 KB)
 *     neura.onnx               ← "hey neura" classifier (~170 KB)
 *
 * The two infrastructure models (mel + embedding) come from the
 * livekit-wakeword project (Apache 2.0). The two classifiers were
 * trained from `tools/wake-word/` using the livekit-wakeword training
 * pipeline. Total ~2.7 MB — small enough to ship committed so fresh
 * `npm install -g @mclean-capital/neura` users get a working wake
 * word detector out of the box without running a 45-minute Python
 * training pipeline.
 *
 * `neura install` copies any missing files from here into
 * `$NEURA_HOME/models/` on first install. Existing files in
 * `$NEURA_HOME/models/` are never overwritten — users who train their
 * own classifiers can drop them into place and they'll take priority.
 */
export function getBundledModelsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const pkgRoot = resolve(thisDir, '..');
  return join(pkgRoot, 'models');
}
