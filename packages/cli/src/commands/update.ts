import chalk from 'chalk';
import { getLatestVersion, downloadCore } from '../download.js';

export async function updateCommand(): Promise<void> {
  console.log('Checking for updates...');

  try {
    const version = await getLatestVersion();
    console.log(`Latest version: ${version}`);

    console.log('Downloading core binary...');
    downloadCore(version); // throws until release pipeline is set up
  } catch (err) {
    console.log(chalk.red('Update failed: ' + (err instanceof Error ? err.message : String(err))));
    process.exit(1);
  }
}
