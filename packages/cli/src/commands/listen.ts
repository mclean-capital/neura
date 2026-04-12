import chalk from 'chalk';
import WebSocket from 'ws';
import type { ServerMessage } from '@neura/types';
import { loadConfig } from '../config.js';
import { checkHealth } from '../health.js';
import { DEV_PORT } from '../constants.js';
import { createAudioCapture, listInputDevices, type AudioCapture } from '../audio/capture.js';
import { createAudioPlayback, type AudioPlayback } from '../audio/playback.js';
import { formatToolCall, formatToolResult } from '../format/tools.js';

export async function listenCommand(options: { port?: string; debug?: boolean }): Promise<void> {
  const config = loadConfig();
  const port = options.port ? parseInt(options.port, 10) : config.port || DEV_PORT;
  const debug = !!options.debug;

  const health = await checkHealth(port);
  if (!health) {
    console.log(chalk.red('Core is not running. Start it with: neura start'));
    process.exit(1);
  }

  let capture: AudioCapture;
  let playback: AudioPlayback;

  try {
    capture = await createAudioCapture();
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    process.exit(1);
  }

  if (debug) {
    const devices = await listInputDevices();
    if (devices.length > 0) {
      console.log(chalk.dim('Audio devices:'));
      for (const d of devices) {
        const marker = d.isDefault ? chalk.green(' *') : '  ';
        console.log(chalk.dim(`${marker} [${d.index}] ${d.name}`));
      }
      console.log();
    }
  }

  try {
    playback = await createAudioPlayback();
  } catch (err) {
    console.log(chalk.red((err as Error).message));
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
  // Track whether we've ever been active so we can suppress the initial
  // `passive` flash on connect — the core sends passive briefly before our
  // manualStart takes effect, and logging it is confusing in listen mode
  // because the CLI auto-activates and the user never actually needs the
  // wake word on startup.
  let everActive = false;
  // Used by the fatal sessionClosed detector. If an `error` message arrives
  // shortly before `sessionClosed`, the close is terminal (e.g. missing
  // XAI_API_KEY, max reconnect attempts) rather than a normal passive/reconnect
  // transition, and we should exit the CLI cleanly.
  let lastErrorAt = 0;
  const FATAL_ERROR_WINDOW_MS = 5000;

  // Half-duplex state: decibri has no echo cancellation, so while the AI is
  // playing through the speaker we replace the mic chunks with zeroed PCM
  // (silence) instead of dropping them. This prevents the speaker output from
  // bouncing back into Grok as "user" input while keeping the audio stream
  // continuous so Grok's server-side VAD state stays consistent.
  //
  // We track cumulative playback duration: for each audio chunk received from
  // Grok, we add (sampleCount / 24000) seconds to an `expectedPlaybackEndsAt`
  // timestamp. Grok typically bursts chunks faster than real-time, so tracking
  // receive time is not enough — we have to know how long the backend will
  // actually keep playing out of its buffer. PLAYBACK_TAIL_MS is a small
  // safety margin for OS audio latency and device buffer tail.
  //
  // Thread safety note: `expectedPlaybackEndsAt` is written in the WebSocket
  // 'message' handler and read in the mic `capture.onData` callback. Both
  // fire on Node's single event loop thread, so reads/writes are atomic by
  // construction — no synchronization needed.
  const AUDIO_SAMPLE_RATE = 24000;
  const PLAYBACK_TAIL_MS = 500;
  let expectedPlaybackEndsAt = 0;

  // Debug counters (only used when --debug)
  let micChunksSent = 0;
  let micChunksSilenced = 0;
  let micSampleLevelSum = 0;
  let micSampleLevelCount = 0;
  let serverAudioChunks = 0;
  let serverAudioMs = 0;
  // Per-turn totals — logged on turnComplete so we can see if Grok is
  // sending less audio than we'd expect for the text it generated.
  let turnAudioChunks = 0;
  let turnAudioMs = 0;
  let turnTextChars = 0;
  let debugTimer: ReturnType<typeof setInterval> | null = null;

  // Raw stdin keypress listener: press Enter to manually reactivate after
  // passive transitions. Critical escape hatch when wake word detection is
  // disabled or the ONNX models aren't installed — otherwise the user has
  // no way to resume voice without killing and restarting the CLI.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key: string) => {
      // Ctrl+C still works in raw mode only if we handle it explicitly
      if (key === '\u0003') {
        console.log(chalk.dim('\nStopping...'));
        cleanup();
        return;
      }
      // Enter or space → manualStart if passive
      if ((key === '\r' || key === '\n' || key === ' ') && presenceState === 'passive') {
        console.log(chalk.dim('  [reactivating...]'));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'manualStart' }));
        }
      }
    });
  }

  ws.on('open', () => {
    console.log(chalk.green(`Connected to Neura on port ${port}`));
    console.log(
      chalk.dim('Listening... speak to interact. Enter to reactivate, Ctrl+C to stop.\n')
    );

    ws.send(JSON.stringify({ type: 'manualStart' }));

    playback.start();
    capture.onData = (base64Pcm) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      let data = base64Pcm;
      const isSilenced = Date.now() < expectedPlaybackEndsAt + PLAYBACK_TAIL_MS;
      if (isSilenced) {
        // AI is speaking — replace mic chunk with equivalent-length silence.
        const decoded = Buffer.from(base64Pcm, 'base64');
        data = Buffer.alloc(decoded.length).toString('base64');
      }

      if (debug) {
        if (isSilenced) {
          micChunksSilenced++;
        } else {
          micChunksSent++;
          // Compute average absolute sample level to verify mic is hot
          const buf = Buffer.from(base64Pcm, 'base64');
          let sum = 0;
          const samples = buf.length / 2;
          for (let i = 0; i < buf.length; i += 2) {
            sum += Math.abs(buf.readInt16LE(i));
          }
          micSampleLevelSum += sum / samples;
          micSampleLevelCount++;
        }
      }

      ws.send(JSON.stringify({ type: 'audio', data }));
    };
    capture.start();

    if (debug) {
      debugTimer = setInterval(() => {
        const avgLevel =
          micSampleLevelCount > 0 ? Math.round(micSampleLevelSum / micSampleLevelCount) : 0;
        console.log(
          chalk.dim(
            `  [debug] mic sent=${micChunksSent} silenced=${micChunksSilenced} avgLevel=${avgLevel} / server chunks=${serverAudioChunks} ms=${Math.round(serverAudioMs)} / state=${presenceState}`
          )
        );
        micChunksSent = 0;
        micChunksSilenced = 0;
        micSampleLevelSum = 0;
        micSampleLevelCount = 0;
        serverAudioChunks = 0;
        serverAudioMs = 0;
      }, 2000);
    }
  });

  ws.on('message', (raw: Buffer) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'audio': {
        // Track cumulative playback duration so mic suppression covers the
        // entire tail of AI speech, not just the burst of server chunks.
        const audioBuf = Buffer.from(msg.data, 'base64');
        const samples = audioBuf.length / 2; // int16 → 2 bytes/sample
        const durationMs = (samples / AUDIO_SAMPLE_RATE) * 1000;
        const now = Date.now();
        expectedPlaybackEndsAt = Math.max(expectedPlaybackEndsAt, now) + durationMs;
        if (debug) {
          serverAudioChunks++;
          serverAudioMs += durationMs;
          turnAudioChunks++;
          turnAudioMs += durationMs;
        }
        playback.play(msg.data);
        break;
      }

      case 'interrupted':
        // AI was cut off — flush playback suppression so user can talk
        // immediately without waiting for the tail of dead audio.
        expectedPlaybackEndsAt = 0;
        if (isStreaming) {
          isStreaming = false;
          console.log(chalk.yellow(' [interrupted]\n'));
        }
        break;

      case 'presenceState':
        if (msg.state !== presenceState) {
          presenceState = msg.state;
          if (msg.state === 'active') {
            everActive = true;
            console.log(chalk.green('  [ACTIVE]'));
          } else if (msg.state === 'passive' && everActive) {
            // Only log passive if we've previously been active — suppresses
            // the brief initial passive flash before manualStart fires.
            //
            // The server includes a `wakeDetection` field telling us whether
            // the ONNX wake-word detector is loaded for this connection. If
            // it's 'disabled' (missing models, init failure, wrong assistant
            // name) we must NOT tell the user "say the wake word" — that's
            // a lie and they'd sit there talking at a non-existent detector.
            // Instead we tell them to press Enter, which fires a manual
            // start message and re-activates the session.
            const wakeOk = msg.wakeDetection === 'active';
            if (wakeOk) {
              console.log(chalk.dim('  [PASSIVE] say the wake word or press Enter to resume'));
            } else {
              console.log(chalk.dim('  [PASSIVE] wake word unavailable — press Enter to resume'));
            }
          }
        }
        break;

      case 'outputTranscript':
        if (!isStreaming) {
          isStreaming = true;
          process.stdout.write(chalk.green('\nNeura: '));
        }
        process.stdout.write(msg.text);
        if (debug) turnTextChars += msg.text.length;
        break;

      case 'inputTranscript':
        console.log(chalk.dim(`\nYou: ${msg.text}`));
        break;

      case 'turnComplete':
        if (isStreaming) {
          isStreaming = false;
          console.log('\n');
        }
        if (debug) {
          // Heuristic: ~60ms of audio per character of speech at natural pace.
          // If actual audio ms is way below expected, Grok/xAI cut the audio.
          const expectedMs = turnTextChars * 60;
          const ratio = expectedMs > 0 ? Math.round((turnAudioMs / expectedMs) * 100) : 0;
          console.log(
            chalk.dim(
              `  [turn] text=${turnTextChars}ch audio=${Math.round(turnAudioMs)}ms chunks=${turnAudioChunks} expected~${expectedMs}ms (${ratio}%)`
            )
          );
          turnAudioChunks = 0;
          turnAudioMs = 0;
          turnTextChars = 0;
        }
        break;

      case 'toolCall':
        console.log(formatToolCall(msg.name, msg.args));
        break;

      case 'toolResult':
        console.log(formatToolResult(msg.name, msg.result));
        break;

      case 'error':
        console.log(chalk.red(`\nError: ${msg.error}`));
        lastErrorAt = Date.now();
        break;

      case 'sessionClosed':
        // Core emits this on any voice-provider close. Most of the time it's
        // a normal transition (passive, proactive 28-min reconnect) and we
        // should stay alive. But if an `error` fired recently, this close is
        // likely fatal (missing XAI_API_KEY, max reconnect exhausted, etc)
        // and the CLI would otherwise zombie with mic recording and no
        // voice session to send audio to.
        if (Date.now() - lastErrorAt < FATAL_ERROR_WINDOW_MS) {
          console.log(chalk.red('\nVoice session closed due to error. Exiting.'));
          cleanup();
        } else {
          console.log(chalk.dim('  [voice session closed]'));
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
    cleanup();
  });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (debugTimer) {
      clearInterval(debugTimer);
      debugTimer = null;
    }
    // Restore terminal to cooked mode — otherwise the user's shell is left
    // in raw mode after the CLI exits and nothing will echo correctly.
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {
        /* ignore */
      }
    }
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
