/**
 * ONNX-based wake word detector using LiveKit's mel → embedding → classifier pipeline.
 *
 * Runs entirely on-device via onnxruntime-node. No cloud API calls, ~5-20ms inference,
 * zero cost. Trained wake word models are stored at ~/.neura/models/{name}.onnx.
 *
 * Pipeline: audio (24kHz) → resample (16kHz) → mel spectrogram → speech embeddings → classifier → score
 */

import { existsSync } from 'fs';
import { join } from 'path';
import * as ort from 'onnxruntime-node';
import { Logger } from '@neura/utils/logger';

const log = new Logger('onnx-wake');

// ONNX model constants (from LiveKit wakeword)
const MODEL_SAMPLE_RATE = 16000;
const INPUT_SAMPLE_RATE = 24000;
const EMBEDDING_WINDOW = 76; // mel frames per embedding
const EMBEDDING_STRIDE = 8; // mel frames between embeddings
const MIN_EMBEDDINGS = 16; // classifier input length

// Ring buffer: 2 seconds at 16kHz
const RING_BUFFER_SAMPLES = MODEL_SAMPLE_RATE * 2; // 32,000

// Inference runs every Nth frame (~80ms frames at 16kHz = 1280 samples)
const FRAME_SIZE_16K = 1280; // 80ms at 16kHz
const INFERENCE_STRIDE = 4; // run every 4th frame = ~320ms

// Energy gate: skip inference when room is quiet
const ENERGY_THRESHOLD = 0.001;

// Debounce: suppress repeated detections
const DEBOUNCE_MS = 2000;

// Replay buffer: keep last N original base64 chunks for Grok
const MAX_REPLAY_CHUNKS = 12; // ~2.4s at 200ms/chunk

export interface OnnxWakeDetectorConfig {
  /** The assistant name — used to find {name}.onnx classifier */
  assistantName: string;
  /** Directory containing ONNX model files */
  modelsDir: string;
  /** Called when wake word detected — includes buffered base64 PCM chunks for replay */
  onWake: (audioChunks: string[]) => void;
  /** Debug callback for inference results */
  onDebug?: (info: { score: number; isWake: boolean }) => void;
  /** Detection threshold (default 0.5) */
  threshold?: number;
}

export class OnnxWakeDetector {
  private readonly config: OnnxWakeDetectorConfig;
  private readonly threshold: number;

  // ONNX sessions
  private melSession: ort.InferenceSession;
  private melInputName: string;
  private melOutputName: string;
  private embeddingSession: ort.InferenceSession;
  private embeddingInputName: string;
  private embeddingOutputName: string;
  private classifierSession: ort.InferenceSession;
  private classifierInputName: string;
  private classifierOutputName: string;

  // 16kHz ring buffer for inference
  private readonly ringBuffer = new Float32Array(RING_BUFFER_SAMPLES);
  private writePos = 0;
  private totalSamplesWritten = 0;

  // Partial frame accumulator (resampled 16kHz samples)
  private accumulator = new Float32Array(0);

  // Replay buffer: original base64 chunks for Grok
  private readonly replayChunks: string[] = [];

  // Inference gating
  private frameCounter = 0;
  private lastDetectionTime = 0;
  private inferenceInProgress = false;
  private closed = false;

  private constructor(
    config: OnnxWakeDetectorConfig,
    melSession: ort.InferenceSession,
    embeddingSession: ort.InferenceSession,
    classifierSession: ort.InferenceSession
  ) {
    this.config = config;
    this.threshold = config.threshold ?? 0.5;
    this.melSession = melSession;
    this.melInputName = melSession.inputNames[0];
    this.melOutputName = melSession.outputNames[0];
    this.embeddingSession = embeddingSession;
    this.embeddingInputName = embeddingSession.inputNames[0];
    this.embeddingOutputName = embeddingSession.outputNames[0];
    this.classifierSession = classifierSession;
    this.classifierInputName = classifierSession.inputNames[0];
    this.classifierOutputName = classifierSession.outputNames[0];
  }

