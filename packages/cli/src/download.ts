import { existsSync } from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';
import { getNeuraHome } from './config.js';

const REPO = 'mclean-capital/neura';

function getPlatformTarget(): { os: string; arch: string; ext: string } {
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
 * Download the core binary from a GitHub release.
 * Returns the path to the downloaded binary.
 */
export function downloadCore(version: string): never {
  const { os, arch: cpuArch } = getPlatformTarget();
  const assetName = `neura-core-${os}-${cpuArch}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/${version}/${assetName}`;

  // TODO: Implement tar.gz extraction once the release pipeline is set up.
  // The GitHub release assets are tarballs, not raw binaries. Downloading
  // and writing a .tar.gz directly as an executable produces a corrupt file.
  // Until the release pipeline exists, this is a placeholder.
  throw new Error(
    `Core binary download is not yet available (release pipeline pending).\n` +
      `  Expected asset: ${url}\n\n` +
      `For now, run core directly from source:\n` +
      `  npm run dev -w @neura/core\n\n` +
      `Standalone binaries will be available once the Bun compile\n` +
      `release pipeline is set up (see docs/cli-service-architecture.md).`
  );
}

/**
 * Check if a core binary exists locally.
 */
export function hasCoreBinary(): boolean {
  const { ext } = getPlatformTarget();
  return existsSync(join(getNeuraHome(), 'core', `neura-core${ext}`));
}

/**
 * Get the path to the local core binary.
 */
export function getCoreBinaryPath(): string {
  const { ext } = getPlatformTarget();
  return join(getNeuraHome(), 'core', `neura-core${ext}`);
}
