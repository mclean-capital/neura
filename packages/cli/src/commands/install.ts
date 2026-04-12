import { input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
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
import { hasCoreBinary, getBundledModelsDir } from '../download.js';
import { findFreePort } from '../port.js';

/**
 * Copy any ONNX wake-word models shipped inside the CLI package into
 * `$NEURA_HOME/models/`, but NEVER overwrite files that already exist.
 *
 * Why "never overwrite": users who train their own classifiers with
 * `tools/wake-word/scripts/train.sh` deploy them to the same directory
 * via `deploy.sh`. Overwriting on every `neura install` would clobber
 * their trained models on each upgrade. First-write-wins means the
 * bundled defaults only fill in gaps — once a user has their own
 * `jarvis.onnx` in place, the bundled one stops being used.
 *
 * Returns the list of files actually copied so the caller can print a
 * one-line summary to the user.
 */
function installBundledModels(neuraHome: string): string[] {
  const src = getBundledModelsDir();
  if (!existsSync(src)) return []; // Running from dev / unusual layout

  const dest = join(neuraHome, 'models');
  mkdirSync(dest, { recursive: true });

  const copied: string[] = [];
  try {
    for (const entry of readdirSync(src)) {
      if (!entry.endsWith('.onnx')) continue;
      const destPath = join(dest, entry);
      if (existsSync(destPath)) continue; // Keep user-trained models
      copyFileSync(join(src, entry), destPath);
      copied.push(entry);
    }
  } catch {
    // Non-fatal: failing to seed the bundled models shouldn't block the
    // whole install. The core will print a clear warning at connection
    // time if models are missing, and the user can copy them manually.
  }
  return copied;
}

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

  // Seed the wake-word models if they aren't already installed. This
  // runs every `neura install` but is a no-op after the first one —
  // existing files are never overwritten, so user-trained classifiers
  // take priority. Prints a one-line summary if anything was copied
  // along with the list of available wake words.
  const seededModels = installBundledModels(home);
  {
    const modelsDir = join(home, 'models');
    const infra = new Set(['melspectrogram', 'embedding_model']);
    let available: string[] = [];
    try {
      available = readdirSync(modelsDir)
        .filter((f) => f.endsWith('.onnx'))
        .map((f) => f.replace('.onnx', ''))
        .filter((name) => !infra.has(name));
    } catch {
      // models dir might not exist yet on a completely bare install
    }

    if (seededModels.length > 0 || available.length > 0) {
      console.log();
      console.log(chalk.dim('  Wake word models'));
      if (seededModels.length > 0) {
        console.log(
          chalk.green(`  ✓ Installed ${seededModels.length} model(s) to ${home}/models/`)
        );
      }
      if (available.length > 0) {
        console.log(chalk.dim(`  Available wake words: ${available.join(', ')}`));
        console.log(
          chalk.dim(
            `  Active: ${config.assistantName ?? 'jarvis'} (set via: neura config set assistantName <name>)`
          )
        );
      }
    }
  }

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

    // Windows has two install paths (Scheduled Task → preferred, or
    // Startup folder shim → fallback). Tell the user which one was
    // used so they understand what to expect — e.g. Task Scheduler
    // manageability vs. runs-on-next-login. Empty import on non-Windows.
    if (process.platform === 'win32') {
      const win = await import('../service/windows.js');
      const mode = win.getLastInstallMode();
      if (mode === 'startup-shim') {
        console.log(
          chalk.dim(
            '  (Using Startup folder shim — schtasks.exe refused to register\n' +
              '   the Scheduled Task on this machine, likely due to Windows\n' +
              '   policy or corporate restrictions. The core will still run\n' +
              '   at each user login. It can be removed from\n' +
              '   %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\.)'
          )
        );
      } else if (mode === 'scheduled-task') {
        console.log(chalk.dim('  (Registered in Task Scheduler under name "neura-core")'));
      }
    }

    svc.start();
    serviceRegistered = true;
  } catch (err) {
    console.log(chalk.yellow('  Service registration skipped:'));
    console.log(chalk.yellow('  ' + (err instanceof Error ? err.message : String(err))));
    console.log(chalk.dim('  Config was saved. Try again after resolving the issue.'));
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

// Exported for tests only.
export const __test__ = {
  installBundledModels,
};
