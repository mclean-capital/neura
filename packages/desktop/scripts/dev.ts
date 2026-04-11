/**
 * Dev script: starts core, renderer, and Electron together.
 *
 * 1. Runs @neura/core dev server (tsx watch) on port 3002
 * 2. Runs desktop renderer Vite dev server on port 5174
 * 3. Waits for both to be ready
 * 4. Builds main process + preload, then starts Electron
 *
 * Ctrl+C kills all processes.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const desktopDir = path.resolve(__dirname, '..');

const children: ChildProcess[] = [];

function run(cmd: string, args: string[], cwd: string, label: string): ChildProcess {
  const child = spawn(cmd, args, { cwd, stdio: 'pipe', shell: true });
  child.stdout?.on('data', (d: Buffer) => console.log(`[${label}] ${d.toString().trim()}`));
  child.stderr?.on('data', (d: Buffer) => console.error(`[${label}] ${d.toString().trim()}`));
  child.on('exit', (code) => console.log(`[${label}] exited (${String(code)})`));
  children.push(child);
  return child;
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = net.createConnection({ port, host: 'localhost' });
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Port ${port} timeout`));
        else setTimeout(check, 500);
      });
    };
    check();
  });
}

function cleanup() {
  for (const child of children) {
    try {
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function main() {
  console.log('Starting Neura desktop development environment...\n');

  // 1. Start core
  //
  // Use the dev-server.ts wrapper (NOT server.ts directly) — the wrapper
  // imports 'dotenv/config' before delegating, so `packages/core/.env`
  // gets loaded for local dev. server.ts itself no longer has that side
  // effect, because in the bundled production server it would read .env
  // from the arbitrary CWD the user ran `neura install` from and leak
  // unrelated env vars into the core. See server.ts's top comment.
  run(
    'npx',
    ['tsx', 'watch', 'src/server/dev-server.ts'],
    path.join(root, 'packages', 'core'),
    'core'
  );

  // 2. Start renderer Vite dev server (desktop's own UI)
  run('npx', ['vite', '--config', 'vite.renderer.config.ts'], desktopDir, 'renderer');

  // 3. Wait for both
  console.log('\nWaiting for core (3002) and renderer (5174)...');
  await Promise.all([waitForPort(3002), waitForPort(5174)]);
  console.log('Core and renderer ready.\n');

  // 4. Build main process + preload
  console.log('Building main process + preload...');
  const mainBuild = spawn('npx', ['vite', 'build', '--config', 'vite.main.config.ts'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: true,
  });
  await new Promise<void>((resolve) => mainBuild.on('exit', () => resolve()));

  const preloadBuild = spawn('npx', ['vite', 'build', '--config', 'vite.preload.config.ts'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: true,
  });
  await new Promise<void>((resolve) => preloadBuild.on('exit', () => resolve()));

  // 5. Start Electron (NEURA_DESKTOP_DEV tells main process not to spawn core)
  console.log('Starting Electron...\n');
  const electronBin = path.join(root, 'node_modules', '.bin', 'electron');
  const electronChild = spawn(electronBin, [path.join(desktopDir, 'dist-main', 'index.mjs')], {
    cwd: desktopDir,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, NEURA_DESKTOP_DEV: 'true' },
  });
  electronChild.stdout?.on('data', (d: Buffer) => console.log(`[electron] ${d.toString().trim()}`));
  electronChild.stderr?.on('data', (d: Buffer) =>
    console.error(`[electron] ${d.toString().trim()}`)
  );
  electronChild.on('exit', (code) => console.log(`[electron] exited (${String(code)})`));
  children.push(electronChild);
}

void main().catch((err) => {
  console.error('Dev script failed:', err);
  cleanup();
});
