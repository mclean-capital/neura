import OpenAI from 'openai';
import { Logger } from '@neura/utils/logger';
import type {
  TTSAdapter,
  TTSStream,
  TTSStreamOptions,
  AudioOutputFormat,
  RouteDescriptor,
} from '@neura/types';

const log = new Logger('openai-tts');

/**
 * OpenAI TTS adapter using the HTTP streaming speech endpoint.
 * Simpler than WebSocket-based TTS but higher latency per synthesis call.
 */
export class OpenAITTSAdapter implements TTSAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly voice: string;

  constructor(route: RouteDescriptor & { voice?: string }) {
    this.client = new OpenAI({
      apiKey: route.apiKey,
      baseURL: route.baseUrl,
    });
    this.model = route.model || 'tts-1';
    this.voice = route.voice || 'alloy';
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await this.client.audio.speech.create({
      model: this.model,
      voice: this.voice as 'alloy',
      input: text,
      response_format: 'pcm',
    });
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  createStream(text: string, options?: TTSStreamOptions): TTSStream {
    return new OpenAITTSStream(this.client, this.model, this.voice, text, options?.signal);
  }

  outputFormat(): AudioOutputFormat {
    return { sampleRate: 24000, channels: 1, encoding: 'pcm16' };
  }

  close(): void {
    // No persistent connections
  }
}

class OpenAITTSStream implements TTSStream {
  private aborted = false;
  private done = false;
  private pendingChunks: Buffer[] = [];
  private resolveWait: (() => void) | null = null;
  private errorHandlers: ((err: Error) => void)[] = [];
  private abortController: AbortController;

  constructor(client: OpenAI, model: string, voice: string, text: string, signal?: AbortSignal) {
    this.abortController = new AbortController();

    if (signal) {
      signal.addEventListener('abort', () => this.abort(), { once: true });
    }

    // Start the HTTP streaming request
    void this.startStreaming(client, model, voice, text);
  }

  private async startStreaming(
    client: OpenAI,
    model: string,
    voice: string,
    text: string
  ): Promise<void> {
    try {
      const response = await client.audio.speech.create(
        {
          model,
          voice: voice as 'alloy',
          input: text,
          response_format: 'pcm',
        },
        { signal: this.abortController.signal }
      );

      // Read the response as a stream
      const arrayBuffer = await response.arrayBuffer();
      if (this.aborted) return;

      // Split into ~100ms chunks (24kHz * 2 bytes * 0.1s = 4800 bytes)
      const CHUNK_SIZE = 4800;
      const fullBuffer = Buffer.from(arrayBuffer);
      for (let i = 0; i < fullBuffer.length; i += CHUNK_SIZE) {
        if (this.aborted) return;
        this.pendingChunks.push(fullBuffer.subarray(i, i + CHUNK_SIZE));
        this.resolveWait?.();
        this.resolveWait = null;
      }
    } catch (err) {
      if (!this.aborted) {
        log.warn('OpenAI TTS stream error', { err: String(err) });
        for (const handler of this.errorHandlers) handler(err as Error);
      }
    } finally {
      this.done = true;
      this.resolveWait?.();
      this.resolveWait = null;
    }
  }

  abort(): void {
    this.aborted = true;
    this.done = true;
    this.abortController.abort();
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
