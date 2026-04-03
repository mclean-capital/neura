import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getNeuraHome } from '../config.js';
import { getCoreBinaryPath } from '../download.js';

const LABEL = 'com.neura.core';

function getPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** Escape XML special characters for safe plist interpolation. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function isInstalled(): boolean {
  return existsSync(getPlistPath());
}

export function isRunning(): boolean {
  try {
    const result = execSync(`launchctl list ${LABEL}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // launchctl list <label> outputs a table with "PID" in the header.
    // When running, the PID line shows a number. When stopped, it shows "-".
    // Format: "PID" = <number> or "-"
    const pidMatch = /"PID"\s*=\s*(\S+)/.exec(result);
    if (pidMatch) return pidMatch[1] !== '-' && pidMatch[1] !== '0';

    // Fallback: first line of tabular output is "<pid>\t<status>\t<label>"
    const lines = result.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[2] === LABEL) {
        return parts[0] !== '-' && parts[0] !== '0';
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function install(): void {
  const home = escapeXml(getNeuraHome());
  const binaryPath = escapeXml(getCoreBinaryPath());
  const plistPath = getPlistPath();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${home}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/logs/core.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/logs/core.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NEURA_HOME</key>
    <string>${home}</string>
  </dict>
</dict>
</plist>`;

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, 'utf-8');
}

export function uninstall(): void {
  const plistPath = getPlistPath();
  try {
    execSync(`launchctl unload -w "${plistPath}"`, { stdio: 'ignore' });
  } catch {
    // May not be loaded
  }
  if (existsSync(plistPath)) unlinkSync(plistPath);
}

export function start(): void {
  execSync(`launchctl load -w "${getPlistPath()}"`, { stdio: 'inherit' });
}

export function stop(): void {
  execSync(`launchctl unload "${getPlistPath()}"`, { stdio: 'inherit' });
}

export function restart(): void {
  stop();
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
