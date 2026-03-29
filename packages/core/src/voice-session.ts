/**
 * Voice session that handles real-time bidirectional audio conversation
 * with tool calling support.
 *
 * Currently backed by Grok (xAI Realtime API).
 */

import WebSocket from 'ws';
import { toolDefs, handleToolCall } from './tools.js';

const WS_URL = 'wss://api.x.ai/v1/realtime';
const MAX_TRANSCRIPT_ENTRIES = 40;

export interface SessionCallbacks {
  onAudio: (base64: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: Record<string, unknown>) => void;
  onError: (error: string) => void;
  onClose: () => void;
  onReconnected: () => void;
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>;
}

interface VoiceSessionConfig {
  voice?: string;
  vadThreshold?: number;
  vadSilenceDurationMs?: number;
  vadPrefixPaddingMs?: number;
  maxReconnectAttempts?: number;
  sessionMaxMs?: number;
}

export function createVoiceSession(cb: SessionCallbacks, config: VoiceSessionConfig = {}) {
  const voice = config.voice ?? 'eve';
  const vadThreshold = config.vadThreshold ?? 0.5;
  const vadSilenceDurationMs = config.vadSilenceDurationMs ?? 1000;
  const vadPrefixPaddingMs = config.vadPrefixPaddingMs ?? 300;
  const maxReconnectAttempts = config.maxReconnectAttempts ?? 5;
  const sessionMaxMs = config.sessionMaxMs ?? 28 * 60 * 1000; // 28 min (Grok 30-min cap)

  const XAI_API_KEY = process.env.XAI_API_KEY;

  let ws: WebSocket | null = null;
  let intentionalClose = false;
  let reconnectAttempts = 0;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

  // Transcript history for context seeding on reconnect
  const transcript: { role: 'user' | 'assistant'; text: string }[] = [];

  function pushTranscript(role: 'user' | 'assistant', text: string) {
    transcript.push({ role, text });
    if (transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  function buildInstructions(): string {
    const base = [
      'You are a helpful voice assistant with camera and screen vision.',
      "You can see through the user's camera using the describe_camera tool.",
      "You can see the user's shared screen using the describe_screen tool.",
      'When the user asks you to look at something physical, use describe_camera.',
      'When they ask about their screen, code, or display, use describe_screen.',
      'Keep responses short and conversational — 1-2 sentences unless asked for detail.',
      'Be direct, no filler.',
    ];

    // Seed context from previous transcript on reconnect
    if (transcript.length > 0) {
      const recent = transcript.slice(-20); // Last 20 exchanges
      const context = recent.map((t) => `${t.role}: ${t.text}`).join('\n');
      base.push(`\n[Session resumed. Previous conversation context:\n${context}\n]`);
    }

    return base.join(' ');
  }

  function connect() {
    if (!XAI_API_KEY) {
      cb.onError('XAI_API_KEY is required — set it in .env');
      cb.onClose();
      return;
    }

    intentionalClose = false;

    ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    ws.on('open', () => {
      const isReconnect = reconnectAttempts > 0 || transcript.length > 0;
      console.log('[voice] connected');
      reconnectAttempts = 0;

      ws!.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            voice,
            instructions: buildInstructions(),
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: vadThreshold,
              silence_duration_ms: vadSilenceDurationMs,
              prefix_padding_ms: vadPrefixPaddingMs,
            },
            tools: toolDefs,
          },
        })
      );

      // Proactive reconnect before session cap
      if (sessionTimer) clearTimeout(sessionTimer);
      sessionTimer = setTimeout(() => {
        console.log('[voice] proactive reconnect (approaching session limit)');
        void reconnect();
      }, sessionMaxMs);

      if (isReconnect) cb.onReconnected();
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(msg);
      } catch (err) {
        console.error('[voice] parse error:', err);
      }
    });

    ws.on('error', (err) => {
      console.error('[voice] ws error:', err);
      cb.onError(err.message);
    });

    ws.on('close', () => {
      console.log('[voice] disconnected');
      if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
      }

      if (!intentionalClose) {
        attemptReconnect();
      } else {
        cb.onClose();
      }
    });
  }

  function attemptReconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`[voice] max reconnect attempts (${maxReconnectAttempts}) reached`);
      cb.onError('Voice session disconnected — max reconnect attempts reached.');
      cb.onClose();
      return;
    }

    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16_000);
    console.log(
      `[voice] reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`
    );

    setTimeout(() => {
      connect();
    }, delay);
  }

  function reconnect() {
    // Detach the old socket so its close event doesn't trigger attemptReconnect
    const oldWs = ws;
    ws = null;
    intentionalClose = true;
    try {
      oldWs?.close();
    } catch {
      /* ignore */
    }
    // connect() resets intentionalClose to false
    connect();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMessage(msg: any) {
    if (msg.type !== 'response.output_audio.delta' && msg.type !== 'ping') {
      console.log('[voice] event:', msg.type);
    }

    switch (msg.type) {
      case 'session.created':
      case 'conversation.created':
        break;
      case 'session.updated':
        console.log('[voice] session configured');
        break;
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (msg.delta) cb.onAudio(msg.delta);
        break;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (msg.delta) cb.onOutputTranscript(msg.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) {
          cb.onInputTranscript(msg.transcript);
          pushTranscript('user', msg.transcript);
        }
        break;
      case 'input_audio_buffer.speech_started':
        cb.onInterrupted();
        break;
      case 'response.done': {
        cb.onTurnComplete();
        // Capture completed assistant response into transcript
        const outputItems = msg.response?.output;
        if (Array.isArray(outputItems)) {
          for (const item of outputItems) {
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.transcript) {
                  pushTranscript('assistant', part.transcript);
                }
              }
            }
          }
        }
        break;
      }
      case 'response.function_call_arguments.done':
        void handleFunctionCallDone(msg);
        break;
      case 'error':
        console.error('[voice] error:', msg.error);
        cb.onError(msg.error?.message || 'Unknown error');
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleFunctionCallDone(msg: any) {
    const name: string = msg.name ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(msg.arguments ?? '{}');
    } catch {
      /* malformed args */
    }

    // Capture the current ws before the async gap — if a reconnect happens
    // during the tool call, we must not send the result to the new session.
    const currentWs = ws;
    const callId = msg.call_id;

    cb.onToolCall(name, args);
    const result = await handleToolCall(name, args, cb.queryWatcher);
    cb.onToolResult(name, result);

    // Only send if the session hasn't been replaced during the await
    if (currentWs && currentWs === ws && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(result),
          },
        })
      );
      currentWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  function sendAudio(base64: string) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
    }
  }

  function sendText(text: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    pushTranscript('user', text);
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      })
    );
    ws.send(JSON.stringify({ type: 'response.create' }));
  }

  /** Inject a system context message without triggering a response. */
  function sendSystemEvent(text: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[System: ${text}]` }],
        },
      })
    );
  }

  function close() {
    intentionalClose = true;
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  return { connect, sendAudio, sendText, sendSystemEvent, close };
}
