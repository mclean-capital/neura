import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync, spawnSync, spawn } from 'child_process';
import { getNeuraHome } from '../config.js';
import { getCoreBinaryPath } from '../download.js';

const TASK_NAME = 'neura-core';

/**
 * Windows service manager.
 *
 * Windows does not have a clean "run as background service" path for a
 * voice-first AI assistant. A real SCM service (via nssm/WinSW) requires
 * admin rights to install and runs in Session 0, which is isolated from
 * the user's audio devices — the microphone is unreachable from a
 * LocalSystem service. That makes wake-word detection impossible.
 *
 * So we do what `openclaw` does on Windows:
 *
 *   1. Primary path — `schtasks.exe /Create /SC ONLOGON /RL LIMITED` to
 *      register a per-user logon-triggered Scheduled Task. `/RL LIMITED`
 *      keeps the task out of the elevated-integrity bucket, so no UAC
 *      prompt, no admin rights, no bundled service wrapper.
 *
 *   2. Fallback path — if schtasks.exe refuses (GPO, corporate lockdown,
 *      "access denied" on `/Create`), drop a `neura-core.cmd` shim into
 *      `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`. The
 *      shim runs on next logon; on first install we also spawn the core
 *      detached immediately so the user doesn't have to log out to get
 *      a working assistant.
 *
 *   3. Dual state — every lifecycle op (`isInstalled`, `stop`, `restart`,
 *      `uninstall`) has to handle both "Scheduled Task is registered"
 *      and "Startup shim is present". They're mutually-exclusive install
 *      states but the code has to check both.
 *
 * Trade-offs we accept:
 *   - The core only runs while the user is logged in (dies on logout).
 *   - Status telemetry is weaker than a real service (no exit-code
 *     history, no restart policy beyond "schtasks will re-run on next
 *     logon"). We compensate with a PID file for `isRunning` / `stop`.
 *   - No pre-login boot. If you want that, use macOS or Linux.
 */

interface ShimContext {
  nodePath: string;
  corePath: string;
  home: string;
  logDir: string;
  logFile: string;
  errLogFile: string;
  pidFile: string;
  cmdPath: string;
}

function getShimContext(): ShimContext {
  const home = getNeuraHome();
  const logDir = join(home, 'logs');
  return {
    nodePath: process.execPath,
    corePath: getCoreBinaryPath(),
    home,
    logDir,
    logFile: join(logDir, 'core.log'),
    errLogFile: join(logDir, 'core.error.log'),
    pidFile: join(home, 'neura-core.pid'),
    cmdPath: join(home, 'neura-core.cmd'),
  };
}

function getStartupShimPath(): string {
  // %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\neura-core.cmd
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    `${TASK_NAME}.cmd`
  );
}

/**
 * Escape a string for safe embedding in a Windows `cmd.exe` batch file.
 *
 * The rules here are painful: `cmd.exe` treats `%`, `^`, `&`, `|`, `<`, `>`
 * as special outside quoted strings, and `%` is still special inside quotes
 * when it looks like an environment variable reference. We use `^` to
 * escape the metacharacters and double `%%` so environment-variable
 * expansion only happens where we actually want it.
 */
function escapeCmd(str: string): string {
  return str
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/([&|<>])/g, '^$1');
}

/**
 * Produce the contents of the launcher `.cmd` file that the Scheduled
 * Task (or the Startup folder shim) will invoke on each logon.
 *
 * The shim is intentionally dumb: set NEURA_HOME so the core knows
 * where to read `config.json` from, redirect output to log files, then
 * exec Node on the core bundle.
 *
 * IMPORTANT: the shim sets ONLY `NEURA_HOME`. It does NOT bake in the
 * port, auth token, or API keys from the install-time config — even
 * though we have those values handy. Reason: the core's config loader
 * in `packages/core/src/config/config.ts` prefers `process.env.*` over
 * `file.*`, so any value baked into the shim would win over the user's
 * live `config.json`. That meant `neura config set port 20000` (or
 * `config set apiKeys.xai ...`) would silently do nothing on Windows
 * until the user re-ran `neura install`, because the old values in the
 * shim's `set` statements still shadowed the new ones in `config.json`.
 * By shipping only `NEURA_HOME`, all runtime config flows through
 * `config.json` → the core reads the latest values on every restart,
 * matching the macOS and Linux behavior.
 *
 * The shim also does NOT track PIDs — the core writes its own
 * `$NEURA_HOME/neura-core.pid` on startup (see
 * `packages/core/src/server/lifecycle.ts`), which `isRunning()` and
 * `stop()` key off of.
 */
