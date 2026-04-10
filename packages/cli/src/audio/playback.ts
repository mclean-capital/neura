/**
 * Audio playback abstraction for speaker output.
 *
 * Primary: sox via child_process (universal, streaming stdin pipe)
 * Fallback: @picovoice/pvspeaker-node (prebuilt binaries, no sox needed)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';

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

/** Primary playback: pipe raw PCM to sox's play command */
function createSoxPlayback(): AudioPlayback {
  let proc: ChildProcess | null = null;

  return {
    start() {
      // sox reads raw PCM from stdin and plays to default output
      const cmd = process.platform === 'win32' ? 'sox' : 'play';
      proc = spawn(
        cmd,
        [
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
        { stdio: ['pipe', 'ignore', 'ignore'] }
      );

      proc.on('error', () => {
        proc = null;
      });

      proc.on('close', () => {
        proc = null;
      });
    },

    stop() {
      if (proc) {
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

/** Fallback playback: @picovoice/pvspeaker-node */
async function createPvSpeakerPlayback(): Promise<AudioPlayback> {
  const { PvSpeaker } = await import('@picovoice/pvspeaker-node');
  let speaker: InstanceType<typeof PvSpeaker> | null = null;

  return {
    start() {
      speaker = new PvSpeaker(24000, 16);
      speaker.start();
    },

    stop() {
      if (speaker) {
        speaker.stop();
        speaker.release();
        speaker = null;
      }
    },

    play(base64Pcm: string) {
      if (speaker) {
        const buffer = Buffer.from(base64Pcm, 'base64');
        const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
        speaker.write(Array.from(int16));
      }
    },
  };
}

/** Auto-detect and create the best available playback backend */
export async function createAudioPlayback(): Promise<AudioPlayback> {
  // Try sox first (primary, universal)
  const soxCmd = process.platform === 'win32' ? 'sox' : 'play';
  if (commandExists(soxCmd)) {
    return createSoxPlayback();
  }

  // Try PvSpeaker fallback
  try {
    return await createPvSpeakerPlayback();
  } catch {
    // Neither available
  }

  throw new Error(
    'No audio playback backend found.\n' +
      'Install sox:\n' +
      (process.platform === 'darwin'
        ? '  brew install sox'
        : process.platform === 'win32'
          ? '  choco install sox.portable'
          : '  sudo apt install sox')
  );
}
