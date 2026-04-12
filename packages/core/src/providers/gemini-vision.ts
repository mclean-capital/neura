/**
 * Gemini (Google GenAI Live API) vision provider.
 *
 * Receives continuous video frames and builds temporal visual context.
 * Responds to text queries with descriptions informed by everything it has seen.
 * Each instance watches a single source (camera or screen).
 */

import { GoogleGenAI, Modality } from '@google/genai';
import crypto from 'crypto';
import { Logger } from '@neura/utils/logger';
import type { VisionProvider } from '@neura/types';

export const GEMINI_VISION_RATE_PER_MS = 0.002 / 60_000; // ~$0.002/min per stream

interface PendingQuery {
  id: string;
  prompt: string;
  resolve: (text: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface GeminiVisionConfig {
  /** API key — passed from registry RouteDescriptor. Falls back to process.env.GOOGLE_API_KEY */
  apiKey?: string;
  label?: string;
  model?: string;
  queryTimeoutMs?: number;
}

export class GeminiVisionProvider implements VisionProvider {
  private readonly label: string;
  private readonly model: string;
  private readonly queryTimeoutMs: number;
  private readonly maxReconnectAttempts = 5;
  private readonly log: Logger;
  private readonly googleApiKey: string | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private resumeHandle: string | null = null;
  private connected = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;

  // Query queue — sequential processing, concurrent queuing
  private readonly queryQueue = new Map<string, PendingQuery>();
  private activeQueryId: string | null = null;
  private responseBuffer = '';

  constructor(config: GeminiVisionConfig = {}) {
    this.label = config.label ?? 'vision';
    this.model = config.model ?? 'gemini-3.1-flash-live-preview';
    this.queryTimeoutMs = config.queryTimeoutMs ?? 15_000;
    this.log = new Logger(this.label);
    this.googleApiKey = config.apiKey ?? process.env.GOOGLE_API_KEY;
  }

  async connect(): Promise<void> {
    if (!this.googleApiKey) {
      this.log.error('GOOGLE_API_KEY is required — set it in .env');
      return;
    }

    const ai = new GoogleGenAI({ apiKey: this.googleApiKey });
    this.intentionalClose = false;

    try {
      this.session = await ai.live.connect({
        model: this.model,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [
              {
                text: [
                  'You are a visual observer receiving a continuous stream of video frames.',
                  'You have temporal context — you can describe changes and actions over time.',
                  'Match your response length to the query: short questions get 1-2 sentences,',
                  'detailed questions (explain, walk through, review, analyze) get thorough responses.',
                ].join(' '),
              },
            ],
          },
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
        },
        callbacks: {
          onopen: () => {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.log.info('connected');
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage: (msg: any) => {
            this.handleMessage(msg);
          },
          onerror: (err: unknown) => {
            this.log.error('error', { err: String(err) });
          },
          onclose: () => {
            this.connected = false;
            this.log.info('disconnected');
            if (!this.intentionalClose) {
              this.attemptReconnect();
            }
          },
        },
      });

      // If close() was called while connect() was in-flight, tear down immediately
      if (this.intentionalClose) {
        try {
          this.session?.close();
        } catch {
          /* ignore */
        }
        this.session = null;
        this.connected = false;
        return;
      }
    } catch (err) {
      this.log.error('connection failed', { err: String(err) });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(msg: any): void {
    if (msg.sessionResumptionUpdate?.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }

    if (msg.goAway) {
      this.log.info('goAway — reconnecting...');
      this.connected = false;
      try {
        this.session?.close();
      } catch {
        /* ignore */
      }
      this.session = null;
      this.attemptReconnect();
      return;
    }

    if (msg.serverContent?.outputTranscription?.text) {
      this.responseBuffer += msg.serverContent.outputTranscription.text;
    }

    if (msg.serverContent?.turnComplete && this.activeQueryId) {
      const pending = this.queryQueue.get(this.activeQueryId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(this.responseBuffer || 'No visual information available.');
        this.queryQueue.delete(this.activeQueryId);
      }
      this.activeQueryId = null;
      this.responseBuffer = '';
      this.processNextQuery();
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error(`max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 16_000);
    this.log.info(
      `reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );
    setTimeout(() => {
      void this.connect();
    }, delay);
  }

  private processNextQuery(): void {
    if (this.activeQueryId || this.queryQueue.size === 0 || !this.connected || !this.session)
      return;

    const [id, pending] = this.queryQueue.entries().next().value!;
    this.activeQueryId = id;
    this.responseBuffer = '';

    try {
      this.session.sendRealtimeInput({ text: pending.prompt });
    } catch {
      clearTimeout(pending.timeout);
      pending.resolve('Failed to query vision.');
      this.queryQueue.delete(id);
      this.activeQueryId = null;
      this.processNextQuery();
    }
  }

  sendFrame(base64Jpeg: string): void {
    if (!this.connected || !this.session) return;
    try {
      this.session.sendRealtimeInput({
        video: { data: base64Jpeg, mimeType: 'image/jpeg' },
      });
    } catch {
      /* frame dropped — non-critical */
    }
  }

  query(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.connected || !this.session) {
        resolve('Vision not available — watcher not connected.');
        return;
      }

      const id = crypto.randomUUID();

      const timeout = setTimeout(() => {
        this.queryQueue.delete(id);
        if (this.activeQueryId === id) {
          this.activeQueryId = null;
          this.responseBuffer = '';
          this.processNextQuery();
        }
        resolve('Vision analysis timed out.');
      }, this.queryTimeoutMs);

      this.queryQueue.set(id, { id, prompt, resolve, timeout });
      this.processNextQuery();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.intentionalClose = true;
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.connected = false;
    this.resumeHandle = null;

    for (const [, pending] of this.queryQueue) {
      clearTimeout(pending.timeout);
      pending.resolve('Session closed.');
    }
    this.queryQueue.clear();
    this.activeQueryId = null;
    this.responseBuffer = '';
  }
}
