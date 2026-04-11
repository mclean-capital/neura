import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { CLI_VERSION } from '../version.js';
import { getInstalledCoreVersion } from '../download.js';

const PACKAGE_NAME = '@mclean-capital/neura';

/**
 * Locate the CLI entrypoint inside the global npm install that was just
 * updated. We ask npm itself for the global `node_modules` root (the
 * authoritative answer) and join the package name to it.
 *
 * Why not just shell out to `neura`? After `npm install -g`, there is no
 * guarantee that the `neura` on PATH is the same install we just upgraded:
 * the user could have a linked `npm link` in a checkout, or a second
 * global prefix earlier on PATH. Spawning `process.execPath` with an
 * absolute entrypoint from the globally-installed package makes this
 * deterministic — we re-run the SAME Node binary against the SAME files
 * we just wrote.
 *
 * Returns null if the path can't be resolved (npm not on PATH, unusual
 * install layout); the caller falls back to printing a manual instruction.
 */
function resolveFreshCliEntrypoint(): string | null {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['root', '-g'], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0 || !result.stdout) return null;
  const globalRoot = result.stdout.trim();
  if (!globalRoot) return null;
  // npm packages with scopes live at <root>/@scope/name/
  const candidate = join(globalRoot, PACKAGE_NAME, 'dist', 'index.js');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Update Neura by reinstalling the npm package and restarting the core service.
 *
 * Since v1.11.0 the core ships bundled inside the CLI's npm package, so updates
 * are just a reinstall + service restart. No more GitHub release tarball download.
 */
export async function updateCommand(): Promise<void> {
  console.log();
  console.log(chalk.bold('  Neura — Update'));
  console.log();
  console.log(`  Current: ${CLI_VERSION} (core ${getInstalledCoreVersion() ?? 'unknown'})`);
  console.log();

  // Check the npm registry for the latest version
  let latest: string | null = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      latest = data.version ?? null;
    }
  } catch {
    // Registry unreachable — we'll still attempt the install, npm will handle it
  }

  if (latest) {
    console.log(`  Latest:  ${latest}`);
    console.log();
    if (latest === CLI_VERSION) {
      console.log(chalk.dim('  Already on latest — re-installing to repair any stale state'));
      console.log();
    }
  }
  // We intentionally DO NOT early-return when versions match. If the user's
  // global install is already on latest but the service file is stale (e.g.
  // after a v1.10 → v1.11 bootstrap, or an interrupted install), we still
  // want to run `npm install -g` and re-register the service below. Both
  // operations are idempotent and fast when nothing actually changes.

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(chalk.dim(`  Running: ${npmCmd} install -g ${PACKAGE_NAME}@latest`));
  console.log();

  const result = spawnSync(npmCmd, ['install', '-g', `${PACKAGE_NAME}@latest`], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    console.log();
    console.log(
      chalk.red(
        '  ✗ npm install failed. Check your network connection and try running the\n' +
          '    command above manually.'
      )
    );
    process.exit(1);
  }

  console.log();
  console.log(chalk.green('  ✓ Package updated'));

  // Re-register the service so it picks up the new core bundle path.
  //
  // CRITICAL: we must spawn a FRESH child process running the NEWLY
  // installed CLI entrypoint, not call service-manager code from this
  // function, and not shell out to `neura` on PATH. Here's why:
  //
  //   1. Stale in-memory code: after `npm install -g` finishes, the files
  //      on disk are the NEW version, but this Node process still has the
  //      OLD service-manager modules loaded in memory (plist/systemd/nssm
  //      templates, install logic, everything). Calling `svc.install()`
  //      from here would write the OLD service definition back to disk,
  //      defeating the entire point of the update.
  //
  //   2. Ambiguous PATH: shelling out to `neura` is not guaranteed to hit
  //      the install we just upgraded. The user might have a linked
  //      checkout (`npm link`) or a secondary global prefix earlier on
  //      PATH. The only deterministic way to reach the fresh install is
  //      to ask npm for `npm root -g` and invoke its entrypoint directly
  //      with `process.execPath` (the same Node binary we're running).
  console.log();
  console.log(chalk.dim('  Re-registering core service with new paths...'));
  const freshEntry = resolveFreshCliEntrypoint();
  if (!freshEntry) {
    console.log();
    console.log(
      chalk.yellow(
        '  Update complete but could not locate the upgraded package in\n' +
          "  npm's global node_modules. Run `neura install` manually to\n" +
          '  finish the upgrade.'
      )
    );
    return;
  }

  const installResult = spawnSync(process.execPath, [freshEntry, 'install', '--yes'], {
    stdio: 'inherit',
  });

  if (installResult.status !== 0) {
    console.log();
    console.log(
      chalk.yellow(
        '  Update complete but service re-registration failed.\n' +
          '  Run `neura install` manually to finish the upgrade.'
      )
    );
    process.exit(1);
  }

  console.log();
}
