/**
 * Grok (xAI Realtime API) voice provider.
 *
 * Handles real-time bidirectional audio conversation with tool calling,
 * transcript seeding on reconnect, and proactive session renewal.
 */

import WebSocket from 'ws';
import { Logger } from '@neura/utils/logger';
import type { VoiceProvider, VoiceProviderCallbacks } from '@neura/types';
import {
  getToolDefs,
  handleToolCall,
  type MemoryToolHandler,
  type EnterModeHandler,
  type TaskToolHandler,
  type SkillToolHandler,
  type WorkerControlHandler,
  type WorkerDispatchHandler,
  type SystemStateHandler,
  type WorkerLogsHandler,
} from '../tools/index.js';

const log = new Logger('voice');

const WS_URL = 'wss://api.x.ai/v1/realtime';
const MAX_TRANSCRIPT_ENTRIES = 40;

export const GROK_VOICE_RATE_PER_MS = 0.05 / 60_000; // $0.05/min

export interface GrokVoiceConfig {
  /** API key — passed from registry RouteDescriptor. Falls back to process.env.XAI_API_KEY */
  apiKey?: string;
  voice?: string;
  vadThreshold?: number;
  vadSilenceDurationMs?: number;
  vadPrefixPaddingMs?: number;
  maxReconnectAttempts?: number;
  sessionMaxMs?: number;
  systemPromptPrefix?: string;
  memoryTools?: MemoryToolHandler;
  enterMode?: EnterModeHandler;
  taskTools?: TaskToolHandler;
  skillTools?: SkillToolHandler;
  workerControl?: WorkerControlHandler;
  workerDispatch?: WorkerDispatchHandler;
  systemState?: SystemStateHandler;
  workerLogs?: WorkerLogsHandler;
}

export class GrokVoiceProvider implements VoiceProvider {
  private readonly cb: VoiceProviderCallbacks;
  private readonly config: GrokVoiceConfig;
  private readonly voice: string;
  private readonly vadThreshold: number;
  private readonly vadSilenceDurationMs: number;
  private readonly vadPrefixPaddingMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly sessionMaxMs: number;
  private readonly XAI_API_KEY: string | undefined;

  private ws: WebSocket | null = null;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private readyFired = false;

  // Transcript history for context seeding on reconnect
  private readonly transcript: { role: 'user' | 'assistant'; text: string }[] = [];

  // Per-turn audio telemetry for debugging choppy playback
  private turnAudioChunks = 0;
  private turnAudioBytes = 0;

  // Phase 6: interject() rate limiting. One interject per 10s unless the
  // caller explicitly bypasses (clarification requests, worker completion
  // announcements). Ambient progress updates — tool_start / tool_end
  // affordances from VoiceFanoutBridge — respect the limit so Grok
  // doesn't get flooded by a chatty worker.
  private lastInterjectAt = 0;
  private readonly minInterjectIntervalMs = 10_000;

  constructor(cb: VoiceProviderCallbacks, config: GrokVoiceConfig = {}) {
    this.cb = cb;
    this.config = config;
    this.voice = config.voice ?? 'eve';
    this.vadThreshold = config.vadThreshold ?? 0.5;
    this.vadSilenceDurationMs = config.vadSilenceDurationMs ?? 1000;
    this.vadPrefixPaddingMs = config.vadPrefixPaddingMs ?? 300;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 5;
    this.sessionMaxMs = config.sessionMaxMs ?? 28 * 60 * 1000; // 28 min (Grok 30-min cap)
    this.XAI_API_KEY = config.apiKey ?? process.env.XAI_API_KEY;
  }

