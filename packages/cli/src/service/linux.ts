import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getNeuraHome } from '../config.js';
import { getCoreBinaryPath } from '../download.js';

const SERVICE_NAME = 'neura-core';

function getUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

export function isInstalled(): boolean {
  return existsSync(getUnitPath());
}

export function isRunning(): boolean {
  try {
    execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function install(): void {
  const home = getNeuraHome();
  const binaryPath = getCoreBinaryPath();
  // The core binary is a JavaScript module (server.bundled.mjs), not an
  // executable — systemd cannot exec it directly. Use the Node binary that's
  // running this CLI to invoke it. Both paths are wrapped in double quotes
  // so they survive paths containing spaces (e.g., nvm under a username
  // with whitespace). If the user moves or upgrades Node later, re-run
  // `neura install` to refresh ExecStart.
  const nodePath = process.execPath;
  const unitPath = getUnitPath();

  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });

  const unit = `[Unit]
Description=Neura Core Service
After=network.target

[Service]
Type=simple
ExecStart="${nodePath}" "${binaryPath}"
WorkingDirectory=${home}
Restart=on-failure
RestartSec=5
Environment=NEURA_HOME=${home}
Environment=NODE_ENV=production
StandardOutput=append:${home}/logs/core.log
StandardError=append:${home}/logs/core.error.log

[Install]
WantedBy=default.target
`;

  writeFileSync(unitPath, unit, 'utf-8');
  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'inherit' });
}

export function uninstall(): void {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' });
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch {
    // May not be running/enabled
  }
  const unitPath = getUnitPath();
  if (existsSync(unitPath)) unlinkSync(unitPath);
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
  } catch {
    // Best effort
  }
}

export function start(): void {
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'inherit' });
}

export function stop(): void {
  execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'inherit' });
}

export function restart(): void {
  execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'inherit' });
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
