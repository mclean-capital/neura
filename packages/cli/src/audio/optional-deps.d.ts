// Type declarations for optional audio dependencies.
// These packages are lazy-loaded at runtime and may not be installed.

declare module 'decibri' {
  interface DecibriOptions {
    sampleRate?: number;
    channels?: number;
    format?: 'int16' | 'float32';
    device?: number | string;
  }

  interface DeviceInfo {
    index: number;
    name: string;
    maxInputChannels: number;
    defaultSampleRate: number;
    isDefault: boolean;
  }

  class Decibri {
    constructor(options?: DecibriOptions);
    on(event: 'data', handler: (chunk: Buffer) => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
    stop(): void;
    static devices(): DeviceInfo[];
  }

  export default Decibri;
}

declare module '@picovoice/pvspeaker-node' {
  /**
   * Ambient module declaration for `@picovoice/pvspeaker-node`.
   *
   * This is a stub used when the optional package isn't installed
   * (e.g. a pre-bootstrap checkout on a platform that doesn't have
   * prebuilt binaries). When the package IS installed, this ambient
   * declaration STILL wins over the real `.d.ts` shipped in
   * `node_modules/@picovoice/pvspeaker-node/dist/types/`, so the
   * shapes here MUST match reality — otherwise a mismatch slips
   * silently past the typechecker and crashes at runtime.
   *
   * ### Historical warning
   *
   * An earlier version of this stub declared
   * `write(pcm: number[]): number`, which was wrong. The real API
   * takes an `ArrayBuffer` and returns the number of **samples**
   * (not bytes) successfully written. That bug let `playback.ts`
   * compile clean while passing a `number[]` at runtime, which
   * crashed pvspeaker's native binding with `RUNTIME_ERROR: Unable
   * to get buffer` the first time audio playback was actually
   * reached (see `createPvSpeakerPlayback` in `playback.ts` for
   * full context). Keep the signatures below strictly aligned with
   * `node_modules/@picovoice/pvspeaker-node/dist/types/pv_speaker.d.ts`.
   */
  export class PvSpeaker {
    constructor(
      sampleRate: number,
      bitsPerSample: number,
      options?: { bufferSizeSecs?: number; deviceIndex?: number }
    );
    readonly sampleRate: number;
    readonly bitsPerSample: number;
    readonly bufferSizeSecs: number;
    readonly version: string;
    readonly isStarted: boolean;
    start(): void;
    stop(): void;
    /**
     * Synchronous write of PCM data to the internal ring buffer.
     * @returns the number of **samples** (not bytes) successfully
     *          written. With 16-bit mono, 1 sample = 2 bytes; the
     *          caller is responsible for multiplying when slicing
     *          the remainder of a partial write.
     */
    write(pcm: ArrayBuffer): number;
    /**
     * Blocks until the PCM data has been written and played.
     * @returns the number of samples successfully written.
     */
    flush(pcm?: ArrayBuffer): number;
    writeToFile(outputPath: string): void;
    getSelectedDevice(): string;
    release(): void;
    static getAvailableDevices(): string[];
  }
}

declare module 'speaker' {
  import { Writable, WritableOptions } from 'stream';

  interface SpeakerOptions extends WritableOptions {
    channels?: number;
    bitDepth?: number;
    sampleRate?: number;
    lowWaterMark?: number;
    highWaterMark?: number;
  }

  class Speaker extends Writable {
    constructor(opts?: SpeakerOptions);
    close(flush: boolean): string;
  }

  export default Speaker;
}
