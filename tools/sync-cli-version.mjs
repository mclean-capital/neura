#!/usr/bin/env node
/**
 * Sync the root package.json version into packages/cli/package.json.
 *
 * semantic-release only bumps the root package.json; workspace package
 * versions stay at "0.0.0" by design. This script mirrors the root version
 * onto the CLI before npm publish so the published tarball carries the
 * correct version.
 *
 * Usage:
 *   node tools/sync-cli-version.mjs
 *   npm run cli:version-sync
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const cliPath = resolve(ROOT, 'packages', 'cli', 'package.json');
const cliPkg = JSON.parse(readFileSync(cliPath, 'utf-8'));

if (cliPkg.version === rootPkg.version) {
  console.log(`CLI version already ${rootPkg.version}, nothing to sync.`);
  process.exit(0);
}

const oldVersion = cliPkg.version;
cliPkg.version = rootPkg.version;

// Preserve trailing newline for editor/prettier consistency
writeFileSync(cliPath, JSON.stringify(cliPkg, null, 2) + '\n', 'utf-8');

console.log(`Synced CLI version ${oldVersion} → ${rootPkg.version}`);
