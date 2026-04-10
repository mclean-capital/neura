/**
 * Audio playback abstraction for speaker output.
 *
 * Primary: sox via child_process (universal, streaming stdin pipe)
 * Fallback: @picovoice/pvspeaker-node (prebuilt binaries, no sox needed)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';

/**
 * Silence noisy mpg123 CoreAudio warnings emitted by node-speaker when the
 * playback buffer drains between turns. They look like:
 *
 *   [../deps/mpg123/src/output/coreaudio.c:81] warning: Didn't have any
 *   audio data in callback (buffer underflow)
 *
 * These are harmless — the OS audio thread asks for more samples, there
 * aren't any because no one is speaking, and mpg123 logs it. But they spam
 * the terminal on every turn boundary.
 *
 * Monkey-patching `process.stderr.write` does NOT work: the mpg123 C code
 * writes directly to file descriptor 2 via `fprintf(stderr, ...)`, which
 * bypasses Node's Writable stream entirely.
 *
 * The fix: save the original fd 2 via `/dev/fd/2`, then replace fd 2 with
 * `/dev/null`. Native stderr writes become no-ops. For legitimate Node-level
 * errors, we replace `console.error` and install an `uncaughtException`
 * handler that both write to the saved fd.
 *
 * Not supported on Windows (no `/dev/fd/2` equivalent that works for this).
 */
