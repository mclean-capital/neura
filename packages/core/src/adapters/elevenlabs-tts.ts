import WebSocket from 'ws';
import { Logger } from '@neura/utils/logger';
import type {
  TTSAdapter,
  TTSStream,
  TTSStreamOptions,
  AudioOutputFormat,
  RouteDescriptor,
} from '@neura/types';

const log = new Logger('elevenlabs-tts');

const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL = 'eleven_turbo_v2';
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel

/**
 * ElevenLabs WebSocket streaming TTS adapter.
 * Sends text and yields PCM16 24kHz audio chunks.
 */
export class ElevenLabsTTSAdapter implements TTSAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voiceId: string;

  constructor(route: RouteDescriptor & { voice?: string }) {
    this.apiKey = route.apiKey;
    this.model = route.model || DEFAULT_MODEL;
    this.voiceId = route.voice || DEFAULT_VOICE;
  }

  async synthesize(text: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stream = this.createStream(text);
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  createStream(text: string, options?: TTSStreamOptions): TTSStream {
    return new ElevenLabsTTSStream(this.apiKey, this.voiceId, this.model, text, options?.signal);
  }

  outputFormat(): AudioOutputFormat {
    return { sampleRate: 24000, channels: 1, encoding: 'pcm16' };
  }

  close(): void {
    // No persistent state
  }
}

class ElevenLabsTTSStream implements TTSStream {
  private ws: WebSocket | null = null;
  private aborted = false;
  private done = false;
  private pendingChunks: Buffer[] = [];
  private resolveWait: (() => void) | null = null;
  private errorHandlers: ((err: Error) => void)[] = [];

  constructor(apiKey: string, voiceId: string, model: string, text: string, signal?: AbortSignal) {
    const url = `${ELEVENLABS_WS_BASE}/${voiceId}/stream-input?model_id=${model}&output_format=pcm_24000`;
    this.ws = new WebSocket(url);

    if (signal) {
      signal.addEventListener('abort', () => this.abort(), { once: true });
    }

    this.ws.on('open', () => {
      // Send initial config + text
      this.ws?.send(
        JSON.stringify({
          text: ' ', // Initial space to prime the connection
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          xi_api_key: apiKey,
          generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
        })
      );
      // Send the actual text
      this.ws?.send(JSON.stringify({ text }));
      // Flush — signal end of input
      this.ws?.send(JSON.stringify({ text: '' }));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as ElevenLabsResponse;
        if (msg.audio) {
          const audioBuffer = Buffer.from(msg.audio, 'base64');
          this.pendingChunks.push(audioBuffer);
          this.resolveWait?.();
          this.resolveWait = null;
        }
        if (msg.isFinal) {
          this.done = true;
          this.resolveWait?.();
          this.resolveWait = null;
        }
      } catch (err) {
        log.warn('failed to parse ElevenLabs message', { err: String(err) });
      }
    });

    this.ws.on('error', (err: Error) => {
      log.warn('ElevenLabs WS error', { err: err.message });
      for (const handler of this.errorHandlers) handler(err);
    });

    this.ws.on('close', () => {
      this.done = true;
      this.resolveWait?.();
      this.resolveWait = null;
    });
  }

  abort(): void {
    this.aborted = true;
    this.done = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.resolveWait?.();
    this.resolveWait = null;
  }

  on(event: 'error', handler: (err: Error) => void): void {
    if (event === 'error') this.errorHandlers.push(handler);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    while (true) {
      if (this.pendingChunks.length > 0) {
        yield this.pendingChunks.shift()!;
        continue;
      }
      if (this.aborted || (this.done && this.pendingChunks.length === 0)) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.resolveWait = resolve;
      });
    }
  }
}

interface ElevenLabsResponse {
  audio?: string;
  isFinal?: boolean;
  alignment?: unknown;
}
