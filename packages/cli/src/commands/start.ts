import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { getServiceManager } from '../service/manager.js';
import { waitForHealthy } from '../health.js';
import { checkForUpdateInBackground } from '../update-check.js';

export async function startCommand(): Promise<void> {
  const svc = await getServiceManager();
  const config = loadConfig();

  if (!svc.isInstalled()) {
    console.log(chalk.red('Service not installed. Run `neura install` first.'));
    process.exit(1);
  }

  if (svc.isRunning()) {
    console.log(chalk.yellow('Core is already running.'));
    return;
  }

  console.log('Starting core...');
  svc.start();

  const health = await waitForHealthy(config.port ?? 0);
  if (health) {
    console.log(chalk.green(`Core running on port ${health.port}`));
  } else {
    console.log(chalk.yellow('Core did not respond within 15s. Check: neura logs'));
  }

  checkForUpdateInBackground();
}
