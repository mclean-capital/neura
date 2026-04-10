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
  export class PvSpeaker {
    constructor(sampleRate: number, bitsPerSample: number, options?: { deviceIndex?: number });
    start(): void;
    stop(): void;
    write(pcm: number[]): number;
    flush(): void;
    release(): void;
    getSelectedDevice(): string;
    static getAvailableDevices(): string[];
  }
}
