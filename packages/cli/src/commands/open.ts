import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import chalk from 'chalk';
import { loadConfig, getNeuraHome } from '../config.js';
import { checkHealth } from '../health.js';

export async function openCommand(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port);

  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  // Check if web UI is installed
  const uiInstalled = existsSync(join(getNeuraHome(), 'ui', 'index.html'));
  if (!uiInstalled) {
    console.log(chalk.yellow('Web UI is not installed.'));
    console.log(chalk.dim(`Core is running on port ${health.port}, but ~/.neura/ui/ is empty.`));
    console.log(
      chalk.dim('Once the release pipeline is live, run `neura update` to download the UI.')
    );
    console.log();
    console.log(chalk.dim('In the meantime, connect with:'));
    console.log(chalk.dim(`  Desktop app:  Open the Neura desktop app`));
    console.log(chalk.dim(`  Dev UI:       npm run dev -w @neura/ui`));
    console.log(chalk.dim(`  Health:       curl http://localhost:${health.port}/health`));
    return;
  }

  const url = `http://localhost:${health.port}`;
  console.log(`Opening ${url}...`);

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
