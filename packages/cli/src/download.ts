import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  createWriteStream,
  chmodSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir, platform, arch } from 'os';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getNeuraHome } from './config.js';

const REPO = 'mclean-capital/neura';

export function getPlatformTarget(): { os: string; arch: string; ext: string } {
  const os = platform() === 'darwin' ? 'darwin' : platform() === 'win32' ? 'windows' : 'linux';
  const cpuArch = arch() === 'arm64' ? 'arm64' : 'x64';
  const ext = platform() === 'win32' ? '.exe' : '';
  return { os, arch: cpuArch, ext };
}

/**
 * Resolve the latest release version from GitHub API.
 */
export async function getLatestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as { tag_name: string };
  return data.tag_name;
}

/**
 * Download and extract the core bundle from a GitHub release.
 * The archive contains the esbuild bundle, stores, and PGlite.
 * Returns the path to the core directory.
 */
export async function downloadCore(version: string): Promise<string> {
  const { os, arch: cpuArch } = getPlatformTarget();
  const archiveExt = os === 'windows' ? 'zip' : 'tar.gz';
  const assetName = `neura-core-${os}-${cpuArch}.${archiveExt}`;
  const url = `https://github.com/${REPO}/releases/download/${version}/${assetName}`;

  const coreDir = join(getNeuraHome(), 'core');
  mkdirSync(coreDir, { recursive: true });

  // Stage in a temp directory to avoid partial installs on crash
  const stagingDir = join(tmpdir(), `neura-update-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });
  const archivePath = join(stagingDir, assetName);

  try {
    // Download archive
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        // Check if the release exists but just has no assets yet
        const releaseRes = await fetch(
          `https://api.github.com/repos/${REPO}/releases/tags/${version}`,
          {
            headers: { Accept: 'application/vnd.github.v3+json' },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (releaseRes.ok) {
          throw new Error(
            `Release ${version} exists but the core binary for ${os}-${cpuArch} is not yet available.\n` +
              `  The build pipeline may still be running. Try again in a few minutes.\n` +
              `  Check: https://github.com/${REPO}/releases/tag/${version}`
          );
        }
      }
      throw new Error(`Download failed: ${res.status} ${res.statusText}\n  URL: ${url}`);
    }

    const body = res.body;
    if (!body) throw new Error('Empty response body');
    await pipeline(Readable.fromWeb(body as never), createWriteStream(archivePath));

    // Extract to staging directory
    const extractDir = join(stagingDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });

    if (os === 'windows') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(`tar xzf "${archivePath}" -C "${extractDir}"`, { stdio: 'pipe' });
    }

    // Write version file into the extracted content
    writeFileSync(join(extractDir, 'version.txt'), version.replace(/^v/, ''), 'utf-8');

    // Atomic swap: remove old core dir contents, move staged files in
    // Keep pgdata/ and logs/ — only replace the bundle files
    const filesToCopy = readdirSync(extractDir);

    for (const file of filesToCopy) {
      const src = join(extractDir, file);
      const dest = join(coreDir, file);
      // Remove existing file/dir at destination
      rmSync(dest, { recursive: true, force: true });
      renameSync(src, dest);
    }

    // Set executable permission on the entry script (Unix)
    if (os !== 'windows') {
      const entryPath = join(coreDir, 'server.bundled.mjs');
      if (existsSync(entryPath)) {
        chmodSync(entryPath, 0o755);
      }
    }

    return coreDir;
  } finally {
    // Clean up staging directory
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Get the installed core version from version.txt.
 */
export function getInstalledCoreVersion(): string | null {
  const versionFile = join(getNeuraHome(), 'core', 'version.txt');
  if (!existsSync(versionFile)) return null;
  return readFileSync(versionFile, 'utf-8').trim();
}

/**
 * Check if the core bundle exists locally.
 */
export function hasCoreBinary(): boolean {
  return existsSync(join(getNeuraHome(), 'core', 'server.bundled.mjs'));
}

/**
 * Get the path to the core entry script.
 */
export function getCoreBinaryPath(): string {
  return join(getNeuraHome(), 'core', 'server.bundled.mjs');
}
