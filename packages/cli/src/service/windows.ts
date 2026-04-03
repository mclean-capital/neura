import { join } from 'path';
import { execSync } from 'child_process';
import { getNeuraHome } from '../config.js';
import { isElevated } from './detect.js';

const SERVICE_NAME = 'neura-core';

function requireElevation(): void {
  if (!isElevated()) {
    throw new Error(
      'Administrator privileges required.\n' +
        'Right-click your terminal and select "Run as administrator", then retry.'
    );
  }
}

export function isInstalled(): boolean {
  try {
    const result = execSync(`sc query ${SERVICE_NAME}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return !result.includes('does not exist');
  } catch {
    return false;
  }
}

export function isRunning(): boolean {
  try {
    const result = execSync(`sc query ${SERVICE_NAME}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.includes('RUNNING');
  } catch {
    return false;
  }
}

export function install(): void {
  requireElevation();

  // Windows Services must implement the SCM protocol (ServiceMain callback).
  // A plain Node.js/Bun binary cannot respond to SCM handshakes and will fail
  // with error 1053. A service wrapper like WinSW or NSSM is required to bridge
  // the gap. This will be implemented in Phase 2 of the CLI service architecture.
  //
  // See: docs/cli-service-architecture.md — Phase 2: OS Service Registration
  throw new Error(
    'Windows Service registration requires a service wrapper (WinSW).\n' +
      'This is planned for Phase 2. For now, run core manually:\n\n' +
      '  neura-core          (if binary installed)\n' +
      '  npm run dev -w @neura/core   (from source)\n'
  );
}

export function uninstall(): void {
  requireElevation();
  try {
    execSync(`sc stop ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch {
    // May already be stopped
  }
  execSync(`sc delete ${SERVICE_NAME}`, { stdio: 'inherit' });
}

export function start(): void {
  requireElevation();
  execSync(`sc start ${SERVICE_NAME}`, { stdio: 'inherit' });
}

export function stop(): void {
  requireElevation();
  execSync(`sc stop ${SERVICE_NAME}`, { stdio: 'inherit' });
}

function waitForStopped(timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = execSync(`sc query ${SERVICE_NAME}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.includes('STOPPED')) return;
    } catch {
      return; // Service doesn't exist or query failed — treat as stopped
    }
    execSync('timeout /t 1 /nobreak >nul 2>&1', { stdio: 'ignore' });
  }
}

export function restart(): void {
  requireElevation();
  stop();
  waitForStopped();
  start();
}

export function getLogPath(): string {
  return join(getNeuraHome(), 'logs', 'core.log');
}

export default {
  isInstalled,
  isRunning,
  install,
  uninstall,
  start,
  stop,
  restart,
  getLogPath,
} as const;
