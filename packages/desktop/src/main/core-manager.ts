import { execSync, fork, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
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
  return path.join(__dirname, '..', '..', 'core', 'src', 'server', 'server.ts');
}

function getCoreCwd(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'core');
  }
  return path.join(__dirname, '..', '..', 'core');
}

export class CoreManager {
  private child: ChildProcess | null = null;
  private intentionalStop = false;
  private actualPort: number;
  private portResolved = false;
  private readonly opts: CoreManagerOptions;

  constructor(opts: CoreManagerOptions) {
    this.opts = opts;
    this.actualPort = opts.port;
  }

  async start(): Promise<void> {
    this.intentionalStop = false;
    this.portResolved = false;
    const pgDataPath = path.join(app.getPath('userData'), 'pgdata');

    const env: Record<string, string> = {
      ...process.env,
      PORT: String(this.opts.port),
      XAI_API_KEY: this.opts.env.xaiApiKey,
      GOOGLE_API_KEY: this.opts.env.googleApiKey,
      PG_DATA_PATH: pgDataPath,
      NODE_ENV: app.isPackaged ? 'production' : 'development',
    };

    if (app.isPackaged) {
      this.child = fork(getCoreEntryPath(), [], {
        cwd: getCoreCwd(),
        env,
        stdio: 'pipe',
      });
    } else {
      this.child = spawn('npx', ['tsx', getCoreEntryPath()], {
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
    logStream.write(`[${new Date().toISOString()}] Core starting on port ${this.opts.port}\n`);

    // Line-buffered stdout parsing for structured port marker
    let stdoutBuffer = '';
    const portReady = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Core server did not report port within 15s'));
      }, 15_000);

      this.child!.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          console.log(`[core] ${line}`);
          logStream.write(`[stdout] ${line}\n`);

          const portMatch = /NEURA_PORT=(\d+)/.exec(line);
          if (portMatch && !this.portResolved) {
            this.actualPort = parseInt(portMatch[1], 10);
            this.portResolved = true;
            clearTimeout(timeout);
            resolve(this.actualPort);
          }
        }
      });

      this.child!.once('exit', (code) => {
        if (!this.portResolved) {
          clearTimeout(timeout);
          reject(new Error(`Core exited before starting (code ${String(code)})`));
        }
      });
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      console.error(`[core] ${line}`);
      logStream.write(`[stderr] ${line}\n`);
    });

    this.child.on('exit', (code) => {
      console.log(`[core] exited with code ${String(code)}`);
      logStream.write(`[${new Date().toISOString()}] Core exited with code ${String(code)}\n`);
      logStream.end();
      // Only fire onCrash if port discovery already succeeded (otherwise the
      // portReady rejection path handles the error)
      const crashed = this.portResolved && !this.intentionalStop && code !== 0 && code !== null;
      this.child = null;
      if (crashed && this.opts.onCrash) {
        this.opts.onCrash(code);
      }
    });

    const port = await portReady;
    console.log(`[core] ready on port ${port}`);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve();
        return;
      }
      this.intentionalStop = true;
      const pid = this.child.pid;
      this.child.on('exit', () => {
        this.child = null;
        resolve();
      });
      // Safety timeout in case exit event never fires
      setTimeout(() => {
        this.child = null;
        resolve();
      }, 5_000);
      if (pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          this.child.kill('SIGTERM');
        }
      }
    });
  }

  /** Synchronous stop for use in before-quit (where async is unreliable). */
  stopSync(): void {
    if (!this.child) return;
    this.intentionalStop = true;
    const pid = this.child.pid;
    if (pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } catch {
          /* process may already be gone */
        }
      } else {
        this.child.kill('SIGTERM');
      }
    }
    this.child = null;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  getPort(): number {
    return this.actualPort;
  }
}
