import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { CLI_VERSION } from './version.js';
import { loadConfig, getNeuraHome } from './config.js';

const PACKAGE_NAME = '@mclean-capital/neura';
const CACHE_FILE = 'update-check.json';
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface UpdateCache {
  lastCheckedAt: number;
  latestVersion: string;
}

function getCachePath(): string {
  return join(getNeuraHome(), CACHE_FILE);
}

function readCache(): UpdateCache | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Simple numeric version compare — returns true if `a` > `b`.
 * Treats missing components as 0. Ignores any pre-release suffix.
 */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/**
 * Print an update notice if the cache shows a newer version of the npm
 * package is available. If the cache is stale or missing, spawn a detached
 * background process to refresh it against the npm registry.
 *
 * Since v1.11.0 we check the npm registry directly instead of GitHub
 * releases, because the CLI + core now ship as a single npm package.
 */
export function checkForUpdateInBackground(): void {
  const config = loadConfig();
  if (config.autoUpdate === false) return;

  const cache = readCache();

  // Print notice from cache if available. Legacy caches (pre-1.11.0,
  // written by the old GitHub-based checker) stored versions as `v1.2.3`;
  // the npm registry returns plain `1.2.3`. Strip the leading `v` before
  // comparing so stale caches from an upgrade don't trigger a false
  // "update available" notice until the 6-hour cache refresh.
  //
  // Only print the notice if the cached version is STRICTLY NEWER than the
  // running CLI. A simple `!==` comparison would show a "downgrade banner"
  // right after an upgrade: the user upgraded to 1.11.0 but the cache still
  // remembers 1.10.2 from the previous check, and we'd incorrectly tell them
  // to run `neura update` → 1.10.2.
  if (cache) {
    const cachedClean = cache.latestVersion.replace(/^v/, '');
    if (isNewer(cachedClean, CLI_VERSION)) {
      console.log(
        chalk.dim(`  Update available: ${CLI_VERSION} → ${cachedClean}  (run: neura update)`)
      );
    }
  }

  // Spawn background refresh if cache is stale or missing
  const isStale = !cache || Date.now() - cache.lastCheckedAt > CHECK_TTL_MS;
  if (isStale) {
    // Spawn a detached child that fetches the latest version from npm
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { writeFileSync } from 'fs';
try {
  const res = await fetch('https://registry.npmjs.org/${PACKAGE_NAME}/latest', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (res.ok) {
    const data = await res.json();
    writeFileSync(${JSON.stringify(getCachePath())}, JSON.stringify({
      lastCheckedAt: Date.now(),
      latestVersion: data.version,
    }));
  }
} catch {}
`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
  }
}
