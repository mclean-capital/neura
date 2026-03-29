/**
 * Continuous Gemini Live session that receives video frames and builds
 * temporal visual context. Responds to text queries with descriptions
 * informed by everything it has seen.
 */

import { GoogleGenAI, Modality } from '@google/genai';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error('GOOGLE_API_KEY is required for vision — set it in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

export function createGeminiWatcher() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;
  let resumeHandle: string | null = null;
  let connected = false;

  // Pending query state
  let pendingQuery: { resolve: (text: string) => void } | null = null;
  let responseBuffer = '';

  async function connect() {
    try {
      session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          // Native audio model only supports AUDIO output — we capture text
          // via outputAudioTranscription and discard the audio data.
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [
              {
                text: [
                  'You are a visual observer receiving a continuous stream of video frames.',
                  "Frames may come from the user's camera or their shared screen.",
                  'You have temporal context — you can describe changes and actions over time.',
                  'Match your response length to the query: short questions get 1-2 sentences,',
                  'detailed questions (explain, walk through, review, analyze) get thorough responses.',
                  'If you notice something is a screen capture vs a camera shot, mention it.',
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
            console.log('[watcher] connected');
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage(msg: any) {
            handleMessage(msg);
          },
          onerror(err: unknown) {
            console.error('[watcher] error:', err);
          },
          onclose() {
            connected = false;
            console.log('[watcher] disconnected');
          },
        },
      });
    } catch (err) {
      console.error('[watcher] connection failed:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMessage(msg: any) {
    // Session resumption handle
    if (msg.sessionResumptionUpdate?.newHandle) {
      resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }

    // GoAway — reconnect before disconnect
    if (msg.goAway) {
      console.log('[watcher] goAway — reconnecting...');
      reconnect();
      return;
    }

    // Capture output transcription (text version of audio response)
    if (msg.serverContent?.outputTranscription?.text) {
      responseBuffer += msg.serverContent.outputTranscription.text;
    }

    // Turn complete — resolve pending query
    if (msg.serverContent?.turnComplete && pendingQuery) {
      pendingQuery.resolve(responseBuffer || 'No visual information available.');
      pendingQuery = null;
      responseBuffer = '';
    }
  }

  async function reconnect() {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    connected = false;
    await connect();
  }

  /** Send a video frame (JPEG) into the watcher's context. */
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

  /** Query the watcher with a text prompt. Returns description based on accumulated visual context. */
  function query(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      if (!connected || !session) {
        resolve('Vision not available — watcher not connected.');
        return;
      }

      // Resolve any stale pending query
      if (pendingQuery) {
        pendingQuery.resolve(responseBuffer || 'No response.');
        responseBuffer = '';
      }

      const timeout = setTimeout(() => {
        pendingQuery = null;
        responseBuffer = '';
        resolve('Vision analysis timed out.');
      }, 15000);

      pendingQuery = {
        resolve: (text: string) => {
          clearTimeout(timeout);
          resolve(text);
        },
      };

      responseBuffer = '';

      try {
        session.sendRealtimeInput({ text: prompt });
      } catch (err) {
        clearTimeout(timeout);
        pendingQuery = null;
        resolve('Failed to query watcher.');
      }
    });
  }

  function isConnected() {
    return connected;
  }

  function close() {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    session = null;
    connected = false;
    if (pendingQuery) {
      pendingQuery.resolve('Session closed.');
      pendingQuery = null;
    }
  }

  return { connect, sendFrame, query, isConnected, close };
}
