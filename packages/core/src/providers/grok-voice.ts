/**
 * Grok (xAI Realtime API) voice provider.
 *
 * Handles real-time bidirectional audio conversation with tool calling,
 * transcript seeding on reconnect, and proactive session renewal.
 */

import WebSocket from 'ws';
import { Logger } from '@neura/utils/logger';
import type { VoiceProvider, VoiceProviderCallbacks } from '@neura/types';
import { getToolDefs, handleToolCall, type MemoryToolHandler } from '../tools.js';

const log = new Logger('voice');

const WS_URL = 'wss://api.x.ai/v1/realtime';
const MAX_TRANSCRIPT_ENTRIES = 40;

export const GROK_VOICE_RATE_PER_MS = 0.05 / 60_000; // $0.05/min

export interface GrokVoiceConfig {
  voice?: string;
  vadThreshold?: number;
  vadSilenceDurationMs?: number;
  vadPrefixPaddingMs?: number;
  maxReconnectAttempts?: number;
  sessionMaxMs?: number;
  systemPromptPrefix?: string;
  memoryTools?: MemoryToolHandler;
}

export function createGrokVoiceSession(
  cb: VoiceProviderCallbacks,
  config: GrokVoiceConfig = {}
): VoiceProvider {
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
    const base: string[] = [];

    if (config.systemPromptPrefix) {
      // Memory system provides a complete prompt with identity, preferences, tools, etc.
      base.push(config.systemPromptPrefix);
    } else {
      // Fallback: hardcoded personality when memory system is not available
      base.push(
        'You are a helpful voice assistant with camera and screen vision.',
        "You can see through the user's camera using the describe_camera tool.",
        "You can see the user's shared screen using the describe_screen tool.",
        'When the user asks you to look at something physical, use describe_camera.',
        'When they ask about their screen, code, or display, use describe_screen.',
        'Keep responses short and conversational — 1-2 sentences unless asked for detail.',
        'Be direct, no filler.'
      );
    }

    // Seed context from previous transcript on reconnect
    if (transcript.length > 0) {
      const recent = transcript.slice(-20); // Last 20 exchanges
      const context = recent.map((t) => `${t.role}: ${t.text}`).join('\n');
      base.push(`\n[Session resumed. Previous conversation context:\n${context}\n]`);
    }

    return base.join('\n');
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
      log.info('connected');
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
            tools: getToolDefs(!!config.memoryTools),
          },
        })
      );

      // Proactive reconnect before session cap
      if (sessionTimer) clearTimeout(sessionTimer);
      sessionTimer = setTimeout(() => {
        log.info('proactive reconnect (approaching session limit)');
        void reconnect();
      }, sessionMaxMs);

      if (isReconnect) cb.onReconnected();
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(msg);
      } catch (err) {
        log.error('parse error', { err: String(err) });
      }
    });

    ws.on('error', (err) => {
      log.error('ws error', { err: err.message });
      cb.onError(err.message);
    });

    ws.on('close', () => {
      log.info('disconnected');
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
      log.error(`max reconnect attempts (${maxReconnectAttempts}) reached`);
      cb.onError('Voice session disconnected — max reconnect attempts reached.');
      cb.onClose();
      return;
    }

    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16_000);
    log.info(`reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);

    setTimeout(() => {
      connect();
    }, delay);
  }

  function reconnect() {
    const oldWs = ws;
    ws = null;
    intentionalClose = true;
    try {
      oldWs?.close();
    } catch {
      /* ignore */
    }
    connect();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMessage(msg: any) {
    if (msg.type !== 'response.output_audio.delta' && msg.type !== 'ping') {
      log.debug('event', { type: msg.type });
    }

    switch (msg.type) {
      case 'session.created':
      case 'conversation.created':
        break;
      case 'session.updated':
        log.info('session configured');
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
        const outputItems = msg.response?.output;
        const fullParts: string[] = [];
        if (Array.isArray(outputItems)) {
          for (const item of outputItems) {
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.transcript) {
                  pushTranscript('assistant', part.transcript);
                  fullParts.push(part.transcript);
                }
              }
            }
          }
        }
        if (fullParts.length > 0) {
          cb.onOutputTranscriptComplete(fullParts.join(''));
        }
        break;
      }
      case 'response.function_call_arguments.done':
        void handleFunctionCallDone(msg);
        break;
      case 'error':
        log.error('api error', { error: msg.error });
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

    const currentWs = ws;
    const callId = msg.call_id;

    cb.onToolCall(name, args);
    const result = await handleToolCall(name, args, cb.queryWatcher, config.memoryTools);
    cb.onToolResult(name, result);

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
