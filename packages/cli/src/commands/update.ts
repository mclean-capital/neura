import chalk from 'chalk';
import { getLatestVersion, downloadCore, getInstalledCoreVersion } from '../download.js';

export async function updateCommand(): Promise<void> {
  console.log('Checking for updates...\n');

  try {
    const latest = await getLatestVersion();
    const installed = getInstalledCoreVersion();

    console.log(`  Latest:    ${latest}`);
    console.log(`  Installed: ${installed ?? 'not installed'}\n`);

    const latestClean = latest.replace(/^v/, '');
    const installedClean = installed?.replace(/^v/, '');

    if (installedClean === latestClean) {
      console.log(chalk.green('Already up to date.'));
      return;
    }

    console.log(`Downloading core ${latest}...`);
    await downloadCore(latest);
    console.log(chalk.green(`\nCore updated to ${latest}`));
  } catch (err) {
    console.log(
      chalk.red('\nUpdate failed: ' + (err instanceof Error ? err.message : String(err)))
    );
    process.exit(1);
  }
}
