import { platform } from 'os';
import { execSync } from 'child_process';

export type Platform = 'windows' | 'macos' | 'linux';

export function detectPlatform(): Platform {
  switch (platform()) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

/**
 * Check if the current process has admin/root privileges.
 * Windows: checks via `net session` (only succeeds when elevated).
 * Unix: checks effective UID.
 */
export function isElevated(): boolean {
  if (platform() === 'win32') {
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return process.getuid?.() === 0;
}

export function getPlatformLabel(): string {
  const labels: Record<Platform, string> = {
    windows: 'Windows Scheduled Task (user logon)',
    macos: 'launchd Agent',
    linux: 'systemd User Service',
  };
  return labels[detectPlatform()];
}
