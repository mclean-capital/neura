/**
 * Server-side wake word detector using VAD + Gemini transcription + fuzzy match.
 *
 * Receives raw PCM audio, detects speech boundaries via energy-based VAD,
 * sends speech segments to Gemini for transcription, then checks locally
 * whether the transcript contains the wake word (exact or fuzzy match).
 *
 * Gemini handles transcription (what it's great at), we handle classification.
 */

import { GoogleGenAI } from '@google/genai';
import { Logger } from '@neura/utils/logger';

const log = new Logger('wake');

// Audio constants (matches client PCM format)
const SAMPLE_RATE = 24000;

// Energy-based VAD parameters
const FRAME_SIZE_MS = 30;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_SIZE_MS) / 1000; // 720 samples per frame
const SPEECH_THRESHOLD = 0.005; // RMS threshold for speech detection
const SPEECH_START_FRAMES = 2; // consecutive speech frames to start capture (~60ms)
const SILENCE_END_FRAMES = 15; // consecutive silence frames to end capture (~450ms)
const MAX_SPEECH_SECONDS = 5; // max speech segment to prevent runaway buffers
const MIN_SPEECH_SECONDS = 0.3; // ignore very short bursts (clicks, pops)

export interface WakeDetectorConfig {
  /** The assistant name to listen for (e.g., "neura") */
  assistantName: string;
  /** Google API key for Gemini */
  googleApiKey: string;
  /** Called when the wake word is detected — includes buffered base64 PCM chunks for replay */
  onWake: (audioChunks: string[]) => void;
  /** Debug callback for transcription + match results */
  onDebug?: (info: { transcript: string; isWake: boolean }) => void;
}

export interface WakeDetector {
  /** Feed raw PCM audio (base64 encoded, 24kHz 16-bit mono) */
  feedAudio: (base64Pcm: string) => void;
  /** Update the assistant name at runtime */
  setAssistantName: (name: string) => void;
  /** Stop processing and clean up */
  close: () => void;
}

/**
 * Create a wake word detector that uses energy-based VAD + Gemini API.
 * No local model loading required.
 */
