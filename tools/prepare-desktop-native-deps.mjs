#!/usr/bin/env node
/**
 * Walk the runtime dependency closure of `onnxruntime-node` and
 * `@electric-sql/pglite` from the workspace root node_modules, and copy
 * each package directory into `packages/desktop/build-resources/node_modules/`.
 *
 * electron-builder then copies this staging directory into the packaged
 * app's `resources/node_modules/` via extraResources. This approach is
 * resilient to changes in the native-dep transitive tree — we don't have
 * to maintain an explicit allowlist in electron-builder.yml.
 *
 * Run this before `electron-builder` via the `dist:*` scripts.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const STAGING = join(ROOT, 'packages/desktop/build-resources/node_modules');

// Seeds — these are the externalized deps the bundled core requires at
// runtime. Anything the core bundle pulls in via esbuild is already inlined
// and does not need to be copied.
//
// Phase 6 adds the pi-coding-agent runtime tree as seeds. We list each
// of the three @mariozechner/* packages explicitly because the closure
// walker follows direct dependencies — pi-coding-agent already pulls in
// pi-agent-core and pi-ai transitively, but listing them directly keeps
// the seed set obvious and protects against closure walker edge cases
// if the transitive tree changes. See packages/core/scripts/bundle.ts
// for the matching esbuild externals.
const SEEDS = [
  'onnxruntime-node',
  'onnxruntime-web',
  '@electric-sql/pglite',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  'chokidar',
];

function walkClosure(pkgName, visited = new Set()) {
  if (visited.has(pkgName)) return visited;
  const pkgJsonPath = join(NODE_MODULES, pkgName, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    console.warn(`  warning: ${pkgName} not in workspace node_modules (skipping)`);
    return visited;
  }
  visited.add(pkgName);
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      walkClosure(dep, visited);
    }
  } catch (err) {
    console.warn(`  warning: failed to read ${pkgName}/package.json:`, err.message);
  }
  return visited;
}

// Compute the full closure
const closure = new Set();
for (const seed of SEEDS) {
  walkClosure(seed, closure);
}

const sorted = [...closure].sort();
console.log(`Closure of [${SEEDS.join(', ')}]: ${sorted.length} packages`);

// Clean the staging dir
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

// Copy each package
let copied = 0;
for (const name of sorted) {
  const src = join(NODE_MODULES, name);
  const dst = join(STAGING, name);
  if (!existsSync(src)) {
    console.warn(`  warning: ${name} source missing, skipping`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  copied++;
}

console.log(`Copied ${copied} packages → ${STAGING.replace(ROOT + '/', '')}`);
