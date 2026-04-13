/**
 * Audio capture abstraction for mic input.
 *
 * Primary:  decibri (PortAudio, prebuilt arm64 binaries, 24kHz native)
 * Fallback: @picovoice/pvrecorder-node (prebuilt for all platforms incl.
 *           Intel Mac, 16kHz fixed — resampled to 24kHz before emission)
 *
 * The implementation lazy-loads both so `neura chat` works without either.
 */

import { audioInstallHint } from './install-hints.js';

export interface AudioCapture {
  start(): void;
  stop(): void;
  onData: ((base64Pcm: string) => void) | null;
}

export async function createAudioCapture(): Promise<AudioCapture> {
  // 1. Try decibri (native 24kHz, event-driven)
  try {
    return await createDecibriCapture();
  } catch {
    // decibri unavailable — try pvrecorder
  }

  // 2. Try pvrecorder (16kHz polling, resampled to 24kHz)
  try {
    return await createPvRecorderCapture();
  } catch {
    // pvrecorder also unavailable
  }

  throw new Error(
    'Mic capture requires "decibri" or "@picovoice/pvrecorder-node".\n' +
      audioInstallHint('decibri')
  );
}

/** List available audio input devices */
export async function listInputDevices(): Promise<
  { index: number; name: string; isDefault: boolean }[]
> {
  // Try decibri first (richer device info)
  try {
    const { default: Decibri } = await import('decibri');
    return Decibri.devices() as { index: number; name: string; isDefault: boolean }[];
  } catch {
    // fall through
  }

  // Try pvrecorder (returns string[] of device names)
  try {
    const { PvRecorder } = await import('@picovoice/pvrecorder-node');
    const names = PvRecorder.getAvailableDevices();
    return names.map((name, index) => ({ index, name, isDefault: index === 0 }));
  } catch {
    // fall through
  }

  return [];
}

// ── Decibri backend ─────────────────────────────────────────────

async function createDecibriCapture(): Promise<AudioCapture> {
  const { default: Decibri } = await import('decibri');

  let onData: ((base64Pcm: string) => void) | null = null;
  let mic: InstanceType<typeof Decibri> | null = null;

  return {
    get onData() {
      return onData;
    },
    set onData(handler: ((base64Pcm: string) => void) | null) {
      onData = handler;
    },

    start() {
      mic = new Decibri({ sampleRate: 24000, channels: 1, format: 'int16' });
      mic.on('data', (chunk: Buffer) => {
        if (onData) {
          onData(chunk.toString('base64'));
        }
      });
      mic.on('error', (err: Error) => {
        console.error(`Mic error: ${err.message}`);
      });
    },

    stop() {
      mic?.stop();
      mic = null;
    },
  };
}

// ── PvRecorder backend ──────────────────────────────────────────

/** Frame length in samples at 16kHz (~32ms per frame) */
const PV_FRAME_LENGTH = 512;

async function createPvRecorderCapture(): Promise<AudioCapture> {
  const { PvRecorder } = await import('@picovoice/pvrecorder-node');

  let onData: ((base64Pcm: string) => void) | null = null;
  let recorder: InstanceType<typeof PvRecorder> | null = null;
  let running = false;

  async function pollLoop() {
    while (running && recorder) {
      try {
        const frame = await recorder.read(); // Int16Array, 16kHz
        if (!running || !onData) continue;
        const resampled = resample16kTo24k(frame);
        onData(resampled.toString('base64'));
      } catch {
        // recorder was stopped or released mid-read
        break;
      }
    }
  }

  return {
    get onData() {
      return onData;
    },
    set onData(handler: ((base64Pcm: string) => void) | null) {
      onData = handler;
    },

    start() {
      recorder = new PvRecorder(PV_FRAME_LENGTH);
      running = true;
      recorder.start();
      void pollLoop();
    },

    stop() {
      running = false;
      if (recorder) {
        try {
          recorder.stop();
          recorder.release();
        } catch {
          /* already released */
        }
        recorder = null;
      }
    },
  };
}

/**
 * Resample Int16 PCM from 16kHz to 24kHz using linear interpolation.
 * Returns a Buffer of Int16LE samples ready for base64 encoding.
 */
function resample16kTo24k(input: Int16Array): Buffer {
  const ratio = 16000 / 24000; // 0.6667
  const outputLen = Math.ceil(input.length / ratio);
  const output = Buffer.alloc(outputLen * 2);

  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    const sample = Math.round(input[lo] * (1 - frac) + input[hi] * frac);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output;
}
