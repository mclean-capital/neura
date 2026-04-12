import chalk from 'chalk';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadConfig, getConfigValue, setConfigValue, getNeuraHome } from '../config.js';

/** Keys that should be redacted when displayed */
function isRedactedKey(key: string): boolean {
  // Redact any providers.*.apiKey and authToken
  return /^providers\.\w+\.apiKey$/.test(key) || key === 'authToken';
}

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
  if (isRedactedKey(key)) {
    console.log(value.slice(0, 8) + '...');
  } else {
    console.log(value);
  }
}

export function configSetCommand(key: string, value: string): void {
  // Block setting wakeWord to a name without a matching .onnx classifier
  if (key === 'wakeWord' || key === 'assistantName') {
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

  // Providers
  const providerIds = Object.keys(config.providers);
  if (providerIds.length > 0) {
    console.log(chalk.bold('  Providers:'));
    for (const id of providerIds) {
      const key = config.providers[id].apiKey;
      const display = key ? key.slice(0, 8) + '...' : chalk.dim('(not set)');
      console.log(`    ${id}: ${display}`);
    }
  } else {
    console.log(`  providers: ${chalk.dim('(none configured)')}`);
  }

  // Routing
  console.log(chalk.bold('  Routing:'));
  const r = config.routing;
  const fmtRoute = (route?: { provider: string; model: string }) =>
    route ? `${route.provider}/${route.model}` : chalk.dim('(not configured)');
  if (r.voice) {
    console.log(
      `    voice:     ${r.voice.mode === 'realtime' ? `${r.voice.provider}/${r.voice.model}` : 'pipeline'}`
    );
  } else {
    console.log(`    voice:     ${chalk.dim('(not configured)')}`);
  }
  console.log(
    `    vision:    ${r.vision ? `${fmtRoute(r.vision)} (${r.vision.mode})` : chalk.dim('(not configured)')}`
  );
  console.log(`    text:      ${fmtRoute(r.text)}`);
  console.log(
    `    embedding: ${r.embedding ? `${fmtRoute(r.embedding)} (${r.embedding.dimensions}d)` : chalk.dim('(not configured)')}`
  );
  console.log(`    worker:    ${fmtRoute(r.worker)}`);

  // Other settings
  if (config.port != null) console.log(`  port: ${config.port}`);
  if (config.wakeWord) console.log(`  wakeWord: ${config.wakeWord}`);
  if (config.assistantName) console.log(`  assistantName: ${config.assistantName}`);
  console.log();
}

export function configPathCommand(): void {
  console.log(getNeuraHome());
}
