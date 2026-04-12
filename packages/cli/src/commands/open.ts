import { spawn } from 'child_process';
import { platform } from 'os';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';

export async function openCommand(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port ?? 3002);

  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  const token = config.authToken;
  const url = token
    ? `http://localhost:${health.port}?token=${encodeURIComponent(token)}`
    : `http://localhost:${health.port}`;
  console.log(`Opening ${url.split('?')[0]}...`);

  // Use spawn with explicit args to avoid shell interpolation
  const os = platform();
  const cmd = os === 'win32' ? 'cmd' : os === 'darwin' ? 'open' : 'xdg-open';
  const args = os === 'win32' ? ['/c', 'start', '', url] : [url];

  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
  child.on('error', (err) => {
    console.log(chalk.yellow('Could not open browser: ' + err.message));
  });
}
