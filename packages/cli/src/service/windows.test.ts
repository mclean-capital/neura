import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
// The Windows service module mostly shells out to `schtasks.exe`,
// `tasklist.exe`, and `taskkill`, and reads/writes a pid file + a
// cmd-shim file. All of those are boundaries we mock. Tests focus on:
//   1. Shim contents are correct and shell-safe
//   2. Lifecycle ops handle the dual state (task OR startup shim)
//   3. isRunning/stop key off the core-written pid file cleanly

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('../config.js', () => ({
  getNeuraHome: vi.fn(() => 'C:/Users/test/.neura'),
  loadConfig: vi.fn(() => ({
    port: 3002,
    voice: 'eve',
    apiKeys: { xai: 'sk-xai-test', google: 'sk-google-test' },
    authToken: 'tok-abc123',
    service: { autoStart: true, logLevel: 'info' },
  })),
}));

vi.mock('../download.js', () => ({
  getCoreBinaryPath: vi.fn(() => 'C:/npm/neura/core/server.bundled.mjs'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => 'C:/Users/test'),
  };
});

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync, spawn, execSync } from 'child_process';
import windowsService, { __test__ } from './windows.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedSpawn = vi.mocked(spawn);
const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
  // Fake APPDATA so getStartupShimPath is deterministic in CI.
  process.env.APPDATA = 'C:/Users/test/AppData/Roaming';
});

// ── Shim rendering ───────────────────────────────────────────────────

describe('renderCmdShim', () => {
  it('sets NEURA_HOME so the core can find its config.json', () => {
    const ctx = __test__.getShimContext();
    const shim = __test__.renderCmdShim(ctx);

    expect(shim).toContain('set "NEURA_HOME=C:/Users/test/.neura"');
  });

  it('does NOT bake runtime config values into the shim', () => {
    // Regression: previously the shim hard-coded PORT, NEURA_AUTH_TOKEN,
    // XAI_API_KEY, and GOOGLE_API_KEY from the install-time config.
    // Because core's config loader prefers process.env.* over config.json,
    // those frozen values would shadow live `neura config set` changes
    // until the user re-ran `neura install`. The fix: only export
    // NEURA_HOME and let the core read everything else from config.json
    // at startup, matching macOS and Linux behavior.
    const ctx = __test__.getShimContext();
    const shim = __test__.renderCmdShim(ctx);

    expect(shim).not.toContain('PORT=');
    expect(shim).not.toContain('NEURA_AUTH_TOKEN=');
    expect(shim).not.toContain('XAI_API_KEY=');
    expect(shim).not.toContain('GOOGLE_API_KEY=');
  });

  it('invokes node on the bundled core path', () => {
    const ctx = __test__.getShimContext();
    const shim = __test__.renderCmdShim(ctx);

    expect(shim).toContain(process.execPath);
    expect(shim).toContain('C:/npm/neura/core/server.bundled.mjs');
  });

  it('redirects stdout and stderr to log files under NEURA_HOME/logs', () => {
    const ctx = __test__.getShimContext();
    const shim = __test__.renderCmdShim(ctx);

    // Match the log paths without asserting the path separator — path.join
    // produces `\\` on Windows and `/` elsewhere.
    expect(shim).toMatch(/>> ".*[/\\]\.neura[/\\]logs[/\\]core\.log"/);
    expect(shim).toMatch(/2>> ".*[/\\]\.neura[/\\]logs[/\\]core\.error\.log"/);
  });

  it('escapes cmd.exe metacharacters in interpolated values', () => {
    // If a value contains &, |, <, >, or %, the shim would break the
    // batch parser. Verify the escape helper is applied.
    expect(__test__.escapeCmd('foo & bar')).toBe('foo ^& bar');
    expect(__test__.escapeCmd('100%')).toBe('100%%');
    expect(__test__.escapeCmd('a|b<c>d')).toBe('a^|b^<c^>d');
    expect(__test__.escapeCmd('^mix')).toBe('^^mix');
  });
});

// ── Install — primary schtasks path ──────────────────────────────────

