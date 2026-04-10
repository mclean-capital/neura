import { builtinModules } from 'module';
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/server/server.ts'],
  bundle: true,
  outfile: 'dist/server.bundled.mjs',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // CJS interop: express/ws use require() internally
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  // Externalize Node built-ins, dev-only modules, and the stores module.
  // Stores are dynamically imported so PGlite (with its WASM/worker files) loads at runtime.
  // For Bun compile, the stores + PGlite package ship alongside the binary.
  external: ['node:*', ...builtinModules, 'pino-pretty', './stores/index.js', 'onnxruntime-node'],
  logLevel: 'info',
});
