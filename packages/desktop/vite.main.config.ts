import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  define: {
    __dirname: 'import.meta.dirname',
  },
  build: {
    outDir: 'dist-main',
    lib: {
      entry: path.resolve(__dirname, 'src/main/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: [
        'electron',
        'electron-store',
        'electron-updater',
        'express',
        'http-proxy-middleware',
        /^node:/,
        'child_process',
        'path',
        'fs',
        'http',
        'https',
        'os',
        'url',
        'crypto',
        'net',
      ],
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    minify: false,
    sourcemap: true,
    emptyOutDir: true,
  },
});