let mpg123StderrFilterInstalled = false;
function installMpg123StderrFilter(): void {
  if (mpg123StderrFilterInstalled) return;
  mpg123StderrFilterInstalled = true;

  if (process.platform === 'win32') return;

  let savedStderrFd: number;
  try {
    // Re-open the current stderr target (terminal, pipe, whatever) as a
    // NEW fd so we retain a handle to it after closing fd 2.
    //
    // Note: we intentionally do NOT close this fd on process exit. The CLI
    // is a short-lived process and the OS reclaims all fds on exit, so
    // there's no lifetime issue. Adding a cleanup handler would complicate
    // the shutdown path without any practical benefit.
    savedStderrFd = fs.openSync('/dev/fd/2', 'w');
  } catch {
    // Can't reopen — abort silently and leave stderr alone
    return;
  }

  try {
    // Replace fd 2 itself with /dev/null. Any C code that calls
    // fprintf(stderr, ...) or writes directly to fd 2 now goes to the void.
    fs.closeSync(2);
    fs.openSync('/dev/null', 'w'); // opens as lowest-available fd, which is 2
  } catch {
    return;
  }

  const writeToReal = (msg: string): void => {
    try {
      fs.writeSync(savedStderrFd, msg.endsWith('\n') ? msg : msg + '\n');
    } catch {
      /* ignore */
    }
  };

  // Reroute console.error so legitimate JS-level errors still surface.
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const msg = args
        .map((a) => {
          if (a instanceof Error) return a.stack ?? a.message;
          if (typeof a === 'string') return a;
          return JSON.stringify(a);
        })
        .join(' ');
      writeToReal(msg);
    } catch {
      originalConsoleError(...args);
    }
  };

  // Catch process-level crashes so they aren't swallowed by /dev/null.
  process.on('uncaughtException', (err: Error) => {
    writeToReal(`uncaughtException: ${err.stack ?? err.message}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    writeToReal(`unhandledRejection: ${String(reason)}`);
  });
}

export interface AudioPlayback {
  start(): void;
  stop(): void;
  play(base64Pcm: string): void;
}

/** Check if a command exists on PATH (cross-platform) */
function commandExists(cmd: string): boolean {
  try {
    const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Fallback playback: pipe raw PCM to sox's play command */
function createSoxPlayback(): AudioPlayback {
  let proc: ChildProcess | null = null;
  let stderrBuf = '';
  let respawnAttempts = 0;
  const MAX_RESPAWNS = 5;
  const RESPAWN_BACKOFF_MS = [100, 500, 1000, 2000, 5000];

  function spawnSox(): void {
    if (respawnAttempts >= MAX_RESPAWNS) {
      console.error(
        `[playback] sox failed ${MAX_RESPAWNS} times in a row, giving up. Install @picovoice/pvspeaker-node or speaker to recover.`
      );
      return;
    }

    // sox reads raw PCM from stdin and plays to default output
    const cmd = process.platform === 'win32' ? 'sox' : 'play';
    proc = spawn(
      cmd,
      [
        '-q', // quiet — suppress sox's own progress output
        '-t',
        'raw',
        '-r',
        '24000',
        '-b',
        '16',
        '-c',
        '1',
        '-e',
        'signed-integer',
        '-', // read from stdin
        '-d', // play to default device
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );

    stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      // Keep only the last 4KB to avoid unbounded growth
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    proc.stdin?.on('error', (err: Error) => {
      console.error(`[playback] stdin error: ${err.message}`);
    });

    proc.on('error', (err: Error) => {
      console.error(`[playback] sox spawn error: ${err.message}`);
      proc = null;
    });

    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // Log every unexpected exit so we can see when/why sox is cycling.
      // The deliberate stop() path removes this listener before killing, so
      // anything that reaches here is a mid-session crash.
      console.error(
        `[playback] sox exited code=${code ?? 'null'} signal=${signal ?? 'none'}${
          stderrBuf ? `\n${stderrBuf}` : ''
        }`
      );
      proc = null;

      // Respawn with exponential backoff so a consistently failing sox
      // doesn't spin CPU. Reset the counter if sox ran successfully for
      // at least the longest backoff window.
      respawnAttempts++;
      const delay =
        RESPAWN_BACKOFF_MS[Math.min(respawnAttempts - 1, RESPAWN_BACKOFF_MS.length - 1)];
      setTimeout(() => {
        if (started) spawnSox();
      }, delay);
    });

    // If sox runs stably for 30 seconds, reset the respawn counter so
    // future crashes get a fresh budget.
    setTimeout(() => {
      if (proc && !proc.killed) respawnAttempts = 0;
    }, 30_000);
  }

  let started = false;

  return {
    start() {
      if (started) return;
      started = true;
      spawnSox();
    },

    stop() {
      started = false;
      if (proc) {
        proc.removeAllListeners('close');
        proc.stdin?.end();
        proc.kill();
        proc = null;
      }
    },

    play(base64Pcm: string) {
      if (proc?.stdin?.writable) {
        const buffer = Buffer.from(base64Pcm, 'base64');
        proc.stdin.write(buffer);
      }
    },
  };
}

/**
 * Primary playback: `speaker` (TooTallNate/node-speaker).
 *
 * Extends Node's Writable stream so backpressure is handled natively — we
 * just `speaker.write(buffer)` and the stream queues whatever the audio
 * device can't consume yet. Mature, battle-tested in the Node audio scene.
 *
 * The speaker stays open for the life of the session. We never call `.end()`
 * between turns, so the OS audio device remains held and tail samples from
 * the previous turn always finish playing.
 */
function createNodeSpeakerPlayback(): Promise<AudioPlayback> {
  return (async () => {
    const { default: Speaker } = (await import('speaker')) as {
      default: typeof import('speaker');
    };
    let speaker: InstanceType<typeof Speaker> | null = null;

    // Silence mpg123 underflow warnings that spam stderr between turns
    installMpg123StderrFilter();

    return {
      start() {
        if (speaker) return;
        speaker = new Speaker({
          channels: 1,
          bitDepth: 16,
          sampleRate: 24000,
          // Larger high water mark so bursty xAI audio chunks don't trigger
          // backpressure handling on every turn.
          highWaterMark: 1024 * 64,
        });
        speaker.on('error', (err: Error) => {
          console.error(`[playback] speaker error: ${err.message}`);
        });
      },

      stop() {
        if (speaker) {
          try {
            speaker.end();
          } catch {
            /* ignore */
          }
          speaker = null;
        }
      },

      play(base64Pcm: string) {
        if (!speaker) return;
        const buffer = Buffer.from(base64Pcm, 'base64');
        // Ignore backpressure — Node Writable buffers what the device can't
        // consume yet. Nothing gets dropped.
        speaker.write(buffer);
      },
    };
  })();
}

/**
 * Secondary playback: @picovoice/pvspeaker-node
 *
 * Kept as a fallback for platforms where the `speaker` native build is
 * unavailable. Uses a manual pending-queue + drain loop because PvSpeaker
 * exposes a sync `write(samples[])` rather than a Writable stream.
 */
async function createPvSpeakerPlayback(): Promise<AudioPlayback> {
  const { PvSpeaker } = await import('@picovoice/pvspeaker-node');
  let speaker: InstanceType<typeof PvSpeaker> | null = null;

  // Pending samples not yet written to the speaker
  let pending: number[] = [];
  let draining = false;

  // Hard ceiling on consecutive "nothing drained" iterations so a stuck or
  // zombie speaker can't spin the drain loop forever.
  const MAX_STALL_ITERATIONS = 200; // 200 * 10ms = 2s max stuck time

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    let stallCount = 0;
    try {
      while (speaker && pending.length > 0) {
        const chunk = pending;
        pending = [];
        const written = speaker.write(chunk);
        if (written < chunk.length) {
          // Ring buffer was full — requeue the tail and yield so the speaker
          // can drain. Chrome/getUserMedia does something similar internally.
          pending = chunk.slice(written).concat(pending);
          if (written === 0) {
            stallCount++;
            if (stallCount >= MAX_STALL_ITERATIONS) {
              console.error(
                `[playback] pvspeaker stalled after ${MAX_STALL_ITERATIONS} iterations, dropping ${pending.length} samples`
              );
              pending = [];
              return;
            }
          } else {
            stallCount = 0; // Made progress
          }
          await new Promise((r) => setTimeout(r, 10));
        } else {
          stallCount = 0;
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    start() {
      if (speaker) return;
      speaker = new PvSpeaker(24000, 16);
      speaker.start();
    },

    stop() {
      pending = [];
      if (speaker) {
        try {
          speaker.flush();
        } catch {
          /* ignore */
        }
        speaker.stop();
        speaker.release();
        speaker = null;
      }
    },

    play(base64Pcm: string) {
      if (!speaker) return;
      const buffer = Buffer.from(base64Pcm, 'base64');
      const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
      // Append to pending queue. Runs off the hot path of WebSocket parsing.
      for (const sample of int16) pending.push(sample);
      void drain();
    },
  };
}

/** Auto-detect and create the best available playback backend.
 *
 * Priority depends on platform:
 *
 *   **macOS / Linux**:
 *     1. `speaker` (node-speaker) — native Writable stream, automatic
 *        backpressure, holds audio device open across turns. Best for bursty
 *        streaming audio from a voice WebSocket.
 *     2. `@picovoice/pvspeaker-node` — ring-buffer API, manual drain loop.
 *     3. `sox` — universal but has tail-sample loss in long-lived bursty
 *        streams, used only if nothing else is available.
 *
 *   **Windows**:
 *     1. `@picovoice/pvspeaker-node` — preferred because node-speaker relies
 *        on mpg123's output layer, and its underflow warnings can't be
 *        reliably silenced on Windows (no `/dev/fd/2` trick). Pvspeaker uses
 *        WASAPI directly with a clean ring buffer and no noisy stderr.
 *     2. `speaker` (node-speaker) — fallback if pvspeaker isn't available.
 *     3. `sox` — last-resort fallback.
 */
export async function createAudioPlayback(): Promise<AudioPlayback> {
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // On Windows: pvspeaker first, then node-speaker, then sox
    try {
      return await createPvSpeakerPlayback();
    } catch {
      /* fall through */
    }
    try {
      return await createNodeSpeakerPlayback();
    } catch {
      /* fall through */
    }
  } else {
    // On macOS/Linux: node-speaker first (it's a clean Writable stream and
    // our fd-level mpg123 stderr filter silences the underflow warnings)
    try {
      return await createNodeSpeakerPlayback();
    } catch {
      /* fall through */
    }
    try {
      return await createPvSpeakerPlayback();
    } catch {
      /* fall through */
    }
  }

  const soxCmd = isWindows ? 'sox' : 'play';
  if (commandExists(soxCmd)) {
    return createSoxPlayback();
  }

  throw new Error(
    'No audio playback backend found.\n' +
      'Install one of:\n' +
      '  npm install speaker -w @neura/cli\n' +
      '  npm install @picovoice/pvspeaker-node -w @neura/cli\n' +
      (process.platform === 'darwin'
        ? '  brew install sox'
        : isWindows
          ? '  choco install sox.portable'
          : '  sudo apt install sox')
  );
}
