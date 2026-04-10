import { createInterface } from 'readline';
import chalk from 'chalk';
import WebSocket from 'ws';
import type { ServerMessage } from '@neura/types';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';

const COMMANDS: Record<string, string> = {
  '/start': 'Re-activate session (if idle timeout moved to PASSIVE)',
  '/quit': 'Disconnect and exit',
  '/exit': 'Disconnect and exit',
};

const DEV_PORT = 3002;

export async function chatCommand(options: { port?: string }): Promise<void> {
  const config = loadConfig();
  const port = options.port ? parseInt(options.port, 10) : config.port || DEV_PORT;

  const health = await checkHealth(port);
  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  const wsUrl = `ws://localhost:${port}/ws`;
  const ws = new WebSocket(wsUrl);

  let presenceState = '';
  let isStreaming = false;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('> '),
  });

  ws.on('open', () => {
    console.log(chalk.green(`Connected to Neura on port ${port}`));
    console.log(chalk.dim('Type a message to chat. /quit to exit. 5 min idle timeout.\n'));
    // Auto-activate so text is processed immediately
    ws.send(JSON.stringify({ type: 'manualStart' }));
    rl.prompt();
  });

  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;

    switch (msg.type) {
      case 'presenceState':
        if (msg.state !== presenceState) {
          presenceState = msg.state;
          if (msg.state === 'active') {
            console.log(chalk.green('\n  [ACTIVE]'));
          } else if (msg.state === 'passive') {
            console.log(chalk.dim('\n  [PASSIVE]'));
          }
        }
        break;

      case 'outputTranscript':
        if (!isStreaming) {
          isStreaming = true;
          process.stdout.write(chalk.green('\nNeura: '));
        }
        process.stdout.write(msg.text);
        break;

      case 'inputTranscript':
        // Only show if we didn't type this ourselves (e.g., voice-transcribed input)
        break;

      case 'turnComplete':
        if (isStreaming) {
          isStreaming = false;
          console.log('\n');
          rl.prompt();
        }
        break;

      case 'interrupted':
        if (isStreaming) {
          isStreaming = false;
          console.log(chalk.yellow(' [interrupted]\n'));
          rl.prompt();
        }
        break;

      case 'toolCall':
        console.log(chalk.dim(`  [tool: ${msg.name}]`));
        break;

      case 'error':
        console.log(chalk.red(`\nError: ${msg.error}\n`));
        rl.prompt();
        break;

      case 'costUpdate':
        // Silently track cost — could add a /cost command later
        break;

      case 'sessionClosed':
        console.log(chalk.yellow('\nSession closed by server.'));
        cleanup();
        break;
    }
  });

  ws.on('close', () => {
    console.log(chalk.dim('Disconnected.'));
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.log(chalk.red(`Connection error: ${err.message}`));
    process.exit(1);
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === '/quit' || trimmed === '/exit') {
      cleanup();
      return;
    }

    if (trimmed === '/start') {
      ws.send(JSON.stringify({ type: 'manualStart' }));
      rl.prompt();
      return;
    }

    if (trimmed === '/help') {
      console.log(chalk.dim('\nCommands:'));
      for (const [cmd, desc] of Object.entries(COMMANDS)) {
        console.log(chalk.dim(`  ${cmd.padEnd(10)} ${desc}`));
      }
      console.log();
      rl.prompt();
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      // Re-activate if idle timeout moved us to passive
      if (presenceState === 'passive') {
        ws.send(JSON.stringify({ type: 'manualStart' }));
      }
      ws.send(JSON.stringify({ type: 'text', text: trimmed }));
    } else {
      console.log(chalk.red('Not connected.'));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    cleanup();
  });

  function cleanup() {
    rl.close();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    process.exit(0);
  }

  // Handle SIGINT gracefully
  process.on('SIGINT', () => {
    console.log();
    cleanup();
  });
}
