import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { getInstalledCoreVersion } from './download.js';
import { loadConfig, getNeuraHome } from './config.js';

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
 * Print an update notice if the cache shows a newer version.
 * If the cache is stale or missing, spawn a detached background process to refresh it.
 * Main process never makes network calls — exits immediately.
 */
export function checkForUpdateInBackground(): void {
  const config = loadConfig();
  if (config.autoUpdate === false) return;

  const installed = getInstalledCoreVersion();
  if (!installed) return;

  const cache = readCache();

  // Print notice from cache if available
  if (cache) {
    const latestClean = cache.latestVersion.replace(/^v/, '');
    const installedClean = installed.replace(/^v/, '');
    if (latestClean !== installedClean) {
      console.log(
        chalk.dim(`  Update available: ${installedClean} → ${latestClean}  (run: neura update)`)
      );
    }
  }

  // Spawn background refresh if cache is stale or missing
  const isStale = !cache || Date.now() - cache.lastCheckedAt > CHECK_TTL_MS;
  if (isStale) {
    // Spawn a detached child that runs the refresh script
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { writeFileSync } from 'fs';
try {
  const res = await fetch('https://api.github.com/repos/mclean-capital/neura/releases/latest', {
    headers: { Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(5000),
  });
  if (res.ok) {
    const data = await res.json();
    writeFileSync(${JSON.stringify(getCachePath())}, JSON.stringify({
      lastCheckedAt: Date.now(),
      latestVersion: data.tag_name,
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
