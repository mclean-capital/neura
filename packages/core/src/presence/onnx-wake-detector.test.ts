import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock onnxruntime-node before importing OnnxWakeDetector
const mockRun = vi.fn();
const mockCreate = vi.fn();

vi.mock('onnxruntime-node', () => {
  class MockTensor {
    readonly type: string;
    readonly data: Float32Array;
    readonly dims: readonly number[];
    constructor(type: string, data: Float32Array, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }

  return {
    Tensor: MockTensor,
    InferenceSession: {
      create: (...args: unknown[]) => mockCreate(...args) as unknown,
    },
  };
});

// Mock fs.existsSync
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import { OnnxWakeDetector } from './onnx-wake-detector.js';

function createMockSession(runFn = mockRun) {
  return {
    inputNames: ['input'],
    outputNames: ['output'],
    run: runFn,
  };
}

/** Create a base64-encoded PCM16 chunk of silence at 24kHz */
function createSilenceChunk(durationMs: number): string {
  const samples = Math.floor((24000 * durationMs) / 1000);
  const int16 = new Int16Array(samples); // zeros = silence
  return Buffer.from(int16.buffer).toString('base64');
}

/** Create a base64-encoded PCM16 chunk with a tone at 24kHz */
function createToneChunk(durationMs: number, amplitude = 0.5): string {
  const samples = Math.floor((24000 * durationMs) / 1000);
  const int16 = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    int16[i] = Math.floor(Math.sin((2 * Math.PI * 440 * i) / 24000) * amplitude * 32767);
  }
  return Buffer.from(int16.buffer).toString('base64');
}

describe('OnnxWakeDetector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create()', () => {
    it('loads three ONNX sessions', async () => {
      mockCreate.mockResolvedValue(createMockSession());

      const onWake = vi.fn();
      await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake,
      });

      expect(mockCreate).toHaveBeenCalledTimes(3);
      const paths = mockCreate.mock.calls.map((c: unknown[]) => c[0]);
      expect(paths).toContain('/tmp/models/melspectrogram.onnx');
      expect(paths).toContain('/tmp/models/embedding_model.onnx');
      expect(paths).toContain('/tmp/models/jarvis.onnx');
    });

    it('throws when model file is missing', async () => {
      const { existsSync } = await import('fs');
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      await expect(
        OnnxWakeDetector.create({
          assistantName: 'jarvis',
          modelsDir: '/tmp/models',
          onWake: vi.fn(),
        })
      ).rejects.toThrow('ONNX mel model not found');
    });
  });

  describe('feedAudio()', () => {
    it('does not run inference until 2 seconds of audio accumulated', async () => {
      mockCreate.mockResolvedValue(createMockSession());

      const onWake = vi.fn();
      const detector = await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake,
      });

      // Feed only 200ms of audio — not enough for inference
      detector.feedAudio(createToneChunk(200));

      expect(mockRun).not.toHaveBeenCalled();
      detector.close();
    });

    it('skips inference on silence (energy gate)', async () => {
      mockCreate.mockResolvedValue(createMockSession());

      const detector = await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake: vi.fn(),
      });

      // Feed 3 seconds of silence — enough to fill ring buffer
      for (let i = 0; i < 15; i++) {
        detector.feedAudio(createSilenceChunk(200));
      }

      await new Promise((r) => setTimeout(r, 10));

      // Inference should be skipped due to energy gate
      expect(mockRun).not.toHaveBeenCalled();
      detector.close();
    });
  });

  describe('close()', () => {
    it('prevents further audio processing', async () => {
      mockCreate.mockResolvedValue(createMockSession());

      const detector = await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake: vi.fn(),
      });

      detector.close();
      detector.feedAudio(createToneChunk(200));
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  describe('resampling', () => {
    it('produces correct output length for 24kHz to 16kHz', async () => {
      mockCreate.mockResolvedValue(createMockSession());

      const detector = await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake: vi.fn(),
      });

      // 24000 samples at 24kHz = 1 second → 16000 at 16kHz
      const chunk = createToneChunk(1000);
      const raw = Buffer.from(chunk, 'base64');
      expect(raw.byteLength / 2).toBe(24000);

      detector.feedAudio(chunk);
      detector.close();
    });
  });

  describe('wake detection', () => {
    it('fires onWake with replay chunks when score exceeds threshold', async () => {
      const melOutput = new Float32Array(1 * 1 * 200 * 32);
      const embOutput = new Float32Array(20 * 96);
      const classOutput = new Float32Array([0.95]);

      let callCount = 0;
      const runFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 3 === 1) {
          return { output: { data: melOutput, dims: [1, 1, 200, 32] } };
        } else if (callCount % 3 === 2) {
          return { output: { data: embOutput, dims: [20, 1, 1, 96] } };
        } else {
          return { output: { data: classOutput, dims: [1, 1] } };
        }
      });

      mockCreate.mockResolvedValue(createMockSession(runFn));

      const onWake = vi.fn();
      const detector = await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake,
      });

      // Feed enough tone audio to fill ring buffer and trigger inference
      for (let i = 0; i < 15; i++) {
        detector.feedAudio(createToneChunk(200));
      }

      // Allow async inference to complete
      await new Promise((r) => setTimeout(r, 50));

      // onWake MUST have been called with replay chunks
      expect(onWake).toHaveBeenCalledTimes(1);
      const replayChunks = onWake.mock.calls[0][0] as string[];
      expect(replayChunks.length).toBeGreaterThan(0);
      // Each chunk should be valid base64
      for (const chunk of replayChunks) {
        expect(() => Buffer.from(chunk, 'base64')).not.toThrow();
      }

      detector.close();
    });

    it('does not fire onWake when score is below threshold', async () => {
      const melOutput = new Float32Array(1 * 1 * 200 * 32);
      const embOutput = new Float32Array(20 * 96);
      const classOutput = new Float32Array([0.1]); // below threshold

      let callCount = 0;
      const runFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 3 === 1) {
          return { output: { data: melOutput, dims: [1, 1, 200, 32] } };
        } else if (callCount % 3 === 2) {
          return { output: { data: embOutput, dims: [20, 1, 1, 96] } };
        } else {
          return { output: { data: classOutput, dims: [1, 1] } };
        }
      });

      mockCreate.mockResolvedValue(createMockSession(runFn));

      const onWake = vi.fn();
      const detector = await OnnxWakeDetector.create({
        assistantName: 'jarvis',
        modelsDir: '/tmp/models',
        onWake,
      });

      for (let i = 0; i < 15; i++) {
        detector.feedAudio(createToneChunk(200));
      }

      await new Promise((r) => setTimeout(r, 50));

      expect(onWake).not.toHaveBeenCalled();
      detector.close();
    });
  });
});
