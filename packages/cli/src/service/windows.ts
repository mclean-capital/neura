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
  /**
   * VBScript launcher path. Used by `spawnDetachedCore` via `wscript.exe`
   * to kick off the `.cmd` shim without allocating a visible console
   * window. See `renderVbsLauncher` and `spawnDetachedCore` for details.
   */
  vbsPath: string;
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
    vbsPath: join(home, 'neura-core-launcher.vbs'),
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
set "NODE_ENV=production"\r
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
 * Escape a string for safe embedding in a VBScript string literal.
 *
 * VBScript strings use `""` as the escape for a literal double-quote.
 * No other escapes needed for our use case (we only interpolate
 * filesystem paths, which on Windows can't contain newlines and
 * effectively never contain `"`).
 */
function escapeVbs(str: string): string {
  return str.replace(/"/g, '""');
}

/**
 * Render the VBScript launcher that `spawnDetachedCore` invokes via
 * `wscript.exe` to kick off the `.cmd` shim without a visible window.
 *
 * Why this indirection exists at all:
 *
 *   On Windows, spawning the shim directly via
 *   `spawn('cmd.exe', [shim], { detached: true, windowsHide: true })`
 *   pops up a terminal window in recent Windows Terminal installs
 *   where "Default terminal" is set to Windows Terminal. Node's docs
 *   explicitly state that on Windows, `detached: true` "will have
 *   its own console window" — that console allocation is intercepted
 *   by Windows Terminal and shown as a visible tab, `windowsHide`
 *   notwithstanding.
 *
 *   Removing `detached: true` fixes the popup but also kills the
 *   child when the Neura CLI process exits (the core needs to
 *   survive long past the 100ms `neura start` invocation).
 *
 *   The fix: spawn `wscript.exe` instead of `cmd.exe`. WScript is a
 *   GUI app, not a console app — it has no console to attach to, so
 *   `detached: true` doesn't create a new console window. WScript
 *   runs this `.vbs` file, which calls `WshShell.Run` with window
 *   style `0` (hidden), which internally uses `ShellExecuteEx` to
 *   launch the `.cmd` shim fully detached with no visible window.
 *   WScript exits immediately after dispatching the Run call, and
 *   the shim's cmd.exe + node.exe subtree continues running,
 *   invisible and independent.
 */
function renderVbsLauncher(ctx: ShimContext): string {
  // WshShell.Run(command, windowStyle, bWaitOnReturn):
  //   command      = fully-quoted path to the .cmd shim
  //   windowStyle  = 0 → hidden
  //   bWaitOnReturn = False → fire-and-forget
  return `' Neura core hidden launcher. Generated by \`neura install\`.\r
' Do not edit; re-run \`neura install\` to regenerate.\r
Set shell = CreateObject("WScript.Shell")\r
shell.Run Chr(34) & "${escapeVbs(ctx.cmdPath)}" & Chr(34), 0, False\r
`;
}

function writeVbsLauncher(ctx: ShimContext): void {
  writeFileSync(ctx.vbsPath, renderVbsLauncher(ctx), 'utf-8');
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
 * Spawn the launcher `.cmd` so the core starts immediately after
 * `neura install` / `neura start` (instead of waiting for the next
 * logon to trigger the Scheduled Task / Startup shim).
 *
 * The spawn chain:
 *
 *   Node CLI
 *     → wscript.exe (detached, hidden, no console to show)
 *       → neura-core-launcher.vbs
 *         → WshShell.Run("neura-core.cmd", windowStyle=0, wait=False)
 *           → cmd.exe (hidden, detached via ShellExecuteEx)
 *             → node.exe running the core bundle
 *
 * Why this convoluted chain? We tried the obvious thing —
 * `spawn('cmd.exe', [shim], { detached: true, windowsHide: true })` —
 * and it pops up a visible Windows Terminal tab in any install where
 * "Default terminal" is set to Windows Terminal. Node's docs say
 * `detached: true` "will have its own console window" on Windows, and
 * that console allocation is intercepted by Windows Terminal's
 * default-terminal shim regardless of the `windowsHide` flag.
 *
 * Removing `detached: true` fixes the popup but breaks survival: the
 * child gets killed when the parent Node CLI exits (~100ms later).
 *
 * The workaround is to launch via `wscript.exe`, a GUI application
 * that has no console. With `detached: true`, Windows still creates a
 * fresh process-group leader, but there is no console allocation at
 * all — no popup. `wscript.exe` runs a tiny `.vbs` file that invokes
 * `WshShell.Run` with window style `0` and `bWaitOnReturn=False`.
 * That's a thin wrapper over `ShellExecuteEx`, which launches the
 * `.cmd` shim with `SW_HIDE` and returns immediately. The shim runs
 * `cmd.exe` → `node.exe` invisibly, and those processes survive long
 * after both `wscript` and the Neura CLI have exited because
 * ShellExecuteEx properly orphans them.
 *
 * Verified end-to-end on a real Windows machine where the previous
 * `cmd.exe` approach reliably popped up a terminal tab — this chain
 * produces zero visible windows and the core runs on the correct
 * port, surviving the parent `neura start` process exiting ~100ms
 * after spawn.
 */
function spawnDetachedCore(ctx: ShimContext): void {
  const child = spawn('wscript.exe', [ctx.vbsPath], {
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

  // Always regenerate both launchers so they pick up any new paths or
  // config changes since the last install. Idempotent: overwriting
  // both files is safe whether or not the task is already registered.
  //
  // - `neura-core.cmd`            → invoked by the Scheduled Task or
  //                                  Startup-folder shim at logon
  // - `neura-core-launcher.vbs`   → invoked by `spawnDetachedCore`
  //                                  via `wscript.exe` to start the
  //                                  core from `install()`/`start()`
  //                                  without a visible popup window
  writeCmdShim(ctx);
  writeVbsLauncher(ctx);

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
  // Leave NEURA_HOME/neura-core.cmd and neura-core-launcher.vbs in
  // place — they're harmless and get re-written on next
  // `neura install`. Don't delete NEURA_HOME itself; that's the user's
  // config + memory store.
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
  renderVbsLauncher,
  escapeCmd,
  escapeVbs,
};
