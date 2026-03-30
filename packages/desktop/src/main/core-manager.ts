import { execSync } from 'child_process';
import { fork, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { app } from 'electron';

interface CoreManagerOptions {
  port: number;
  env: { xaiApiKey: string; googleApiKey: string };
  onCrash?: (code: number | null) => void;
}

function getCoreEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'core', 'server.bundled.mjs');
  }
  return path.join(__dirname, '..', '..', 'core', 'src', 'server.ts');
}

function getCoreCwd(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'core');
  }
  return path.join(__dirname, '..', '..', 'core');
}

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Core server did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 200);
        }
      });
    };
    check();
  });
}

export function createCoreManager(opts: CoreManagerOptions) {
  let child: ChildProcess | null = null;
  let intentionalStop = false;

  async function start(): Promise<void> {
    intentionalStop = false;
    const env: Record<string, string> = {
      ...process.env,
      PORT: String(opts.port),
      XAI_API_KEY: opts.env.xaiApiKey,
      GOOGLE_API_KEY: opts.env.googleApiKey,
      NODE_ENV: app.isPackaged ? 'production' : 'development',
    };

    if (app.isPackaged) {
      child = fork(getCoreEntryPath(), [], {
        cwd: getCoreCwd(),
        env,
        stdio: 'pipe',
      });
    } else {
      child = spawn('npx', ['tsx', getCoreEntryPath()], {
        cwd: getCoreCwd(),
        env,
        stdio: 'pipe',
        shell: true,
      });
    }

    // Log core output to file for crash diagnosis
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'core.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });
    logStream.write(`[${new Date().toISOString()}] Core starting on port ${opts.port}\n`);

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      console.log(`[core] ${line}`);
      logStream.write(`[stdout] ${line}\n`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      console.error(`[core] ${line}`);
      logStream.write(`[stderr] ${line}\n`);
    });
    child.on('exit', (code) => {
      console.log(`[core] exited with code ${String(code)}`);
      logStream.write(`[${new Date().toISOString()}] Core exited with code ${String(code)}\n`);
      logStream.end();
      const crashed = !intentionalStop && code !== 0 && code !== null;
      child = null;
      if (crashed && opts.onCrash) {
        opts.onCrash(code);
      }
    });

    await waitForPort(opts.port);
    console.log(`[core] ready on port ${opts.port}`);
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!child) {
        resolve();
        return;
      }
      intentionalStop = true;
      const pid = child.pid;
      child.on('exit', () => {
        child = null;
        resolve();
      });
      // Safety timeout in case exit event never fires
      setTimeout(() => {
        child = null;
        resolve();
      }, 5_000);
      if (pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      }
    });
  }

  /** Synchronous stop for use in before-quit (where async is unreliable). */
  function stopSync() {
    if (!child) return;
    intentionalStop = true;
    const pid = child.pid;
    if (pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } catch {
          /* process may already be gone */
        }
      } else {
        child.kill('SIGTERM');
      }
    }
    child = null;
  }

  function isRunning() {
    return child !== null;
  }

  return { start, stop, stopSync, isRunning };
}
