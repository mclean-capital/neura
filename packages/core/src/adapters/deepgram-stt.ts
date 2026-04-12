import WebSocket from 'ws';
import { Logger } from '@neura/utils/logger';
import type {
  STTAdapter,
  STTStream,
  STTPartialResult,
  AudioFormat,
  RouteDescriptor,
} from '@neura/types';

const log = new Logger('deepgram-stt');

const DEFAULT_MODEL = 'nova-3';
const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/listen';

/**
 * Deepgram WebSocket streaming STT adapter.
 * Accepts PCM16 audio at the configured sample rate and yields partial/final transcripts.
 */
export class DeepgramSTTAdapter implements STTAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly sampleRate: number;

  constructor(route: RouteDescriptor, sampleRate = 24000) {
    this.apiKey = route.apiKey;
    this.model = route.model || DEFAULT_MODEL;
    this.sampleRate = sampleRate;
  }

  async transcribe(audio: Buffer): Promise<string> {
    // One-shot transcription via a short-lived stream
    const stream = this.createStream();
    const results: string[] = [];
    stream.write(audio);
    stream.end();
    for await (const partial of stream) {
      if (partial.isFinal && partial.text) {
        results.push(partial.text);
      }
    }
    return results.join(' ');
  }

  createStream(_format?: AudioFormat): STTStream {
    return new DeepgramSTTStream(this.apiKey, this.model, this.sampleRate);
  }

  close(): void {
    // No persistent state to clean up
  }
}

class DeepgramSTTStream implements STTStream {
  private ws: WebSocket | null = null;
  private aborted = false;
  private ended = false;
  private pendingResults: STTPartialResult[] = [];
  private resolveWait: (() => void) | null = null;
  private errorHandlers: ((err: Error) => void)[] = [];
  private doneResolve: (() => void) | null = null;
  /** Buffer audio until WebSocket is OPEN (prevents dropped wake audio) */
  private preOpenBuffer: Buffer[] = [];
  private wsOpen = false;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly sampleRate: number
  ) {
    this.connect();
  }

  private connect(): void {
    const params = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      model: this.model,
      smart_format: 'true',
      endpointing: '300',
      interim_results: 'true',
      utterance_end_ms: '1000',
    });

    this.ws = new WebSocket(`${DEEPGRAM_WS_BASE}?${params.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      this.wsOpen = true;
      // Flush any audio that arrived before the WS was open
      for (const buf of this.preOpenBuffer) {
        this.ws?.send(buf);
      }
      this.preOpenBuffer = [];
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as DeepgramResponse;
        if (msg.type === 'Results') {
          const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
          if (transcript || msg.is_final) {
            this.pendingResults.push({
              text: transcript,
              isFinal: !!msg.is_final,
            });
            this.resolveWait?.();
            this.resolveWait = null;
          }
        } else if (msg.type === 'UtteranceEnd') {
          // Utterance boundary — emit a final marker
          this.pendingResults.push({ text: '', isFinal: true });
          this.resolveWait?.();
          this.resolveWait = null;
        }
      } catch (err) {
        log.warn('failed to parse Deepgram message', { err: String(err) });
      }
    });

    this.ws.on('error', (err: Error) => {
      log.warn('Deepgram WS error', { err: err.message });
      for (const handler of this.errorHandlers) handler(err);
    });

    this.ws.on('close', () => {
      this.ended = true;
      this.resolveWait?.();
      this.resolveWait = null;
      this.doneResolve?.();
    });
  }

  write(audio: Buffer): void {
    if (this.aborted || this.ended) return;
    if (this.wsOpen && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(audio);
    } else {
      // Buffer until WS is open (prevents dropped wake/activation audio)
      this.preOpenBuffer.push(audio);
    }
  }

  end(): void {
    if (this.aborted || this.ended) return;
    this.ended = true;
    // Send close frame to Deepgram — it will finalize pending audio
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  abort(): void {
    this.aborted = true;
    this.ended = true;
    this.preOpenBuffer = [];
    // Close WS in any connected state (OPEN or CONNECTING)
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close();
    }
    this.ws = null;
    this.resolveWait?.();
    this.resolveWait = null;
  }

  on(event: 'error', handler: (err: Error) => void): void {
    if (event === 'error') this.errorHandlers.push(handler);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<STTPartialResult> {
    while (true) {
      if (this.pendingResults.length > 0) {
        yield this.pendingResults.shift()!;
        continue;
      }
      if (this.aborted || (this.ended && this.pendingResults.length === 0)) {
        return;
      }
      // Wait for next result
      await new Promise<void>((resolve) => {
        this.resolveWait = resolve;
      });
    }
  }
}

interface DeepgramResponse {
  type: string;
  channel?: {
    alternatives?: { transcript: string; confidence: number }[];
  };
  is_final?: boolean;
  speech_final?: boolean;
}