describe('install (Scheduled Task path)', () => {
  it('writes the shim .cmd and registers the task via schtasks /Create', () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExistsSync.mockReturnValue(false);

    windowsService.install();

    // Shim file written to NEURA_HOME
    const shimWrite = mockedWriteFileSync.mock.calls.find(([path]) =>
      String(path).endsWith('neura-core.cmd')
    );
    expect(shimWrite).toBeDefined();

    // schtasks /Create invoked with the right flags
    const createCall = mockedSpawnSync.mock.calls.find(
      ([cmd, args]) => cmd === 'schtasks.exe' && Array.isArray(args) && args.includes('/Create')
    );
    expect(createCall).toBeDefined();
    const args = (createCall?.[1] ?? []) as string[];
    expect(args).toContain('/SC');
    expect(args).toContain('ONLOGON');
    expect(args).toContain('/RL');
    expect(args).toContain('LIMITED'); // NOT HIGHEST — that would trigger UAC
    expect(args).toContain('/TN');
    expect(args).toContain('neura-core');
  });

  it('does not spawn the core detached from install() — start() handles that', () => {
    // install() used to spawn detached for "run immediately without
    // logging out" behavior, but that races with the caller calling
    // start() right after (which also spawns detached). Only start()
    // should spawn; install() just registers.
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExistsSync.mockReturnValue(false);

    windowsService.install();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

// ── Install — fallback Startup shim path ─────────────────────────────

describe('install (Startup folder fallback)', () => {
  it('drops a .cmd launcher into the Startup folder when schtasks /Create fails', () => {
    // schtasks refuses (access denied, GPO restriction, etc.)
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'ERROR: Access is denied.',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExistsSync.mockReturnValue(false);

    windowsService.install();

    // Confirm a file was written to the Startup folder
    const startupWrite = mockedWriteFileSync.mock.calls.find(([path]) =>
      String(path).includes('Startup')
    );
    expect(startupWrite).toBeDefined();
    expect(String(startupWrite?.[0])).toMatch(/Startup[/\\]neura-core\.cmd$/);
  });

  it('deletes any stale Scheduled Task when falling back to the Startup shim', () => {
    // Regression: previously, if a machine had a task registered from a
    // prior install and schtasks /Create subsequently refused (GPO
    // tightened, admin changed policy, etc.), the fallback branch would
    // install a Startup shim without removing the old task. Both would
    // fire at next logon → two cores running, the second on port+1
    // thanks to server.ts's EADDRINUSE retry. The fix: symmetric
    // cleanup — the fallback branch must also call schtasks /Delete.
    mockedSpawnSync.mockImplementation((_cmd, args) => {
      const argArr = args as string[];
      if (argArr?.includes('/Create')) {
        return {
          status: 1,
          stdout: '',
          stderr: 'ERROR: Access is denied.',
          pid: 0,
          output: [],
          signal: null,
        } as ReturnType<typeof spawnSync>;
      }
      // /Delete (and any other call) succeeds
      return {
        status: 0,
        stdout: '',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      } as ReturnType<typeof spawnSync>;
    });
    mockedExistsSync.mockReturnValue(false);

    windowsService.install();

    const deleteCall = mockedSpawnSync.mock.calls.find(
      ([cmd, args]) => cmd === 'schtasks.exe' && Array.isArray(args) && args.includes('/Delete')
    );
    expect(deleteCall).toBeDefined();
  });
});

// ── isRunning / stop — PID file semantics ────────────────────────────

describe('isRunning', () => {
  it('returns false when the pid file does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(windowsService.isRunning()).toBe(false);
  });

  it('returns true when tasklist finds a process for the stored pid', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('4242\n');
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'node.exe                      4242 Console                    1     50,000 K',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(windowsService.isRunning()).toBe(true);
  });

  it('returns false when tasklist reports the pid is missing', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('4242\n');
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'INFO: No tasks are running which match the specified criteria.',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(windowsService.isRunning()).toBe(false);
  });

  it('handles a corrupt / non-numeric pid file gracefully', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not a number\n');
    expect(windowsService.isRunning()).toBe(false);
  });

  it('self-heals a stale pid file when tasklist reports the pid is gone', async () => {
    // Regression: if the core dies without running its cleanup
    // handlers (crash, taskkill /F, OS reboot), the pid file persists
    // with a dead PID. Windows recycles PIDs aggressively, so a later
    // isRunning() could get a "PID exists" hit from some unrelated
    // process and falsely report the core as running. Fix: when
    // tasklist says "No tasks", unlink the pid file as a side-effect.
    const { unlinkSync } = await import('fs');
    const mockedUnlinkSync = vi.mocked(unlinkSync);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('9999\n');
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'INFO: No tasks are running which match the specified criteria.',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(windowsService.isRunning()).toBe(false);

    // Stale pid file must have been unlinked
    const unlinkCall = mockedUnlinkSync.mock.calls.find(([path]) =>
      String(path).endsWith('neura-core.pid')
    );
    expect(unlinkCall).toBeDefined();
  });
});

describe('stop', () => {
  it('calls taskkill with /T /F on the stored pid and removes the pid file', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('4242');

    windowsService.stop();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('taskkill /PID 4242 /T /F'),
      expect.any(Object)
    );
  });

  it('is a no-op when no pid file exists', () => {
    mockedExistsSync.mockReturnValue(false);
    windowsService.stop();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});

// ── Dual-state isInstalled ───────────────────────────────────────────

describe('isInstalled', () => {
  it('returns true when the Scheduled Task is registered', () => {
    // First call = schtasks query (status 0 = task exists)
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExistsSync.mockReturnValue(false);

    expect(windowsService.isInstalled()).toBe(true);
  });

  it('returns true when only the Startup shim is present', () => {
    // schtasks query returns not-found (status 1) but the shim exists
    mockedSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExistsSync.mockImplementation((p) => String(p).includes('Startup'));

    expect(windowsService.isInstalled()).toBe(true);
  });

  it('returns false when neither install path is present', () => {
    mockedSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExistsSync.mockReturnValue(false);

    expect(windowsService.isInstalled()).toBe(false);
  });
});
