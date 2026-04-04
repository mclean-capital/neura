import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';
import { hasCoreBinary, getInstalledCoreVersion } from '../download.js';

const CLI_VERSION = process.env.NEURA_VERSION ?? '0.0.0-dev';

export async function versionCommand(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port);
  const installedVersion = getInstalledCoreVersion();

  console.log(`neura-cli  ${CLI_VERSION}`);

  if (health) {
    const coreVersion = health.version ?? installedVersion ?? 'unknown';
    console.log(`neura-core ${coreVersion} (running, port ${health.port})`);
  } else if (installedVersion) {
    console.log(`neura-core ${installedVersion} ${chalk.dim('(installed, not running)')}`);
  } else if (hasCoreBinary()) {
    console.log(`neura-core ${chalk.dim('(installed, version unknown)')}`);
  } else {
    console.log(`neura-core ${chalk.dim('(not installed)')}`);
  }
}
