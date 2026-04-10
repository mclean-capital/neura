import chalk from 'chalk';
import { loadConfig, getConfigValue, setConfigValue, getNeuraHome } from '../config.js';

const REDACTED_KEYS = new Set(['apiKeys.xai', 'apiKeys.google', 'authToken']);

export function configGetCommand(key: string): void {
  const value = getConfigValue(key);
  if (value === undefined) {
    console.log(chalk.red(`Key not found: ${key}`));
    process.exit(1);
  }
  if (REDACTED_KEYS.has(key)) {
    console.log(value.slice(0, 8) + '...');
  } else {
    console.log(value);
  }
}

export function configSetCommand(key: string, value: string): void {
  setConfigValue(key, value);
  console.log(chalk.green(`Set ${key}`));
}

export function configListCommand(): void {
  const config = loadConfig();
  console.log();
  console.log(chalk.bold('  Configuration'));
  console.log(`  port:              ${config.port}`);
  console.log(`  voice:             ${config.voice}`);
  console.log(
    `  apiKeys.xai:       ${config.apiKeys.xai ? config.apiKeys.xai.slice(0, 8) + '...' : chalk.dim('(not set)')}`
  );
  console.log(
    `  apiKeys.google:    ${config.apiKeys.google ? config.apiKeys.google.slice(0, 8) + '...' : chalk.dim('(not set)')}`
  );
  console.log(`  service.autoStart: ${config.service.autoStart}`);
  console.log(`  service.logLevel:  ${config.service.logLevel}`);
  console.log();
}

export function configPathCommand(): void {
  console.log(getNeuraHome());
}
