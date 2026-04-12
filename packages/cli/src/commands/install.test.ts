import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock `getBundledModelsDir` so we can point the helper at a test
// fixture directory rather than the real packages/cli/models/ on disk.
// Everything else (fs, path) is real — the helper is small and the
// tests are about actual file operations, which mocking would obscure.
const mocks = vi.hoisted(() => ({
  getBundledModelsDir: vi.fn<() => string>(),
}));

vi.mock('../download.js', () => ({
  getBundledModelsDir: mocks.getBundledModelsDir,
  hasCoreBinary: vi.fn(() => true),
  getCoreBinaryPath: vi.fn(() => '/fake/core.mjs'),
  getInstalledCoreVersion: vi.fn(() => '0.0.0-test'),
}));

import { __test__ } from './install.js';

let fixtureSrc: string;
let fixtureHome: string;

beforeEach(() => {
  // Create two tmp dirs: one for the "bundled" source the CLI would
  // ship with, and one standing in for $NEURA_HOME.
  fixtureSrc = mkdtempSync(join(tmpdir(), 'neura-bundled-src-'));
  fixtureHome = mkdtempSync(join(tmpdir(), 'neura-home-'));
  mocks.getBundledModelsDir.mockReturnValue(fixtureSrc);
});

afterEach(() => {
  try {
    rmSync(fixtureSrc, { recursive: true, force: true });
  } catch {
    /* ignore cleanup failures */
  }
  try {
    rmSync(fixtureHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('installBundledModels', () => {
  it('copies every .onnx file from the bundled source to $NEURA_HOME/models/', () => {
    // Seed the "bundled" fixture with the same layout the real CLI
    // ships with: two infra models + two classifier models.
    writeFileSync(join(fixtureSrc, 'melspectrogram.onnx'), 'mel-bytes');
    writeFileSync(join(fixtureSrc, 'embedding_model.onnx'), 'emb-bytes');
    writeFileSync(join(fixtureSrc, 'jarvis.onnx'), 'jarvis-bytes');
    writeFileSync(join(fixtureSrc, 'neura.onnx'), 'neura-bytes');
    // Non-onnx files should be ignored — we don't want a stray README
    // or sourcemap to end up in ~/.neura/models/.
    writeFileSync(join(fixtureSrc, 'README.md'), '# docs');
    writeFileSync(join(fixtureSrc, 'melspectrogram.onnx.map'), 'sourcemap');

    const copied = __test__.installBundledModels(fixtureHome);

    expect(copied.sort()).toEqual([
      'embedding_model.onnx',
      'jarvis.onnx',
      'melspectrogram.onnx',
      'neura.onnx',
    ]);

    // Each copied file should exist in the destination with the same
    // bytes — verifies copyFileSync actually ran, not just that we
    // returned the filename.
    const destDir = join(fixtureHome, 'models');
    expect(readFileSync(join(destDir, 'melspectrogram.onnx'), 'utf-8')).toBe('mel-bytes');
    expect(readFileSync(join(destDir, 'embedding_model.onnx'), 'utf-8')).toBe('emb-bytes');
    expect(readFileSync(join(destDir, 'jarvis.onnx'), 'utf-8')).toBe('jarvis-bytes');
    expect(readFileSync(join(destDir, 'neura.onnx'), 'utf-8')).toBe('neura-bytes');

    // Non-onnx files must NOT have been copied
    expect(existsSync(join(destDir, 'README.md'))).toBe(false);
    expect(existsSync(join(destDir, 'melspectrogram.onnx.map'))).toBe(false);
  });

  it('creates $NEURA_HOME/models/ if it does not already exist', () => {
    writeFileSync(join(fixtureSrc, 'jarvis.onnx'), 'jarvis-bytes');

    // fixtureHome exists but has no `models` subdir yet.
    expect(existsSync(join(fixtureHome, 'models'))).toBe(false);

    __test__.installBundledModels(fixtureHome);

    expect(existsSync(join(fixtureHome, 'models'))).toBe(true);
    expect(existsSync(join(fixtureHome, 'models', 'jarvis.onnx'))).toBe(true);
  });

  it('NEVER overwrites existing files in $NEURA_HOME/models/', () => {
    // Critical invariant: users who train their own classifier with
    // `tools/wake-word/scripts/train.sh` deploy it to ~/.neura/models/
    // via deploy.sh. `neura install` runs every upgrade and MUST NOT
    // clobber those user-trained models with the shipped defaults.
    // First-write-wins — the bundled copy only fills gaps.
    writeFileSync(join(fixtureSrc, 'jarvis.onnx'), 'shipped-default-bytes');
    writeFileSync(join(fixtureSrc, 'melspectrogram.onnx'), 'shipped-mel-bytes');

    // User has their own trained jarvis.onnx already in place
    const destDir = join(fixtureHome, 'models');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'jarvis.onnx'), 'user-trained-bytes');

    const copied = __test__.installBundledModels(fixtureHome);

    // The helper should report that it only copied the NEW file —
    // it must not include the user-existing one in the copied list.
    expect(copied).toEqual(['melspectrogram.onnx']);

    // And most importantly, the user's existing bytes must be untouched.
    expect(readFileSync(join(destDir, 'jarvis.onnx'), 'utf-8')).toBe('user-trained-bytes');
    // The gap (melspectrogram) was filled with the shipped default.
    expect(readFileSync(join(destDir, 'melspectrogram.onnx'), 'utf-8')).toBe('shipped-mel-bytes');
  });

  it('returns an empty list if the bundled source directory does not exist', () => {
    // Edge case: running from a dev layout where `packages/cli/models/`
    // doesn't exist yet (e.g. a fresh clone before the models were
    // committed). Should gracefully do nothing rather than throw.
    mocks.getBundledModelsDir.mockReturnValue(
      join(tmpdir(), 'definitely-does-not-exist-' + Date.now())
    );

    const copied = __test__.installBundledModels(fixtureHome);

    expect(copied).toEqual([]);
  });
});
