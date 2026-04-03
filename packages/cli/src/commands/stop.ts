import chalk from 'chalk';
import { getServiceManager } from '../service/manager.js';

export async function stopCommand(): Promise<void> {
  const svc = await getServiceManager();

  if (!svc.isInstalled()) {
    console.log(chalk.red('Service not installed. Run `neura install` first.'));
    process.exit(1);
  }

  if (!svc.isRunning()) {
    console.log(chalk.yellow('Core is already stopped.'));
    return;
  }

  console.log('Stopping core...');
  svc.stop();
  console.log(chalk.green('Core stopped.'));
}
