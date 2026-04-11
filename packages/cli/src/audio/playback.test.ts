import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the optional speaker packages before importing playback so the
// dynamic import() calls resolve to our controlled fakes. We only
// mock pvspeaker here (the backend we're regression-testing).
const pvSpeakerMocks = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const flush = vi.fn();
  const release = vi.fn();
  // write() default: pretends to accept everything (return sample count)
  const write = vi.fn((pcm: ArrayBuffer) => pcm.byteLength / 2);
  // playback.ts calls `new PvSpeaker(sampleRate, bitsPerSample)`, so we
  // need a real constructor — `vi.fn(() => instance)` creates a function
  // that errors when called with `new`.
  class PvSpeaker {
    start = start;
    stop = stop;
    flush = flush;
    release = release;
    write = write;
  }
  return { PvSpeaker, start, stop, flush, release, write };
});

vi.mock('@picovoice/pvspeaker-node', () => ({
  PvSpeaker: pvSpeakerMocks.PvSpeaker,
}));

// node-speaker and sox are never reached in these tests because we
// force the pvspeaker path by making it succeed. But vitest needs the
// module graph to resolve, so we stub them out too.
vi.mock('speaker', () => ({
  default: vi.fn().mockImplementation(() => {
    throw new Error('speaker disabled for test');
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

import { createAudioPlayback } from './playback.js';

describe('createPvSpeakerPlayback (Windows primary path)', () => {
  it('passes an ArrayBuffer to pvspeaker.write — never a number[]', async () => {
    // Regression guard for the "Unable to get buffer" RUNTIME_ERROR:
    // an earlier version of playback.ts accumulated samples into a
    // `number[]` and passed that to `speaker.write()`. pvspeaker's
    // native binding calls `napi_get_arraybuffer_info` on the
    // argument and crashes when it isn't a Buffer/ArrayBuffer.
    //
    // This test forces the Windows (pvspeaker-primary) path, plays
    // one chunk of base64-encoded PCM, and asserts that the argument
    // handed to `speaker.write()` is an ArrayBuffer with the correct
    // byte length.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      const playback = await createAudioPlayback();
      playback.start();

      // 48 bytes of raw 16-bit PCM = 24 samples
      const pcmBytes = new Uint8Array(48);
      for (let i = 0; i < pcmBytes.length; i++) pcmBytes[i] = i;
      const base64 = Buffer.from(pcmBytes).toString('base64');

      playback.play(base64);

      // drain() is async — yield the microtask queue and a short
      // timer so the drain loop runs at least once before we assert.
      await new Promise((r) => setTimeout(r, 20));

      expect(pvSpeakerMocks.write).toHaveBeenCalled();
      const firstArg = pvSpeakerMocks.write.mock.calls[0][0];

      // MUST be an ArrayBuffer. An earlier bug passed number[].
      expect(firstArg).toBeInstanceOf(ArrayBuffer);
      expect(Array.isArray(firstArg)).toBe(false);

      // Byte count should match the decoded PCM bytes exactly.
      expect(firstArg.byteLength).toBe(48);

      // And the bytes should be our test pattern, copied correctly
      // (not left pointing at the Buffer's pooled backing store).
      const view = new Uint8Array(firstArg);
      for (let i = 0; i < 48; i++) expect(view[i]).toBe(i);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('interprets pvspeaker.write return value as samples, not bytes', async () => {
    // Regression guard for the partial-write off-by-2x bug:
    // pvspeaker.write() returns the number of SAMPLES written, not
    // the number of bytes. With 16-bit audio, 1 sample = 2 bytes, so
    // any partial-write recovery code must multiply by
    // BYTES_PER_SAMPLE before slicing the requeued tail.
    //
    // Simulate: 48-byte (24-sample) input, first write accepts only
    // 10 samples (20 bytes), second write accepts the remaining 14
    // samples (28 bytes). The test asserts that the second call
    // receives exactly 28 bytes — proving the byte math was correct.
    pvSpeakerMocks.write
      .mockImplementationOnce(() => 10) // first call: 10 samples = 20 bytes
      .mockImplementationOnce(() => 14); // second call: 14 samples = 28 bytes

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      const playback = await createAudioPlayback();
      playback.start();

      const pcmBytes = new Uint8Array(48);
      for (let i = 0; i < pcmBytes.length; i++) pcmBytes[i] = i;
      const base64 = Buffer.from(pcmBytes).toString('base64');

      playback.play(base64);
      await new Promise((r) => setTimeout(r, 50)); // let drain loop run twice

      expect(pvSpeakerMocks.write).toHaveBeenCalledTimes(2);

      const firstArg = pvSpeakerMocks.write.mock.calls[0][0];
      const secondArg = pvSpeakerMocks.write.mock.calls[1][0];

      expect(firstArg.byteLength).toBe(48); // full input first
      expect(secondArg.byteLength).toBe(28); // 48 - (10 samples × 2 bytes) = 28

      // The second call should contain bytes [20..48) of the original
      // pattern — proving the slice offset used samples × bytesPerSample.
      const secondView = new Uint8Array(secondArg);
      for (let i = 0; i < 28; i++) expect(secondView[i]).toBe(20 + i);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
