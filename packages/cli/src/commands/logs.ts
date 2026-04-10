import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { platform } from 'os';
import { getServiceManager } from '../service/manager.js';
import chalk from 'chalk';

export async function logsCommand(options: { lines?: string; follow?: boolean }): Promise<void> {
  const svc = await getServiceManager();
  const logPath = svc.getLogPath();

  if (!existsSync(logPath)) {
    console.log(chalk.yellow('No log file found at ' + logPath));
    console.log(chalk.dim('Core may not have started yet.'));
    return;
  }

  const lines = options.lines ?? '50';

  // Validate --lines is a positive integer to prevent command injection
  if (!/^\d+$/.test(lines) || parseInt(lines, 10) < 1) {
    console.log(chalk.red('--lines must be a positive integer'));
    return;
  }

  if (options.follow) {
    // Tail with follow — pass through to OS tail command
    const cmd = platform() === 'win32' ? 'powershell' : 'tail';
    const args =
      platform() === 'win32'
        ? ['-Command', `Get-Content -Path "${logPath}" -Tail ${lines} -Wait`]
        : ['-n', lines, '-f', logPath];

    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.log(chalk.red('Failed to tail logs: ' + err.message));
    });
  } else {
    // Read last N lines
    const content = readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    const n = parseInt(lines, 10);
    const tail = allLines.slice(-n).join('\n');
    console.log(tail);
  }
}
