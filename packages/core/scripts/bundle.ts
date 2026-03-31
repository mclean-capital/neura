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
  // Externalize Node built-ins, native addons, and dev-only dynamic imports
  external: ['node:*', ...builtinModules, 'better-sqlite3', 'pino-pretty'],
  logLevel: 'info',
});
