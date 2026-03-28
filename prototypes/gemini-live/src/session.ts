import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { tools, handleToolCall } from './tools.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error('GOOGLE_API_KEY is required — set it in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

export interface SessionCallbacks {
  onAudio: (base64: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onError: (error: string) => void;
  onClose: () => void;
}

export function createGeminiSession(cb: SessionCallbacks) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;
  let resumeHandle: string | null = null;

  async function connect() {
    try {
      session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [
              {
                text: 'You are a helpful voice assistant. Keep responses short and conversational — one to two sentences unless the user asks for detail. Be direct, no filler.',
              },
            ],
          },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Sulafat' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
              prefixPaddingMs: 300,
              silenceDurationMs: 1000,
            },
          },
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
          tools,
        },
        callbacks: {
          onopen() {
            console.log('[gemini] connected');
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage(msg: any) {
            handleMessage(msg);
          },
          onerror(err: unknown) {
            console.error('[gemini] error:', err);
            cb.onError(String(err));
          },
          onclose() {
            console.log('[gemini] disconnected');
            cb.onClose();
          },
        },
      });
    } catch (err) {
      console.error('[gemini] connection failed:', err);
      cb.onError(`Connection failed: ${err}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMessage(msg: any) {
    // Session resumption handle
    if (msg.sessionResumptionUpdate?.newHandle) {
      resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }

    // GoAway — server will disconnect soon, reconnect
    if (msg.goAway) {
      console.log('[gemini] goAway — reconnecting...');
      reconnect();
      return;
    }

    // Model output (audio, transcripts)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Audio + inline text from model turn
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            cb.onAudio(part.inlineData.data);
          }
          if (part.text) {
            cb.onOutputTranscript(part.text);
          }
        }
      }

      if (sc.inputTranscription?.text) {
        cb.onInputTranscript(sc.inputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        cb.onOutputTranscript(sc.outputTranscription.text);
      }
      if (sc.interrupted) {
        cb.onInterrupted();
      }
      if (sc.turnComplete) {
        cb.onTurnComplete();
      }
    }

    // Tool calls — execute synchronously and respond
    if (msg.toolCall?.functionCalls) {
      const responses = [];
      for (const fc of msg.toolCall.functionCalls) {
        const name = fc.name ?? '';
        const args = (fc.args ?? {}) as Record<string, unknown>;
        cb.onToolCall(name, args);
        const result = handleToolCall(name, args);
        responses.push({ id: fc.id ?? '', name, response: result });
      }
      session?.sendToolResponse({ functionResponses: responses });
    }

    // Tool call cancellation
    if (msg.toolCallCancellation) {
      console.log('[gemini] tool calls cancelled:', msg.toolCallCancellation.ids);
    }
  }

  async function reconnect() {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    await connect();
  }

  function sendAudio(base64: string) {
    session?.sendRealtimeInput({
      audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
    });
  }

  function sendText(text: string) {
    session?.sendRealtimeInput({ text });
  }

  function sendAudioStreamEnd() {
    try {
      session?.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      /* method may not exist on all SDK versions */
    }
  }

  function close() {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    session = null;
  }

  return { connect, sendAudio, sendText, sendAudioStreamEnd, close };
}
