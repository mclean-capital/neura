import chalk from 'chalk';
import WebSocket from 'ws';
import type { ServerMessage } from '@neura/types';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';
import { createAudioCapture, type AudioCapture } from '../audio/capture.js';
import { createAudioPlayback, type AudioPlayback } from '../audio/playback.js';

const DEV_PORT = 3002;

export async function listenCommand(options: { port?: string }): Promise<void> {
  const config = loadConfig();
  const port = options.port ? parseInt(options.port, 10) : config.port || DEV_PORT;

  const health = await checkHealth(port);
  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  // Initialize audio backends
  let capture: AudioCapture;
  let playback: AudioPlayback;

  try {
    capture = await createAudioCapture();
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(1);
  }

  try {
    playback = await createAudioPlayback();
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(1);
  }

  const wsUrl = `ws://localhost:${port}/ws`;
  const ws = new WebSocket(wsUrl);

  let presenceState = '';
  let isStreaming = false;

  ws.on('open', () => {
    console.log(chalk.green(`Connected to Neura on port ${port}`));
    console.log(chalk.dim('Listening... speak to interact. Ctrl+C to stop.\n'));

    // Activate from passive mode
    ws.send(JSON.stringify({ type: 'manualStart' }));

    // Start audio I/O
    playback.start();
    capture.onData = (base64Pcm) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio', data: base64Pcm }));
      }
    };
    capture.start();
  });

  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;

    switch (msg.type) {
      case 'audio':
        playback.play(msg.data);
        break;

      case 'presenceState':
        if (msg.state !== presenceState) {
          presenceState = msg.state;
          if (msg.state === 'active') {
            console.log(chalk.green('  [ACTIVE]'));
          } else if (msg.state === 'passive') {
            console.log(chalk.dim('  [PASSIVE]'));
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
        console.log(chalk.dim(`\nYou: ${msg.text}`));
        break;

      case 'turnComplete':
        if (isStreaming) {
          isStreaming = false;
          console.log('\n');
        }
        break;

      case 'interrupted':
        if (isStreaming) {
          isStreaming = false;
          console.log(chalk.yellow(' [interrupted]\n'));
        }
        break;

      case 'toolCall':
        console.log(chalk.dim(`  [tool: ${msg.name}]`));
        break;

      case 'error':
        console.log(chalk.red(`\nError: ${msg.error}`));
        break;

      case 'sessionClosed':
        console.log(chalk.yellow('\nSession closed by server.'));
        cleanup();
        break;
    }
  });

  ws.on('close', () => {
    console.log(chalk.dim('Disconnected.'));
    cleanup();
  });

  ws.on('error', (err) => {
    console.log(chalk.red(`Connection error: ${err.message}`));
    cleanup();
  });

  function cleanup() {
    capture.stop();
    playback.stop();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    process.exit(0);
  }

  process.on('SIGINT', () => {
    console.log(chalk.dim('\nStopping...'));
    cleanup();
  });
}
