/**
 * Audio capture abstraction for mic input.
 *
 * Primary: decibri (PortAudio, prebuilt arm64 binaries)
 * The implementation lazy-loads decibri so `neura chat` works without it.
 */

export interface AudioCapture {
  start(): void;
  stop(): void;
  onData: ((base64Pcm: string) => void) | null;
}

export async function createAudioCapture(): Promise<AudioCapture> {
  try {
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
      },

      stop() {
        mic?.stop();
        mic = null;
      },
    };
  } catch {
    throw new Error(
      'Mic capture requires the "decibri" package.\n' +
        'Install it with: npm install decibri -w @neura/cli'
    );
  }
}

/** List available audio input devices */
export async function listInputDevices(): Promise<
  { index: number; name: string; isDefault: boolean }[]
> {
  try {
    const { default: Decibri } = await import('decibri');
    return Decibri.devices() as { index: number; name: string; isDefault: boolean }[];
  } catch {
    return [];
  }
}
