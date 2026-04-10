/**
 * Single source of truth for the CLI version.
 *
 * Reads from the adjacent package.json via createRequire so both dev mode
 * (tsx src/version.ts) and published builds (dist/version.js) resolve the
 * same file: packages/cli/package.json.
 *
 * Before publish, the CI workflow syncs this file's version from the root
 * monorepo version. See tools/sync-cli-version.mjs.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const CLI_VERSION = pkg.version;
