import chalk from 'chalk';
import { loadConfig, getNeuraHome } from '../config.js';
import { checkHealth } from '../health.js';
import { getServiceManager } from '../service/manager.js';
import { getPlatformLabel } from '../service/detect.js';

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port);
  const svc = await getServiceManager();

  console.log();
  console.log(chalk.bold('  Neura Core'));

  if (health) {
    console.log(`  Status:    ${chalk.green('running')} ${chalk.green('●')}`);
    console.log(`  Port:      ${health.port}`);
    console.log(`  Uptime:    ${formatUptime(health.uptime)}`);
    console.log(`  Health:    ${chalk.green('ok')}`);
  } else {
    console.log(`  Status:    ${chalk.red('stopped')} ${chalk.red('●')}`);
  }

  console.log(`  Home:      ${getNeuraHome()}`);
  console.log(
    `  Service:   ${getPlatformLabel()} (installed: ${svc.isInstalled() ? 'yes' : 'no'})`
  );
  console.log();
}
