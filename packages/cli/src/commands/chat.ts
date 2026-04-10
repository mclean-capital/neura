import { createInterface } from 'readline';
import chalk from 'chalk';
import WebSocket from 'ws';
import type { ServerMessage } from '@neura/types';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';
import { DEV_PORT } from '../constants.js';
import { formatToolCall, formatToolResult } from '../format/tools.js';

const COMMANDS: Record<string, string> = {
  '/start': 'Re-activate session (if idle timeout moved to PASSIVE)',
  '/help': 'Show available commands',
  '/quit': 'Disconnect and exit',
};

export async function chatCommand(options: { port?: string }): Promise<void> {
  const config = loadConfig();
  const port = options.port ? parseInt(options.port, 10) : config.port || DEV_PORT;

  const health = await checkHealth(port);
  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  // Auth token is required after the security hardening update. Load it from
  // config (or NEURA_AUTH_TOKEN env var) and pass via ?token= query string —
  // same pattern the web UI uses. If no token is set, connect unauthenticated
  // which only works if the core was started without auth.
  const token = config.authToken;
  const wsUrl = token
    ? `ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`
    : `ws://localhost:${port}/ws`;
  const ws = new WebSocket(wsUrl);

  let presenceState = '';
  let isStreaming = false;
  let cleaned = false;
  // Suppress the brief initial passive flash on connect — the core sends
  // passive before our manualStart takes effect.
  let everActive = false;
  // Used to detect terminal sessionClosed events: if an `error` arrives
  // shortly before, the close is fatal (missing XAI_API_KEY, max reconnect
  // exhausted) and we should exit rather than stay in a zombie state.
  let lastErrorAt = 0;
  const FATAL_ERROR_WINDOW_MS = 5000;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('> '),
  });

  ws.on('open', () => {
    console.log(chalk.green(`Connected to Neura on port ${port}`));
    console.log(chalk.dim('Type a message to chat. /quit to exit. 5 min idle timeout.\n'));
    ws.send(JSON.stringify({ type: 'manualStart' }));
    rl.prompt();
  });

  ws.on('message', (raw: Buffer) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'presenceState':
        if (msg.state !== presenceState) {
          presenceState = msg.state;
          if (msg.state === 'active') {
            everActive = true;
            console.log(chalk.green('\n  [ACTIVE]'));
          } else if (msg.state === 'passive' && everActive) {
            console.log(chalk.dim('\n  [PASSIVE] type anything to resume'));
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
        console.log(formatToolCall(msg.name, msg.args));
        break;

      case 'toolResult':
        console.log(formatToolResult(msg.name, msg.result));
        break;

      case 'error':
        console.log(chalk.red(`\nError: ${msg.error}\n`));
        lastErrorAt = Date.now();
        rl.prompt();
        break;

      case 'sessionClosed':
        // Core emits this on any voice-provider close. Most of the time it's
        // a normal transition (passive via enter_mode, proactive Grok
        // reconnect) and chat should stay alive so the user can keep typing
        // — chat.ts already re-sends manualStart on the next line input. Only
        // treat as fatal if an `error` arrived recently.
        if (Date.now() - lastErrorAt < FATAL_ERROR_WINDOW_MS) {
          console.log(chalk.red('\nSession closed due to error. Exiting.'));
          cleanup();
        }
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!cleaned) {
      console.log(chalk.dim('Disconnected.'));
      cleanup();
    }
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
    if (cleaned) return;
    cleaned = true;
    rl.close();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    process.exit(0);
  }

  process.on('SIGINT', () => {
    console.log();
    cleanup();
  });
}
