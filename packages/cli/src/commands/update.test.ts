import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock `child_process` FIRST so imports inside update.ts see the stubs.
// We hoist the spies so they can be manipulated per-test.
const cpMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: cpMocks.execSync,
  spawnSync: cpMocks.spawnSync,
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('../version.js', () => ({
  CLI_VERSION: '2.1.6',
}));

vi.mock('../download.js', () => ({
  getInstalledCoreVersion: vi.fn(() => '2.1.6'),
}));

// Service manager mock — controlled per test via svcMocks.
const svcMocks = vi.hoisted(() => {
  const stop = vi.fn();
  const isInstalled = vi.fn(() => true);
  const isRunning = vi.fn(() => true);
  const svc = {
    isInstalled,
    isRunning,
    stop,
    isInstalledReset: () => {
      isInstalled.mockReturnValue(true);
      isRunning.mockReturnValue(true);
      stop.mockReset();
    },
  };
  return { svc };
});

vi.mock('../service/manager.js', () => ({
  getServiceManager: vi.fn(() => Promise.resolve(svcMocks.svc)),
}));

// Stub global fetch so the npm-registry lookup doesn't hit the network.
// Return a 500 so the try/catch in updateCommand treats it as
// "registry unreachable" and falls through to the install step.
const fetchMock = vi.fn(() =>
  Promise.resolve({
    ok: false,
    json: () => Promise.resolve({}),
  } as unknown as Response)
);
vi.stubGlobal('fetch', fetchMock);

// Stub process.exit so a simulated failure path doesn't kill the
// test runner. We throw a sentinel and catch it in the tests that
// exercise the failure branches.
class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}
// eslint-disable-next-line @typescript-eslint/unbound-method -- saving a reference to restore later; no `this` access
const origExit = process.exit;
beforeEach(() => {
  svcMocks.svc.isInstalledReset();
  cpMocks.execSync.mockReset();
  cpMocks.spawnSync.mockReset();
  // Default: `npm install` succeeds, `npm root -g` returns a plausible
  // path, and the re-registration spawn returns exit 0.
  cpMocks.execSync.mockImplementation((cmd: string) => {
    if (cmd.startsWith('npm') && cmd.includes('root -g')) {
      return 'C:/fake/node_modules';
    }
    return '';
  });
  cpMocks.spawnSync.mockReturnValue({
    status: 0,
    stdout: '',
    stderr: '',
    pid: 0,
    output: [],
    signal: null,
  } as unknown as ReturnType<typeof cpMocks.spawnSync>);
  fetchMock.mockClear();
  (process as unknown as { exit: typeof process.exit }).exit = ((code?: number) => {
    throw new ProcessExitError(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  (process as unknown as { exit: typeof process.exit }).exit = origExit;
});

import { updateCommand } from './update.js';

describe('updateCommand — stop-before-install ordering', () => {
  it('calls svc.stop() BEFORE running `npm install -g`', async () => {
    // Record the order of operations across two different mocks.
    const ops: string[] = [];
    svcMocks.svc.stop.mockImplementation(() => ops.push('svc.stop'));
    cpMocks.execSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('npm') && cmd.includes('root -g')) {
        return 'C:/fake/node_modules';
      }
      if (cmd.includes('install -g') && cmd.includes('@mclean-capital/neura')) {
        ops.push('npm install -g');
      }
      return '';
    });

    await updateCommand();

    // The critical invariant: stop must precede the npm install so
    // Windows has already released file handles on the old core's
    // native binaries when npm tries to replace them. Reversing the
    // order brings back the EPERM warning documented in v2.1.6.
    const stopIdx = ops.indexOf('svc.stop');
    const installIdx = ops.indexOf('npm install -g');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeLessThan(installIdx);
  });

  it('skips stop() when the service is not installed', async () => {
    svcMocks.svc.isInstalled.mockReturnValue(false);

    await updateCommand();

    expect(svcMocks.svc.stop).not.toHaveBeenCalled();
    // npm install should still run — a not-yet-installed service is
    // no reason to skip the actual upgrade.
    const npmInstallCalls = cpMocks.execSync.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('install -g')
    );
    expect(npmInstallCalls.length).toBe(1);
  });

  it('skips stop() when the service is installed but not running', async () => {
    svcMocks.svc.isInstalled.mockReturnValue(true);
    svcMocks.svc.isRunning.mockReturnValue(false);

    await updateCommand();

    // Nothing to stop — no dead processes holding file locks, and
    // calling stop() on a stopped service would be a wasted taskkill
    // and an extra line of scary-looking output.
    expect(svcMocks.svc.stop).not.toHaveBeenCalled();
    const npmInstallCalls = cpMocks.execSync.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('install -g')
    );
    expect(npmInstallCalls.length).toBe(1);
  });

  it('still runs the npm install if svc.stop() throws', async () => {
    // Non-fatal: we'd rather eat the EPERM warning from npm than
    // block the upgrade entirely because of a transient service
    // manager error.
    svcMocks.svc.stop.mockImplementation(() => {
      throw new Error('taskkill failed');
    });

    await updateCommand();

    const npmInstallCalls = cpMocks.execSync.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('install -g')
    );
    expect(npmInstallCalls.length).toBe(1);
  });
});
