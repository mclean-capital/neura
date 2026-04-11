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

export interface InstallOptions {
  /**
   * Skip all prompts and reuse existing config.
   *
   * Used by `neura update`: after `npm install -g` replaces files on disk,
   * update spawns `neura install --yes` to re-register the service using the
   * NEW service-manager templates. The parent update process has the OLD
   * code loaded in memory — we cannot reuse it to do the re-registration or
   * we'd write the old templates back.
   */
  yes?: boolean;
}

export async function installCommand(opts: InstallOptions = {}): Promise<void> {
  const nonInteractive = !!opts.yes;
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
    if (!nonInteractive) {
      const reinstall = await confirm({
        message: 'Reinstall?',
        default: false,
      });
      if (!reinstall) return;
    }
    // --yes: proceed without asking (this is exactly the post-update path)
  }

  // Ensure directory structure
  ensureNeuraHome();
  const config = loadConfig();

  // API keys — in --yes mode, reuse whatever is already in config.json.
  // The user already entered these on a previous install; the update
  // flow should not re-prompt for them.
  let xaiKey = config.apiKeys.xai;
  let googleKey = config.apiKeys.google;
  if (!nonInteractive) {
    console.log(chalk.dim('  API Keys'));
    xaiKey =
      (await password({
        message: `XAI_API_KEY${config.apiKeys.xai ? ' (press Enter to keep existing)' : ''}:`,
        mask: '*',
      })) || config.apiKeys.xai;
    googleKey =
      (await password({
        message: `GOOGLE_API_KEY${config.apiKeys.google ? ' (press Enter to keep existing)' : ''}:`,
        mask: '*',
      })) || config.apiKeys.google;
  }

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
  if (!nonInteractive) {
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
  }

  // Voice
  const voice = nonInteractive
    ? config.voice
    : await input({
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

  // Sanity check — core is bundled inside this npm package since v1.11.0,
  // so it should always be present. If it isn't, the user's CLI install is
  // corrupted and the only fix is reinstalling from npm.
  if (!hasCoreBinary()) {
    console.log();
    console.log(
      chalk.red(
        '  ✗ Core bundle not found inside this CLI install.\n' +
          '    This indicates a broken installation. Fix with:\n' +
          '      npm install -g @mclean-capital/neura@latest'
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
    const wasInstalled = svc.isInstalled();

    // Always (re)write the service definition. If we only restarted when the
    // service was already registered, an upgrade that fixes the service file
    // (e.g. macOS plist ProgramArguments, systemd ExecStart) would never take
    // effect — the on-disk file would stay stale. Stop the old service first
    // so the new file gets cleanly loaded.
    if (wasInstalled) {
      try {
        svc.stop();
      } catch {
        // Service may not be running — that's fine.
      }
    }
    await svc.install();
    console.log(
      chalk.green(
        `  ✓ Service ${wasInstalled ? 're-registered' : 'registered'} (${getPlatformLabel()})`
      )
    );
    svc.start();
    serviceRegistered = true;
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