  static async create(config: OnnxWakeDetectorConfig): Promise<OnnxWakeDetector> {
    const melPath = join(config.modelsDir, 'melspectrogram.onnx');
    const embeddingPath = join(config.modelsDir, 'embedding_model.onnx');
    const classifierPath = join(config.modelsDir, `${config.assistantName}.onnx`);

    for (const [name, path] of Object.entries({
      mel: melPath,
      embedding: embeddingPath,
      classifier: classifierPath,
    })) {
      if (!existsSync(path)) {
        throw new Error(`ONNX ${name} model not found: ${path}`);
      }
    }

    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    };

    const [melSession, embeddingSession, classifierSession] = await Promise.all([
      ort.InferenceSession.create(melPath, opts),
      ort.InferenceSession.create(embeddingPath, opts),
      ort.InferenceSession.create(classifierPath, opts),
    ]);

    log.info('ONNX models loaded', {
      mel: melPath,
      embedding: embeddingPath,
      classifier: classifierPath,
    });

    return new OnnxWakeDetector(config, melSession, embeddingSession, classifierSession);
  }

  feedAudio(base64Pcm: string): void {
    if (this.closed) return;

    // Decode base64 → Int16 → Float32
    const raw = Buffer.from(base64Pcm, 'base64');
    const int16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Resample 24kHz → 16kHz
    const resampled = resample24kTo16k(float32);

    // Store original chunk for Grok replay
    this.replayChunks.push(base64Pcm);
    if (this.replayChunks.length > MAX_REPLAY_CHUNKS) {
      this.replayChunks.shift();
    }

    // Append resampled audio to accumulator
    const combined = new Float32Array(this.accumulator.length + resampled.length);
    combined.set(this.accumulator);
    combined.set(resampled, this.accumulator.length);
    this.accumulator = combined;

    // Process complete 80ms frames
    while (this.accumulator.length >= FRAME_SIZE_16K) {
      const frame = this.accumulator.slice(0, FRAME_SIZE_16K);
      this.accumulator = this.accumulator.slice(FRAME_SIZE_16K);

      // Write to ring buffer
      for (let i = 0; i < frame.length; i++) {
        this.ringBuffer[(this.writePos + i) % RING_BUFFER_SAMPLES] = frame[i];
      }
      this.writePos = (this.writePos + frame.length) % RING_BUFFER_SAMPLES;
      this.totalSamplesWritten += frame.length;

      // Check if it's time to run inference
      this.frameCounter++;
      if (this.frameCounter % INFERENCE_STRIDE === 0) {
        void this.tryInference();
      }
    }
  }

  setAssistantName(name: string): void {
    this.config.assistantName = name;
    log.info('assistant name updated, reloading classifier', { assistantName: name });

    const classifierPath = join(this.config.modelsDir, `${name}.onnx`);
    if (!existsSync(classifierPath)) {
      log.warn('no ONNX classifier for new name', { name, path: classifierPath });
      return;
    }

    void ort.InferenceSession.create(classifierPath, {
      executionProviders: ['cpu'],
    }).then((session) => {
      this.classifierSession = session;
      this.classifierInputName = session.inputNames[0];
      this.classifierOutputName = session.outputNames[0];
      log.info('classifier reloaded', { name });
    });
  }

  close(): void {
    this.closed = true;
    this.accumulator = new Float32Array(0);
    this.replayChunks.length = 0;
  }

  private async tryInference(): Promise<void> {
    if (this.closed || this.inferenceInProgress) return;

    // Need at least 2 seconds of audio
    if (this.totalSamplesWritten < RING_BUFFER_SAMPLES) return;

    // Debounce
    if (Date.now() - this.lastDetectionTime < DEBOUNCE_MS) return;

    // Extract ring buffer as contiguous chunk
    const chunk = this.extractRingBuffer();

    // Energy gate: skip if audio is mostly silent
    if (rms(chunk.subarray(chunk.length - FRAME_SIZE_16K)) < ENERGY_THRESHOLD) return;

    this.inferenceInProgress = true;

    try {
      const score = await this.runPipeline(chunk);
      const isWake = score >= this.threshold;

      if (score > 0.1) {
        log.debug('inference result', { score: score.toFixed(4), isWake });
      }
      this.config.onDebug?.({ score, isWake });

      if (isWake && !this.closed) {
        log.info('wake word detected via ONNX', { score: score.toFixed(4) });
        this.lastDetectionTime = Date.now();
        const chunks = [...this.replayChunks];
        this.replayChunks.length = 0;
        this.config.onWake(chunks);
      }
    } catch (err) {
      log.error('ONNX inference failed', { err: String(err) });
    } finally {
      this.inferenceInProgress = false;
    }
  }

  private async runPipeline(audio16k: Float32Array): Promise<number> {
    // Stage 1: Mel spectrogram
    // Input: (1, samples), Output: (1, 1, time_frames, 32)
    const melInput = new ort.Tensor('float32', audio16k, [1, audio16k.length]);
    const melResult = await this.melSession.run({ [this.melInputName]: melInput });
    const melOutput = melResult[this.melOutputName];
    const melData = melOutput.data as Float32Array;
    const melDims = melOutput.dims; // [1, 1, time_frames, 32]
    const timeFrames = melDims[2];
    const melBands = melDims[3];

    // Normalize: x/10 + 2 (matches openWakeWord's melspec_transform)
    const normalizedMel = new Float32Array(timeFrames * melBands);
    for (let i = 0; i < normalizedMel.length; i++) {
      normalizedMel[i] = melData[i] / 10.0 + 2.0;
    }

    // Stage 2: Extract embeddings with sliding window
    const nWindows = Math.max(
      0,
      Math.floor((timeFrames - EMBEDDING_WINDOW) / EMBEDDING_STRIDE) + 1
    );
    if (nWindows < MIN_EMBEDDINGS) return 0;

    // Batch all windows into a single ONNX call
    // Input: (nWindows, 76, 32, 1)
    const windowData = new Float32Array(nWindows * EMBEDDING_WINDOW * melBands);
    for (let w = 0; w < nWindows; w++) {
      const srcStart = w * EMBEDDING_STRIDE * melBands;
      const dstStart = w * EMBEDDING_WINDOW * melBands;
      for (let i = 0; i < EMBEDDING_WINDOW * melBands; i++) {
        windowData[dstStart + i] = normalizedMel[srcStart + i];
      }
    }

    const embInput = new ort.Tensor('float32', windowData, [
      nWindows,
      EMBEDDING_WINDOW,
      melBands,
      1,
    ]);
    const embResult = await this.embeddingSession.run({ [this.embeddingInputName]: embInput });
    const embOutput = embResult[this.embeddingOutputName];
    const embData = embOutput.data as Float32Array;
    // Output: (nWindows, 1, 1, 96) → we just need the last 16 × 96 values

    // Stage 3: Classifier on last 16 embeddings
    // Extract last 16 embeddings from the flattened output
    const embDim = 96;
    const classifierData = new Float32Array(MIN_EMBEDDINGS * embDim);
    const startWindow = nWindows - MIN_EMBEDDINGS;
    for (let i = 0; i < MIN_EMBEDDINGS; i++) {
      const srcOffset = (startWindow + i) * embDim;
      classifierData.set(embData.subarray(srcOffset, srcOffset + embDim), i * embDim);
    }

    const classInput = new ort.Tensor('float32', classifierData, [1, MIN_EMBEDDINGS, embDim]);
    const classResult = await this.classifierSession.run({
      [this.classifierInputName]: classInput,
    });
    const scoreData = classResult[this.classifierOutputName].data as Float32Array;

    return scoreData[0];
  }

  private extractRingBuffer(): Float32Array {
    const chunk = new Float32Array(RING_BUFFER_SAMPLES);
    const start = this.writePos % RING_BUFFER_SAMPLES;
    // Copy from write position to end, then from start to write position
    const firstPart = RING_BUFFER_SAMPLES - start;
    chunk.set(this.ringBuffer.subarray(start, start + firstPart));
    if (start > 0) {
      chunk.set(this.ringBuffer.subarray(0, start), firstPart);
    }
    return chunk;
  }
}

// ── Audio utilities ──────────────────────────────────────────────

/** Resample Float32 audio from 24kHz to 16kHz using linear interpolation */
function resample24kTo16k(input: Float32Array): Float32Array {
  const ratio = INPUT_SAMPLE_RATE / MODEL_SAMPLE_RATE; // 1.5
  const outputLen = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    output[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }

  return output;
}

/** Root mean square energy of audio samples */
function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) {
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}
