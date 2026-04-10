import { input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  ensureNeuraHome,
  loadConfig,
  saveConfig,
  getNeuraHome,
  generateAuthToken,
} from '../config.js';
import { getServiceManager } from '../service/manager.js';
import { getPlatformLabel } from '../service/detect.js';
import { checkHealth, waitForHealthy } from '../health.js';
import { hasCoreBinary } from '../download.js';
import { findFreePort } from '../port.js';

export async function installCommand(): Promise<void> {
  const home = getNeuraHome();

  console.log();
  console.log(chalk.bold('  Neura Core — Setup'));
  console.log();
  console.log(`  Platform:  ${getPlatformLabel()}`);
  console.log(`  Home:      ${home}`);
  console.log();

  // Check if already installed (skip if port not yet assigned)
  const currentConfig = loadConfig();
  const existing = currentConfig.port > 0 ? await checkHealth(currentConfig.port) : null;
  if (existing) {
    console.log(chalk.green('  Core is already running on port ' + existing.port));
    const reinstall = await confirm({
      message: 'Reinstall?',
      default: false,
    });
    if (!reinstall) return;
  }

  // Ensure directory structure
  ensureNeuraHome();
  const config = loadConfig();

  // API keys
  console.log(chalk.dim('  API Keys'));
  const xaiKey =
    (await password({
      message: `XAI_API_KEY${config.apiKeys.xai ? ' (press Enter to keep existing)' : ''}:`,
      mask: '*',
    })) || config.apiKeys.xai;
  const googleKey =
    (await password({
      message: `GOOGLE_API_KEY${config.apiKeys.google ? ' (press Enter to keep existing)' : ''}:`,
      mask: '*',
    })) || config.apiKeys.google;

  // Port — auto-assign unless user already has one configured
  console.log();
  console.log(chalk.dim('  Port'));
  let port: number;
  if (config.port > 0) {
    // User has a previously configured port — keep it
    port = config.port;
    console.log(`  Using configured port: ${port}`);
  } else {
    // Auto-assign a free port in the 18000-19000 range
    port = await findFreePort();
    console.log(chalk.green(`  ✓ Auto-assigned: ${port}`));
  }
  const customPort = await input({
    message: 'Custom port? (leave blank to keep):',
    default: '',
    validate: (v) => {
      if (v === '') return true;
      if (!/^\d+$/.test(v)) return 'Must be a number';
      const n = parseInt(v, 10);
      if (n < 1 || n > 65535) return 'Must be 1-65535';
      return true;
    },
  });
  if (customPort) {
    port = parseInt(customPort, 10);
  }

  // Voice
  const voice = await input({
    message: 'Voice:',
    default: config.voice,
  });

  // Generate auth token if not already set
  if (!config.authToken) {
    config.authToken = generateAuthToken();
  }

  // Save config
  config.apiKeys.xai = xaiKey;
  config.apiKeys.google = googleKey;
  config.port = port;
  config.voice = voice;
  saveConfig(config);

  console.log();
  console.log(chalk.dim('  Config saved to ' + home + '/config.json'));
  console.log(chalk.dim('  Auth token: ' + chalk.bold('generated')));

  // Check for core binary
  if (!hasCoreBinary()) {
    console.log();
    console.log(
      chalk.yellow(
        '  Core binary not found. Try:\n' +
          '    neura update      Download the latest core binary\n' +
          '    neura uninstall   Reset and start fresh'
      )
    );
    console.log();
    return;
  }

  // Register service
  console.log();
  console.log(chalk.dim('  Registering service...'));
  let serviceRegistered = false;
  try {
    const svc = await getServiceManager();

    if (svc.isInstalled()) {
      console.log(chalk.dim('  Service already registered, restarting...'));
      svc.restart();
      serviceRegistered = true;
    } else {
      await svc.install();
      console.log(chalk.green('  ✓ Service registered (' + getPlatformLabel() + ')'));
      svc.start();
      serviceRegistered = true;
    }
  } catch (err) {
    console.log(chalk.yellow('  Service registration skipped:'));
    console.log(chalk.yellow('  ' + (err instanceof Error ? err.message : String(err))));
    console.log(chalk.dim('  Config was saved. You can run core manually:'));
    console.log(chalk.dim('    npm run dev -w @neura/core'));
  }

  // Wait for health (only if service was started)
  if (serviceRegistered) {
    console.log(chalk.dim('  Starting core...'));
    const health = await waitForHealthy(config.port);
    if (health) {
      console.log(chalk.green(`  ✓ Core running on ws://localhost:${health.port}`));
      console.log(chalk.green('  ✓ Health check: ok'));
    } else {
      console.log(chalk.yellow('  Core did not respond within 15s. Check logs: neura logs'));
    }
  }

  console.log();
  if (serviceRegistered) {
    console.log(chalk.bold('  Done!') + ' Connect with any client:');
    console.log('    Desktop:  Open the Neura desktop app');
    console.log('    Web:      neura open');
    console.log('    Status:   neura status');
    console.log('    Logs:     neura logs');
  } else {
    console.log(chalk.bold('  Config saved.') + ' Service not yet running.');
    console.log('    neura start    Start the service');
    console.log('    neura status   Check service state');
  }
  console.log();
}
