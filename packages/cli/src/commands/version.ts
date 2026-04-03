import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';
import { hasCoreBinary } from '../download.js';

// CLI version comes from package.json at build time
const CLI_VERSION = '0.0.0';

export async function versionCommand(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port);

  console.log(`neura-cli  ${CLI_VERSION}`);
  if (health) {
    console.log(`neura-core running (port ${health.port}, uptime ${Math.floor(health.uptime)}s)`);
  } else if (hasCoreBinary()) {
    console.log(`neura-core installed ${chalk.dim('(not running)')}`);
  } else {
    console.log(`neura-core ${chalk.dim('(not installed)')}`);
  }
}
