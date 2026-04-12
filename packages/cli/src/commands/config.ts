import chalk from 'chalk';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadConfig, getConfigValue, setConfigValue, getNeuraHome } from '../config.js';

const REDACTED_KEYS = new Set(['apiKeys.xai', 'apiKeys.google', 'authToken']);

/** List available wake-word classifier names from ~/.neura/models/ */
function getAvailableWakeWords(): string[] {
  const modelsDir = join(getNeuraHome(), 'models');
  const infra = new Set(['melspectrogram', 'embedding_model']);
  try {
    return readdirSync(modelsDir)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.replace('.onnx', ''))
      .filter((name) => !infra.has(name));
  } catch {
    return [];
  }
}

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
  // Block setting assistantName to a name without a matching .onnx
  // classifier. Without a classifier, wake-word detection silently
  // disables and the user only discovers the breakage next time
  // they go to passive mode. Failing fast with the list of valid
  // options is far better UX.
  if (key === 'assistantName') {
    const classifierPath = join(getNeuraHome(), 'models', `${value}.onnx`);
    if (!existsSync(classifierPath)) {
      const available = getAvailableWakeWords();
      console.log(chalk.red(`  ✗ No wake-word classifier found for "${value}".`));
      if (available.length > 0) {
        console.log(chalk.dim(`    Available wake words: ${available.join(', ')}`));
      } else {
        console.log(chalk.dim('    No classifiers installed. See: tools/wake-word/README.md'));
      }
      console.log(chalk.dim('    Train a custom wake word: tools/wake-word/scripts/train.sh'));
      process.exit(1);
      return; // unreachable in production; needed for test mock path
    }
  }

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
