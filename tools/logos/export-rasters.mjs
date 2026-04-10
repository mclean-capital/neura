#!/usr/bin/env node
/**
 * Rasterize SVG logos to PNG at the sizes needed by web UI, desktop app,
 * and GitHub social preview. Uses sharp (already a dev dep).
 *
 * Usage:
 *   node tools/logos/export-rasters.mjs
 *   npm run logos:export
 */

import sharp from 'sharp';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SRC = join(ROOT, 'assets', 'logos', 'final');

/**
 * Square marks: source SVG + list of output sizes (square PNGs).
 */
const squareTasks = [
  // Neura flat mark → favicon (browser tab) and tray icon (small monochrome-ish contexts)
  {
    source: 'neura-mark.svg',
    outputs: [
      { path: 'packages/ui/public/favicon.png', size: 32 },
      { path: 'packages/desktop/assets/tray-icon.png', size: 32 },
      { path: 'assets/logos/final/raster/neura-mark-256.png', size: 256 },
      { path: 'assets/logos/final/raster/neura-mark-512.png', size: 512 },
    ],
  },

  // Neura app icon (rounded dark container) → installed-app contexts where a
  // container-style icon is expected: iOS home screen, PWA install, desktop
  // dock, installer icon. Modern platforms don't add their own container, so
  // the container needs to be baked in.
  {
    source: 'neura-app-icon.svg',
    outputs: [
      { path: 'packages/ui/public/apple-touch-icon.png', size: 180 },
      { path: 'packages/ui/public/icon-192.png', size: 192 },
      { path: 'packages/ui/public/icon-512.png', size: 512 },
      { path: 'packages/desktop/assets/icon.png', size: 512 },
      { path: 'assets/logos/final/raster/neura-app-icon-256.png', size: 256 },
      { path: 'assets/logos/final/raster/neura-app-icon-512.png', size: 512 },
    ],
  },
  {
    source: 'neura-mark-light.svg',
    outputs: [
      { path: 'assets/logos/final/raster/neura-mark-light-256.png', size: 256 },
      { path: 'assets/logos/final/raster/neura-mark-light-512.png', size: 512 },
    ],
  },
  {
    source: 'mclean-mark.svg',
    outputs: [
      { path: 'assets/logos/final/raster/mclean-mark-256.png', size: 256 },
      { path: 'assets/logos/final/raster/mclean-mark-512.png', size: 512 },
    ],
  },
  {
    source: 'mclean-mark-light.svg',
    outputs: [
      { path: 'assets/logos/final/raster/mclean-mark-light-256.png', size: 256 },
      { path: 'assets/logos/final/raster/mclean-mark-light-512.png', size: 512 },
    ],
  },
];

/**
 * Wordmarks: keep aspect ratio, fit to a specific width.
 */
const wordmarkTasks = [
  {
    source: 'mclean-wordmark.svg',
    outputs: [
      { path: 'assets/logos/final/raster/mclean-wordmark-560.png', width: 560 },
      { path: 'assets/logos/final/raster/mclean-wordmark-1120.png', width: 1120 },
    ],
  },
  {
    source: 'mclean-wordmark-light.svg',
    outputs: [
      { path: 'assets/logos/final/raster/mclean-wordmark-light-560.png', width: 560 },
      { path: 'assets/logos/final/raster/mclean-wordmark-light-1120.png', width: 1120 },
    ],
  },
];

async function renderSquare(svgBuffer, size) {
  // Re-parse at target density so strokes stay crisp — sharp rasterizes SVG
  // at 72 DPI by default, which can look soft on large outputs.
  const density = Math.max(72, Math.round((size / 240) * 72));
  return sharp(svgBuffer, { density })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function renderWordmark(svgBuffer, width) {
  // Aspect 560:120 ≈ 4.67:1 — height follows from width.
  const density = Math.max(72, Math.round((width / 560) * 72));
  return sharp(svgBuffer, { density })
    .resize({ width, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function writeOutput(outPath, buffer) {
  const full = join(ROOT, outPath);
  mkdirSync(dirname(full), { recursive: true });
  const { writeFile } = await import('fs/promises');
  await writeFile(full, buffer);
}

async function main() {
  let count = 0;

  for (const task of squareTasks) {
    const svgPath = join(SRC, task.source);
    if (!existsSync(svgPath)) {
      console.error(`  skip (missing): ${task.source}`);
      continue;
    }
    const svgBuffer = readFileSync(svgPath);
    for (const out of task.outputs) {
      const png = await renderSquare(svgBuffer, out.size);
      await writeOutput(out.path, png);
      console.log(`  ${task.source} → ${out.path} (${out.size}px)`);
      count++;
    }
  }

  for (const task of wordmarkTasks) {
    const svgPath = join(SRC, task.source);
    if (!existsSync(svgPath)) {
      console.error(`  skip (missing): ${task.source}`);
      continue;
    }
    const svgBuffer = readFileSync(svgPath);
    for (const out of task.outputs) {
      const png = await renderWordmark(svgBuffer, out.width);
      await writeOutput(out.path, png);
      console.log(`  ${task.source} → ${out.path} (${out.width}w)`);
      count++;
    }
  }

  console.log(`\nGenerated ${count} raster files.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