  private pushTranscript(role: 'user' | 'assistant', text: string): void {
    this.transcript.push({ role, text });
    if (this.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  private buildInstructions(): string {
    const base: string[] = [];

    if (this.config.systemPromptPrefix) {
      // Memory system provides a complete prompt with identity, preferences, tools, etc.
      base.push(this.config.systemPromptPrefix);
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
    if (this.transcript.length > 0) {
      const recent = this.transcript.slice(-20); // Last 20 exchanges
      const context = recent.map((t) => `${t.role}: ${t.text}`).join('\n');
      base.push(`\n[Session resumed. Previous conversation context:\n${context}\n]`);
    }

    return base.join('\n');
  }

  connect(): void {
    if (!this.XAI_API_KEY) {
      this.cb.onError('XAI_API_KEY is required — set it in .env');
      this.cb.onClose();
      return;
    }

    this.intentionalClose = false;

    this.ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${this.XAI_API_KEY}` },
    });

    this.ws.on('open', () => {
      const isReconnect = this.reconnectAttempts > 0 || this.transcript.length > 0;
      log.info('connected');
      this.reconnectAttempts = 0;

      this.ws!.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            voice: this.voice,
            instructions: this.buildInstructions(),
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: this.vadThreshold,
              silence_duration_ms: this.vadSilenceDurationMs,
              prefix_padding_ms: this.vadPrefixPaddingMs,
            },
            tools: getToolDefs({
              includeMemory: !!this.config.memoryTools,
              includePresence: !!this.config.enterMode,
              includeTasks: !!this.config.taskTools,
              includeSkills: !!this.config.skillTools,
              includeWorkerControl: !!this.config.workerControl,
              includeLogs: !!this.config.workerLogs,
            }),
          },
        })
      );

      // Proactive reconnect before session cap
      if (this.sessionTimer) clearTimeout(this.sessionTimer);
      this.sessionTimer = setTimeout(() => {
        log.info('proactive reconnect (approaching session limit)');
        void this.reconnect();
      }, this.sessionMaxMs);

      if (isReconnect) this.cb.onReconnected();
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        log.error('parse error', { err: String(err) });
      }
    });

    this.ws.on('error', (err) => {
      log.error('ws error', { err: err.message });
      this.cb.onError(err.message);
    });

    this.ws.on('close', () => {
      log.info('disconnected');
      if (this.sessionTimer) {
        clearTimeout(this.sessionTimer);
        this.sessionTimer = null;
      }

      if (!this.intentionalClose) {
        this.attemptReconnect();
      } else {
        this.cb.onClose();
      }
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error(`max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      this.cb.onError('Voice session disconnected — max reconnect attempts reached.');
      this.cb.onClose();
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 16_000);
    log.info(
      `reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private reconnect(): void {
    const oldWs = this.ws;
    this.ws = null;
    this.intentionalClose = true;
    try {
      oldWs?.close();
    } catch {
      /* ignore */
    }
    this.connect();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(msg: any): void {
    if (msg.type !== 'response.output_audio.delta' && msg.type !== 'ping') {
      log.debug('event', { type: msg.type });
    }

    switch (msg.type) {
      case 'session.created':
      case 'conversation.created':
        break;
      case 'session.updated':
        log.info('session configured');
        if (!this.readyFired) {
          this.readyFired = true;
          this.cb.onReady();
        }
        break;
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (msg.delta) {
          this.turnAudioChunks++;
          // base64 → bytes: length * 3/4 approximately
          const delta = msg.delta as string;
          this.turnAudioBytes += Math.floor((delta.length * 3) / 4);
          this.cb.onAudio(delta);
        }
        break;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (msg.delta) this.cb.onOutputTranscript(msg.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) {
          this.cb.onInputTranscript(msg.transcript);
          this.pushTranscript('user', msg.transcript);
        }
        break;
      case 'input_audio_buffer.speech_started':
        this.cb.onInterrupted();
        break;
      case 'response.done': {
        // Log per-turn audio telemetry so we can correlate chopped playback
        // with what xAI actually sent.
        // At 24 kHz int16 mono: 48_000 bytes per second → bytes / 48 = ms
        const audioMs = Math.round(this.turnAudioBytes / 48);
        log.info('turn audio', {
          chunks: this.turnAudioChunks,
          bytes: this.turnAudioBytes,
          ms: audioMs,
        });
        this.turnAudioChunks = 0;
        this.turnAudioBytes = 0;

        this.cb.onTurnComplete();
        const outputItems = msg.response?.output;
        const fullParts: string[] = [];
        if (Array.isArray(outputItems)) {
          for (const item of outputItems) {
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.transcript) {
                  this.pushTranscript('assistant', part.transcript);
                  fullParts.push(part.transcript);
                }
              }
            }
          }
        }
        if (fullParts.length > 0) {
          this.cb.onOutputTranscriptComplete(fullParts.join(''));
        }
        break;
      }
      case 'response.function_call_arguments.done':
        void this.handleFunctionCallDone(msg);
        break;
      case 'error':
        log.error('api error', { error: msg.error });
        this.cb.onError(msg.error?.message || 'Unknown error');
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleFunctionCallDone(msg: any): Promise<void> {
    const name: string = msg.name ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(msg.arguments ?? '{}');
    } catch {
      /* malformed args */
    }

    const currentWs = this.ws;
    const callId = msg.call_id;

    this.cb.onToolCall(name, args);
    const result = await handleToolCall(name, args, {
      queryWatcher: this.cb.queryWatcher,
      memoryTools: this.config.memoryTools,
      enterMode: this.config.enterMode,
      taskTools: this.config.taskTools,
      skillTools: this.config.skillTools,
      workerControl: this.config.workerControl,
      workerDispatch: this.config.workerDispatch,
      systemState: this.config.systemState,
      workerLogs: this.config.workerLogs,
    });
    this.cb.onToolResult(name, result);

    if (currentWs && currentWs === this.ws && currentWs.readyState === WebSocket.OPEN) {
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

  sendAudio(base64: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
    }
  }

  sendText(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.pushTranscript('user', text);
    this.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      })
    );
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  sendSystemEvent(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
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

  /**
   * Phase 6 — inject a message into the active voice session from Neura's
   * side (worker progress updates, clarification requests, "Done."
   * affordances from VoiceFanoutBridge). Implements the
   * `VoiceInterjector` interface used by `VoiceFanoutBridge`.
   *
   * Contract:
   *   - `immediate: false` — queue as a conversation item that Grok
   *     reads on the next natural turn boundary (when the user speaks
   *     next). Used for progress updates and "Done." completion.
   *   - `immediate: true` — queue AND fire `response.create` so Grok
   *     speaks the message right now, interrupting any in-flight
   *     response via `response.cancel` first. Used for clarification
   *     requests that can't wait.
   *   - `bypassRateLimit: true` — skip the 10s rate limiter. Used for
   *     clarification requests and worker completion announcements
   *     which are always important.
   *
   * Returns a Promise<void> to satisfy the VoiceInterjector interface
   * even though the underlying ws.send is synchronous. If the ws is not
   * open or the rate limiter drops the message, the method logs and
   * resolves — it never throws, per the voice-fanout-bridge's
   * expectation that the interjector is fire-and-forget.
   */
  interject(
    message: string,
    options: { immediate: boolean; bypassRateLimit?: boolean }
  ): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      log.warn('interject called with no active ws', { preview: message.slice(0, 80) });
      return Promise.resolve();
    }

    const now = Date.now();
    if (!options.bypassRateLimit && now - this.lastInterjectAt < this.minInterjectIntervalMs) {
      log.info('interject rate-limited, dropping', {
        preview: message.slice(0, 80),
        msSinceLast: now - this.lastInterjectAt,
      });
      return Promise.resolve();
    }
    this.lastInterjectAt = now;

    // Inject as a `system` tagged user item so Grok's reasoning treats
    // it as context from the environment, not the user's own words.
    // Mirror the sendSystemEvent shape but use a distinct prefix so
    // the listen client can render it separately if needed.
    this.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[Neura: ${message}]` }],
        },
      })
    );

    if (options.immediate) {
      // Break any in-flight response and speak the new message right now.
      // response.cancel is a no-op if no response is streaming, so it's
      // safe to send unconditionally.
      this.ws.send(JSON.stringify({ type: 'response.cancel' }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    }
    return Promise.resolve();
  }

  close(): void {
    this.intentionalClose = true;
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
