import { builtinModules } from 'module';
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  outfile: 'dist/server.bundled.mjs',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // CJS interop: express/ws use require() internally
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  // Externalize Node built-ins, dev-only modules, and the stores module
  // (dynamically imported so sql.js WASM only loads when DB_PATH is set)
  external: ['node:*', ...builtinModules, 'pino-pretty', './stores/index.js'],
  logLevel: 'info',
});
