import { builtinModules } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import esbuild from 'esbuild';

// ── Main server bundle ────────────────────────────────────────────────
// Everything in src/ except the stores/ and native modules get bundled
// into a single server.bundled.mjs via esbuild's static-analysis bundler.
//
// Output layout (matches how the bundle ships to CLI and desktop):
//
//   dist/
//     core/
//       server.bundled.mjs  ← main bundle (this)
//       version.txt
//     stores/
//       index.js            ← stores bundle (sibling of core/, not child)
//       package.json        ← ESM sidecar
//
// The main bundle dynamically imports `'../stores/index.js'`, which at
// runtime is resolved relative to the bundle's own file URL. Placing the
// main bundle at `dist/core/server.bundled.mjs` and stores at
// `dist/stores/index.js` makes that specifier resolve correctly when
// `packages/core/dist/core/server.bundled.mjs` is run directly — and
// also matches the downstream layouts used by both `tools/
// bundle-core-into-cli.mjs` (which copies to `packages/cli/{core,stores}/`)
// and `packages/desktop/electron-builder.yml` (which copies to
// `resources/{core,stores}/`). One layout, consistent across all three
// distribution points.
await esbuild.build({
  entryPoints: ['src/server/server.ts'],
  bundle: true,
  outfile: 'dist/core/server.bundled.mjs',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // CJS interop: express/ws use require() internally
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  // Externalize Node built-ins, dev-only modules, the stores module (see below),
  // and native modules that can't be bundled.
  //
  // Stores: `src/server/lifecycle.ts` dynamically imports `'../stores/index.js'`,
  // so the external specifier must match that exact relative path. Previously
  // this was `'./stores/index.js'` which failed to match — the stores module
  // was getting bundled, pulling PGlite's full WASM/data loader into the main
  // bundle and breaking asset resolution at runtime.
  //
  // PGlite: also externalized directly as defense in depth. Its runtime asset
  // loader (`pglite.data`, pgvector `vector.tar.gz`, `.wasm` files) resolves
  // paths relative to its own dist/ via import.meta.url, which only works if
  // PGlite is loaded from `node_modules/@electric-sql/pglite/` at runtime
  // rather than inlined into this bundle.
  //
  // Phase 6 adds two more externals:
  //
  // - `@mariozechner/pi-coding-agent`: the in-process worker runtime (Approach
  //   D). 14MB installed, pulls in `@silvia-odwyer/photon-node` (WASM loaded
  //   via import.meta.url), theme JSON assets, and the full interactive TUI
  //   surface via its main index.js re-exports. Must be resolved by Node at
  //   runtime, not inlined. Its transitive closure (pi-ai, pi-agent-core,
  //   photon-node, etc.) is handled automatically by Node's resolver when
  //   the package itself is loaded from node_modules.
  //
  // - `chokidar`: file system watcher used by `skill-watcher.ts`. Has a
  //   native fsevents binding on macOS that needs its own node_modules path.
  external: [
    'node:*',
    ...builtinModules,
    'pino-pretty',
    '../stores/index.js',
    '@electric-sql/pglite',
    'onnxruntime-node',
    '@mariozechner/pi-coding-agent',
    'chokidar',
  ],
  logLevel: 'info',
});

// ── Stores bundle ────────────────────────────────────────────────────
// Stores are loaded via dynamic import at runtime so PGlite's WASM/worker
// files resolve relative to this module rather than getting inlined. But
// the individual store files import `@neura/utils/logger` which is a
// workspace-only package. To ship stores in @mclean-capital/neura (which
// doesn't declare @neura/utils as a runtime dep), we bundle stores into a
// single self-contained file that inlines @neura/utils but keeps PGlite
// external (so its WASM loader still works).
await esbuild.build({
  entryPoints: ['src/stores/index.ts'],
  bundle: true,
  outfile: 'dist/stores/index.js',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  sourcemap: true,
  minify: false,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  external: ['node:*', ...builtinModules, '@electric-sql/pglite'],
  logLevel: 'info',
});

// Write an ESM package.json sidecar next to the stores bundle.
//
// Node determines ESM vs CJS by walking up to the nearest package.json
// and checking `"type"`. In the CLI npm layout, stores/index.js sits
// inside the @mclean-capital/neura package which has `"type": "module"`
// at the package root, so the walk-up finds it. But in the Electron
// desktop layout, stores/ lives under `resources/` with no parent
// package.json — Node falls back to CJS parsing and the ESM bundle
// crashes at the first `import` statement. This sidecar forces ESM
// regardless of parent directories.
writeFileSync('dist/stores/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');

// Write a version marker next to the server bundle for lifecycle.ts to
// read via import.meta.url at runtime. Both the CLI and desktop
// distribution flows consume this file — the CLI copies it via
// tools/bundle-core-into-cli.mjs, and the desktop copies it via
// electron-builder.yml's extraResources.
const rootPkg = JSON.parse(readFileSync('../../package.json', 'utf-8'));
writeFileSync('dist/core/version.txt', rootPkg.version + '\n');