function renderCmdShim(ctx: ShimContext): string {
  // Notes:
  //   - `@echo off` suppresses command echoing.
  //   - `chcp 65001 >nul` sets the console to UTF-8 so pino's log output
  //     doesn't mangle when it contains non-ASCII characters.
  //   - stdout/stderr are redirected with `>> "<log>" 2>> "<err>"` so
  //     we don't need a separate supervisor for log capture.
  return `@echo off\r
chcp 65001 >nul\r
set "NEURA_HOME=${escapeCmd(ctx.home)}"\r
if not exist "${escapeCmd(ctx.logDir)}" mkdir "${escapeCmd(ctx.logDir)}"\r
echo %~nx0 started at %date% %time% >> "${escapeCmd(ctx.logFile)}"\r
"${escapeCmd(ctx.nodePath)}" "${escapeCmd(ctx.corePath)}" >> "${escapeCmd(ctx.logFile)}" 2>> "${escapeCmd(ctx.errLogFile)}"\r
`;
}

/**
 * Write the shim .cmd that both the Scheduled Task and the Startup
 * folder fallback invoke. Idempotent — overwrites whatever's there.
 */
function writeCmdShim(ctx: ShimContext): void {
  mkdirSync(dirname(ctx.cmdPath), { recursive: true });
  mkdirSync(ctx.logDir, { recursive: true });
  writeFileSync(ctx.cmdPath, renderCmdShim(ctx), 'utf-8');
}

/**
 * Register the Scheduled Task via `schtasks /Create`.
 *
 * Returns true on success, false on failure. Never throws — we want the
 * caller to cleanly fall back to the Startup-folder path without trying
 * to parse schtasks's error output.
 */
