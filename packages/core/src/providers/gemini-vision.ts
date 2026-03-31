/**
 * Gemini (Google GenAI Live API) vision provider.
 *
 * Receives continuous video frames and builds temporal visual context.
 * Responds to text queries with descriptions informed by everything it has seen.
 * Each instance watches a single source (camera or screen).
 */

import { GoogleGenAI, Modality } from '@google/genai';
import crypto from 'crypto';
import { Logger } from '@neura/utils';
import type { VisionProvider } from '@neura/types';

export const GEMINI_VISION_RATE_PER_MS = 0.002 / 60_000; // ~$0.002/min per stream

interface PendingQuery {
  id: string;
  prompt: string;
  resolve: (text: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface GeminiVisionConfig {
  label?: string;
  model?: string;
  queryTimeoutMs?: number;
}

export function createGeminiVisionWatcher(config: GeminiVisionConfig = {}): VisionProvider {
  const label = config.label ?? 'vision';
  const model = config.model ?? 'gemini-3.1-flash-live-preview';
  const queryTimeoutMs = config.queryTimeoutMs ?? 15_000;
  const maxReconnectAttempts = 5;
  const log = new Logger(label);

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;
  let resumeHandle: string | null = null;
  let connected = false;
  let intentionalClose = false;
  let reconnectAttempts = 0;

  // Query queue — sequential processing, concurrent queuing
  const queryQueue = new Map<string, PendingQuery>();
  let activeQueryId: string | null = null;
  let responseBuffer = '';

  async function connect() {
    if (!GOOGLE_API_KEY) {
      log.error('GOOGLE_API_KEY is required — set it in .env');
      return;
    }

    const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
    intentionalClose = false;

    try {
      session = await ai.live.connect({
        model,
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
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
        },
        callbacks: {
          onopen() {
            connected = true;
            reconnectAttempts = 0;
            log.info('connected');
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage(msg: any) {
            handleMessage(msg);
          },
          onerror(err: unknown) {
            log.error('error', { err: String(err) });
          },
          onclose() {
            connected = false;
            log.info('disconnected');
            if (!intentionalClose) {
              attemptReconnect();
            }
          },
        },
      });

      // If close() was called while connect() was in-flight, tear down immediately
      if (intentionalClose) {
        try {
          session?.close();
        } catch {
          /* ignore */
        }
        session = null;
        connected = false;
        return;
      }
    } catch (err) {
      log.error('connection failed', { err: String(err) });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMessage(msg: any) {
    if (msg.sessionResumptionUpdate?.newHandle) {
      resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }

    if (msg.goAway) {
      log.info('goAway — reconnecting...');
      connected = false;
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      session = null;
      attemptReconnect();
      return;
    }

    if (msg.serverContent?.outputTranscription?.text) {
      responseBuffer += msg.serverContent.outputTranscription.text;
    }

    if (msg.serverContent?.turnComplete && activeQueryId) {
      const pending = queryQueue.get(activeQueryId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(responseBuffer || 'No visual information available.');
        queryQueue.delete(activeQueryId);
      }
      activeQueryId = null;
      responseBuffer = '';
      processNextQuery();
    }
  }

  function attemptReconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
      log.error(`max reconnect attempts (${maxReconnectAttempts}) reached`);
      return;
    }
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16_000);
    log.info(`reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
    setTimeout(() => {
      void connect();
    }, delay);
  }

  function processNextQuery() {
    if (activeQueryId || queryQueue.size === 0 || !connected || !session) return;

    const [id, pending] = queryQueue.entries().next().value!;
    activeQueryId = id;
    responseBuffer = '';

    try {
      session.sendRealtimeInput({ text: pending.prompt });
    } catch {
      clearTimeout(pending.timeout);
      pending.resolve('Failed to query vision.');
      queryQueue.delete(id);
      activeQueryId = null;
      processNextQuery();
    }
  }

  function sendFrame(base64Jpeg: string) {
    if (!connected || !session) return;
    try {
      session.sendRealtimeInput({
        video: { data: base64Jpeg, mimeType: 'image/jpeg' },
      });
    } catch {
      /* frame dropped — non-critical */
    }
  }

  function query(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      if (!connected || !session) {
        resolve('Vision not available — watcher not connected.');
        return;
      }

      const id = crypto.randomUUID();

      const timeout = setTimeout(() => {
        queryQueue.delete(id);
        if (activeQueryId === id) {
          activeQueryId = null;
          responseBuffer = '';
          processNextQuery();
        }
        resolve('Vision analysis timed out.');
      }, queryTimeoutMs);

      queryQueue.set(id, { id, prompt, resolve, timeout });
      processNextQuery();
    });
  }

  function isConnected() {
    return connected;
  }

  function close() {
    intentionalClose = true;
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    session = null;
    connected = false;
    resumeHandle = null;

    for (const [, pending] of queryQueue) {
      clearTimeout(pending.timeout);
      pending.resolve('Session closed.');
    }
    queryQueue.clear();
    activeQueryId = null;
    responseBuffer = '';
  }

  return { connect, sendFrame, query, isConnected, close };
}
