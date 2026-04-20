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

        const res = msg.response;
        const outputItems: unknown[] = Array.isArray(res?.output) ? res.output : [];

        const fullParts: string[] = [];
        for (const item of outputItems) {
          const it = item as { type?: string; content?: unknown };
          if (it.type === 'message' && Array.isArray(it.content)) {
            for (const part of it.content as { transcript?: string }[]) {
              if (part.transcript) {
                this.pushTranscript('assistant', part.transcript);
                fullParts.push(part.transcript);
              }
            }
          }
        }
        if (fullParts.length > 0) {
          this.cb.onOutputTranscriptComplete(fullParts.join(''));
        }

        // Phase-6b batch dispatch. All function calls emitted in this model
        // response are dispatched together, and exactly one `response.create`
        // is fired afterwards — regardless of how many calls the model made.
        // Previously each `response.function_call_arguments.done` independently
        // posted its output + fired response.create, which generated N
        // consecutive assistant turns (monologue) for N parallel tool calls
        // and made the model re-request tools because each follow-up turn
        // started before it had seen the prior batch's outputs.
        //
        // Skip dispatch when the response didn't complete cleanly
        // (cancelled/incomplete/failed): executing tools from an interrupted
        // turn is the "barge-in double-action" bug.
        if (res?.status === 'completed') {
          void this.dispatchFunctionCalls(outputItems);
        }
        break;
      }
      case 'error':
        log.error('api error', { error: msg.error });
        this.cb.onError(msg.error?.message || 'Unknown error');
        break;
    }
  }

  /**
   * Execute every `function_call` item from a completed `response.done`
   * payload in parallel, post their outputs in original `output_index`
   * order, then fire exactly one `response.create` so the model sees the
   * full batch as a single follow-up turn.
   *
   * Authoritative source: `response.output`. We intentionally do NOT
   * buffer `response.function_call_arguments.done` deltas; `response.done`
   * carries the finalized list and is the only shape we trust — see the
   * Codex review cited in the corresponding commit.
   */
  private async dispatchFunctionCalls(outputItems: unknown[]): Promise<void> {
    interface PendingCall {
      callId: string;
      name: string;
      args: Record<string, unknown>;
      outputIndex: number;
    }

    const calls: PendingCall[] = [];
    outputItems.forEach((item, idx) => {
      const it = item as {
        type?: string;
        name?: string;
        call_id?: string;
        arguments?: string;
      };
      if (it.type !== 'function_call' || !it.call_id || typeof it.name !== 'string') return;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(it.arguments ?? '{}');
      } catch {
        /* malformed args — dispatch with {} so the handler can error-report */
      }
      calls.push({ callId: it.call_id, name: it.name, args: parsed, outputIndex: idx });
    });

    // Dedupe by call_id — defends against replayed events on reconnect or
    // mixed handling paths. Preserve first-occurrence order.
    const seen = new Set<string>();
    const unique = calls.filter((c) => {
      if (seen.has(c.callId)) return false;
      seen.add(c.callId);
      return true;
    });

    if (unique.length === 0) return;

    const currentWs = this.ws;

    // Sequential dispatch. Individual `handleToolCall` invocations are
    // stateless at their boundary, but several tools in this codebase
    // read-then-mutate shared state (e.g. `pause_worker` + `list_active_workers`
    // in the same turn, or `update_task` racing a concurrent `get_task`).
    // PGlite serializes each SQL statement but not the handler-level
    // read-modify-write sequence — running the batch in parallel would
    // let `list_active_workers` fire its SELECT before `pause_worker`'s
    // UPDATE lands and return a stale list. Serial execution preserves
    // the pre-refactor single-call-at-a-time semantics and matches what
    // a voice-agent user expects ("pause X and tell me what's left" sees
    // X already paused). Per-call try/catch so one handler throwing
    // doesn't drop the other outputs.
    const outcomes: { callId: string; result: unknown; outputIndex: number }[] = [];
    for (const c of unique) {
      this.cb.onToolCall(c.name, c.args);
      try {
        const result = await handleToolCall(c.name, c.args, {
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
        this.cb.onToolResult(c.name, result);
        outcomes.push({ callId: c.callId, result, outputIndex: c.outputIndex });
      } catch (err) {
        const errorResult = { error: `Tool ${c.name} failed: ${String(err)}` };
        this.cb.onToolResult(c.name, errorResult);
        outcomes.push({ callId: c.callId, result: errorResult, outputIndex: c.outputIndex });
      }
    }

    if (!currentWs || currentWs !== this.ws || currentWs.readyState !== WebSocket.OPEN) return;

    // Post outputs in original output_index order for deterministic replay
    // (not required for correctness — call_id is the join key — but keeps
    // conversation history readable).
    outcomes
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .forEach((o) => {
        currentWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: o.callId,
              output: JSON.stringify(o.result),
            },
          })
        );
      });

    currentWs.send(JSON.stringify({ type: 'response.create' }));
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