function tryCreateScheduledTask(ctx: ShimContext): boolean {
  // /F = force overwrite of existing task
  // /SC ONLOGON = trigger on user logon (no admin needed)
  // /RL LIMITED = limited run level — NOT elevated, no UAC prompt
  // /TN = task name
  // /TR = the command to run; must be fully quoted when it contains
  //       a path with spaces. schtasks does its own quoting layer which
  //       means we end up needing \" inside the outer quotes. spawnSync
  //       handles the outer argv layer, so we just pass the path with
  //       embedded quotes.
  const result = spawnSync(
    'schtasks.exe',
    [
      '/Create',
      '/F',
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      '/TN',
      TASK_NAME,
      '/TR',
      `"${ctx.cmdPath}"`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );
  return result.status === 0;
}

/**
 * Check whether the Scheduled Task exists.
 *
 * `schtasks /Query /TN <name>` returns exit 0 if the task exists, 1 if
 * it doesn't (and also writes a message to stderr that we don't need).
 */
function isTaskRegistered(): boolean {
  const result = spawnSync('schtasks.exe', ['/Query', '/TN', TASK_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  return result.status === 0;
}

function deleteScheduledTask(): void {
  spawnSync('schtasks.exe', ['/Delete', '/F', '/TN', TASK_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
}

function isStartupShimInstalled(): boolean {
  return existsSync(getStartupShimPath());
}

function installStartupShim(ctx: ShimContext): void {
  const shimPath = getStartupShimPath();
  mkdirSync(dirname(shimPath), { recursive: true });
  // The startup-folder file is a tiny launcher that calls the real shim
  // in NEURA_HOME. We keep the real shim in NEURA_HOME so `neura config`
  // can regenerate it without touching Windows-managed directories.
  const launcher = `@echo off\r\nstart "" /min cmd.exe /d /c "${escapeCmd(ctx.cmdPath)}"\r\n`;
  writeFileSync(shimPath, launcher, 'utf-8');
}

function removeStartupShim(): void {
  const shimPath = getStartupShimPath();
  if (existsSync(shimPath)) unlinkSync(shimPath);
}

/**
 * Spawn the launcher `.cmd` as a detached child so the core starts
 * immediately on first install (instead of waiting for the next logon).
 *
 * We use `spawn` + `{ detached: true, stdio: 'ignore' }` + `.unref()` so
 * the parent `neura install` process can exit cleanly while core keeps
 * running. `windowsHide: true` suppresses the flash of a cmd console.
 */
function spawnDetachedCore(ctx: ShimContext): void {
  const child = spawn('cmd.exe', ['/d', '/c', ctx.cmdPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

// ── ServiceManager interface ─────────────────────────────────────────

export function isInstalled(): boolean {
  return isTaskRegistered() || isStartupShimInstalled();
}

/**
 * Unlink the pid file, swallowing "already gone" errors. Used by
 * `isRunning()` to self-heal stale pid files left behind when the core
 * dies without running its cleanup handlers (crash, `taskkill /F`, OS
 * reboot).
 */
function unlinkPidFile(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    // Already removed; fine.
  }
}

/**
 * Check if the core process is currently alive.
 *
 * Reads `$NEURA_HOME/neura-core.pid` (written by the core itself in
 * `packages/core/src/server/lifecycle.ts`) and asks `tasklist` whether
 * a process with that PID is running. Any living process is treated as
 * "the core" — we don't fingerprint by name, which matches the contract
 * of `stop()` below.
 *
 * Self-heals stale pid files: if the file exists but refers to a dead
 * or unreadable PID, we delete it as a side-effect so the next
 * `isRunning()` / `start()` call isn't fooled by Windows PID reuse
 * (which is real and can happen within seconds on busy machines).
 */
export function isRunning(): boolean {
  const ctx = getShimContext();
  if (!existsSync(ctx.pidFile)) return false;

  let pid: number;
  try {
    pid = parseInt(readFileSync(ctx.pidFile, 'utf-8').trim(), 10);
  } catch {
    unlinkPidFile(ctx.pidFile);
    return false;
  }
  if (!pid || Number.isNaN(pid)) {
    unlinkPidFile(ctx.pidFile);
    return false;
  }

  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  // tasklist prints "INFO: No tasks are running..." when PID is missing.
  const alive = typeof result.stdout === 'string' && !result.stdout.includes('No tasks');
  if (!alive) {
    unlinkPidFile(ctx.pidFile);
  }
  return alive;
}

/**
 * Which of the two dual-path install modes was used.
 *
 * `scheduled-task` is the preferred path — registered via schtasks,
 * managed from Task Scheduler. `startup-shim` is the fallback used when
 * schtasks refuses (access denied, GPO lockdown, etc.). Exposed so the
 * caller can tell the user which path was taken and what it means.
 */
export type InstallMode = 'scheduled-task' | 'startup-shim';

let lastInstallMode: InstallMode | null = null;

/** The install mode used by the most recent install() call, or null. */
export function getLastInstallMode(): InstallMode | null {
  return lastInstallMode;
}

export function install(): void {
  const ctx = getShimContext();

  // Always regenerate the launcher shim so it picks up any new paths
  // or config changes since the last install. Idempotent: overwriting
  // the .cmd file is safe whether or not the task is already registered.
  writeCmdShim(ctx);

  // Prefer the Scheduled Task path — it survives reboots cleanly and
  // shows up in Task Scheduler so the user can manage it from the GUI.
  // If it fails (GPO, corp lockdown, schtasks.exe missing from PATH,
  // or a Windows config that requires elevation for user-level tasks),
  // fall back to a Startup folder shim. Both paths register the same
  // shim; they just differ in how Windows invokes it at logon.
  //
  // Both branches clean up the OTHER install mode so we never end up
  // with a task AND a startup shim both firing at next logon. Without
  // this symmetric cleanup, a reinstall that changes which path wins
  // (e.g. a machine that previously accepted schtasks /Create but later
  // tightened GPO) would leave both modes active — the next logon would
  // start two copies of core, and because server.ts retries EADDRINUSE
  // on port+1 the second copy comes up on a different port instead of
  // failing loudly.
  const taskCreated = tryCreateScheduledTask(ctx);
  if (taskCreated) {
    lastInstallMode = 'scheduled-task';
    removeStartupShim();
  } else {
    lastInstallMode = 'startup-shim';
    deleteScheduledTask();
    installStartupShim(ctx);
  }

  // NOTE: we do NOT spawn the core here. The caller (`installCommand`)
  // always calls `svc.start()` right after `svc.install()`, and start()
  // already handles the "spawn detached so the user gets a working core
  // without logging out" behavior. Starting it here too would race the
  // pid-file write with start()'s own isRunning() check and leave the
  // user with two concurrent cores fighting for the same port.
}

export function uninstall(): void {
  stop();
  deleteScheduledTask();
  removeStartupShim();
  // Leave NEURA_HOME/neura-core.cmd in place — it's harmless and is
  // re-written on next `neura install`. Don't delete NEURA_HOME itself;
  // that's the user's config + memory store.
}

export function start(): void {
  if (isRunning()) return;
  spawnDetachedCore(getShimContext());
}

export function stop(): void {
  const ctx = getShimContext();
  if (!existsSync(ctx.pidFile)) return;

  let pid: number;
  try {
    pid = parseInt(readFileSync(ctx.pidFile, 'utf-8').trim(), 10);
  } catch {
    // Corrupt pid file — nothing to kill, just clean the stale file.
    unlinkPidFile(ctx.pidFile);
    return;
  }
  if (!pid || Number.isNaN(pid)) {
    unlinkPidFile(ctx.pidFile);
    return;
  }

  // `taskkill /T` walks the child-process tree so we catch both the
  // launcher cmd.exe and the Node process it spawned. `/F` is force —
  // we don't wait for graceful shutdown; the core's SIGTERM handlers
  // wouldn't fire anyway because Node on Windows can't receive
  // SIGTERM. The core's on('exit') pid-file cleanup also won't run
  // under /F, which is why we unlink the pid file ourselves below.
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // Process already dead; fall through.
  }
  unlinkPidFile(ctx.pidFile);
}

export function restart(): void {
  stop();
  start();
}

export function getLogPath(): string {
  return join(getNeuraHome(), 'logs', 'core.log');
}

export default {
  isInstalled,
  isRunning,
  install,
  uninstall,
  start,
  stop,
  restart,
  getLogPath,
} as const;

// Exported for tests only.
export const __test__ = {
  TASK_NAME,
  getShimContext,
  getStartupShimPath,
  renderCmdShim,
  escapeCmd,
};
