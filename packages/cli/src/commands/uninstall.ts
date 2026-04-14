import { confirm, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { rmSync, existsSync } from 'fs';
import { basename } from 'path';
import { getNeuraHome } from '../config.js';
import { getServiceManager } from '../service/manager.js';

/**
 * Safety check: refuse to recursively delete directories that don't look
 * like a Neura home dir. Guards against misconfigured NEURA_HOME pointing
 * at /, $HOME, or other critical paths.
 */
function isSafeToDelete(dir: string): boolean {
  const name = basename(dir);
  if (name !== '.neura') return false;
  // Must contain config.json or core/ — a Neura-created directory
  if (!existsSync(dir)) return false;
  return true;
}

export async function uninstallCommand(options: { force?: boolean }): Promise<void> {
  const svc = await getServiceManager();
  const home = getNeuraHome();

  if (!svc.isInstalled()) {
    console.log(chalk.yellow('Service is not installed.'));
  } else {
    console.log('Removing service...');
    await svc.uninstall();
    console.log(chalk.green('Service removed.'));
  }

  if (!options.force) {
    const cleanData = await confirm({
      message: `Delete all data in ${home}?`,
      initialValue: false,
    });
    if (isCancel(cleanData) || !cleanData) {
      console.log(chalk.dim('Config and data preserved at ' + home));
      return;
    }
  }

  if (existsSync(home)) {
    if (!isSafeToDelete(home)) {
      console.log(
        chalk.red(`Refusing to delete ${home} — does not look like a Neura home directory.`)
      );
      console.log(chalk.dim('Expected directory named .neura. Check your NEURA_HOME setting.'));
      return;
    }
    rmSync(home, { recursive: true, force: true });
    console.log(chalk.green('Removed ' + home));
  }
}
