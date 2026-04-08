import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';

export async function backupCommand(): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port);

  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  try {
    console.log('Creating memory backup...');

    const response = await fetch(`http://localhost:${config.port}/backup`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { status: string; path: string };
    console.log(chalk.green(`Backup saved to ${result.path}`));
  } catch (err) {
    console.log(chalk.red('Backup failed: ' + (err instanceof Error ? err.message : String(err))));
    process.exit(1);
  }
}

export async function restoreCommand(options: { force?: boolean }): Promise<void> {
  const config = loadConfig();
  const health = await checkHealth(config.port);

  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  if (!options.force) {
    const confirmed = await confirm({
      message: 'Restore memories from backup? Existing memories may be overwritten.',
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Restore cancelled.'));
      return;
    }
  }

  try {
    console.log('Restoring from backup...');

    const response = await fetch(`http://localhost:${config.port}/restore`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { status: string; imported: number; skipped: number };
    console.log(chalk.green('Restore complete'));
    console.log(`  Imported: ${result.imported ?? 0}`);
    console.log(`  Skipped:  ${result.skipped ?? 0}`);
  } catch (err) {
    console.log(chalk.red('Restore failed: ' + (err instanceof Error ? err.message : String(err))));
    process.exit(1);
  }
}