export function createWakeDetector(config: WakeDetectorConfig): WakeDetector {
  let assistantName = config.assistantName;
  let closed = false;

  const ai = new GoogleGenAI({ apiKey: config.googleApiKey });

  // Frame accumulation buffer
  let pcmBuffer = new Float32Array(0);

  // Pre-speech ring buffer — captures audio onset before VAD threshold is met
  const PRE_SPEECH_FRAMES = 5; // 150ms of pre-speech context
  const preBuffer: Float32Array[] = [];

  // Speech segment buffers
  let speechFrames: Float32Array[] = [];
  let speechSamples = 0;
  let consecutiveSpeechFrames = 0;
  let consecutiveSilenceFrames = 0;
  let isSpeaking = false;

  // Prevent overlapping Gemini checks
  let checkInProgress = false;

  function rms(samples: Float32Array): number {
    let sum = 0;
    for (const s of samples) {
      sum += s * s;
    }
    return Math.sqrt(sum / samples.length);
  }

  function processFrame(frame: Float32Array) {
    const energy = rms(frame);

    // Maintain pre-speech ring buffer so we capture the onset of speech
    if (!isSpeaking) {
      preBuffer.push(frame.slice());
      if (preBuffer.length > PRE_SPEECH_FRAMES) preBuffer.shift();
    }

    if (energy >= SPEECH_THRESHOLD) {
      consecutiveSpeechFrames++;
      consecutiveSilenceFrames = 0;

      if (!isSpeaking && consecutiveSpeechFrames >= SPEECH_START_FRAMES) {
        isSpeaking = true;
        // Prepend pre-speech buffer to capture any clipped onset
        speechFrames = [...preBuffer];
        speechSamples = speechFrames.reduce((s, f) => s + f.length, 0);
        preBuffer.length = 0;
        log.info('speech started');
      }
    } else {
      consecutiveSilenceFrames++;
      consecutiveSpeechFrames = 0;

      if (isSpeaking && consecutiveSilenceFrames >= SILENCE_END_FRAMES) {
        isSpeaking = false;
        if (speechSamples >= MIN_SPEECH_SECONDS * SAMPLE_RATE) {
          void checkSpeechSegment();
        } else {
          log.debug('speech too short, skipping');
        }
        speechFrames = [];
        speechSamples = 0;
      }
    }

    if (isSpeaking) {
      speechFrames.push(frame);
      speechSamples += frame.length;

      // Safety cap
      if (speechSamples >= MAX_SPEECH_SECONDS * SAMPLE_RATE) {
        void checkSpeechSegment();
        speechFrames = [];
        speechSamples = 0;
        isSpeaking = false;
      }
    }
  }

  async function checkSpeechSegment() {
    if (closed || speechFrames.length === 0) return;
    if (checkInProgress) {
      log.debug('skipping speech segment (check in progress)');
      return;
    }
    checkInProgress = true;

    // Capture frames before they get reassigned
    const frames = speechFrames;

    // Merge Float32 frames → single array
    const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.length;
    }

    // Convert Float32 → Int16
    const int16 = new Int16Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const s = Math.max(-1, Math.min(1, merged[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const pcmBytes = Buffer.from(int16.buffer);

    // Create WAV for Gemini
    const wav = createWavBuffer(pcmBytes, SAMPLE_RATE, 16, 1);
    const wavBase64 = wav.toString('base64');

    // Split PCM into replay chunks (~200ms each) for Grok
    const CHUNK_SAMPLES = Math.floor(SAMPLE_RATE / 5); // 4800 samples = 200ms
    const replayChunks: string[] = [];
    for (let i = 0; i < int16.length; i += CHUNK_SAMPLES) {
      const end = Math.min(i + CHUNK_SAMPLES, int16.length);
      const slice = int16.slice(i, end);
      replayChunks.push(
        Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64')
      );
    }

    // Timeout to prevent checkInProgress from being stuck forever on a hung API call
    const timeout = setTimeout(() => {
      log.warn('gemini transcription timed out');
      checkInProgress = false;
    }, 10_000);

    try {
      log.info('transcribing speech segment', {
        samples: totalSamples,
        durationMs: Math.round((totalSamples / SAMPLE_RATE) * 1000),
      });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: wavBase64, mimeType: 'audio/wav' } },
              {
                text: 'Transcribe exactly what the speaker said. Output only the transcription, nothing else.',
              },
            ],
          },
        ],
      });

      const transcript = (response.text ?? '').trim();
      const isWake = containsWakeWord(transcript, assistantName);

      log.info('wake transcript check', { transcript, isWake, assistantName });
      config.onDebug?.({ transcript, isWake });

      if (isWake && !closed) {
        log.info('wake word detected in transcript');
        config.onWake(replayChunks);
      }
    } catch (err) {
      log.error('gemini transcription failed', { err: String(err) });
    } finally {
      clearTimeout(timeout);
      checkInProgress = false;
    }
  }

  function feedAudio(base64Pcm: string) {
    if (closed) return;

    // Decode base64 → Int16 → Float32
    const raw = Buffer.from(base64Pcm, 'base64');
    const int16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Append to frame buffer
    if (pcmBuffer.length === 0) {
      pcmBuffer = float32;
    } else {
      const combined = new Float32Array(pcmBuffer.length + float32.length);
      combined.set(pcmBuffer);
      combined.set(float32, pcmBuffer.length);
      pcmBuffer = combined;
    }

    // Process complete frames
    while (pcmBuffer.length >= FRAME_SIZE) {
      const frame = pcmBuffer.slice(0, FRAME_SIZE);
      pcmBuffer = pcmBuffer.slice(FRAME_SIZE);
      processFrame(frame);
    }
  }

  function setAssistantName(name: string) {
    assistantName = name;
    log.info('assistant name updated', { assistantName });
  }

  function close() {
    closed = true;
    pcmBuffer = new Float32Array(0);
    speechFrames = [];
    speechSamples = 0;
  }

  return { feedAudio, setAssistantName, close };
}

// ── Wake word matching ─────────────────────────────────────────────

/** Check if a transcript contains the wake word (exact or fuzzy match) */
function containsWakeWord(transcript: string, wakeWord: string): boolean {
  const words = transcript
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/);
  const target = wakeWord.toLowerCase();

  for (const word of words) {
    // Exact match
    if (word === target) return true;
    // Fuzzy match — allow edit distance scaled by word length
    const maxDist = Math.max(1, Math.floor(target.length / 3));
    if (editDistance(word, target) <= maxDist) return true;
  }
  return false;
}

/** Levenshtein edit distance between two strings */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── WAV header utility ─────────────────────────────────────────────

/** Create a WAV buffer from raw PCM data */
function createWavBuffer(
  pcmData: Buffer,
  sampleRate: number,
  bitsPerSample: number,
  channels: number
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}
