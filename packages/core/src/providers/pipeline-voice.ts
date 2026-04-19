/**
 * Pipeline voice provider — STT → LLM → TTS.
 *
 * Chains a Deepgram/Whisper STT adapter, any TextAdapter (via the OpenAI-
 * compatible adapter from Phase 1), and an ElevenLabs/OpenAI TTS adapter
 * into a single VoiceProvider. Implements the same callback contract as
 * GrokVoiceProvider so the WebSocket server layer is provider-agnostic.
 *
 * Key design:
 * - Sentence-level TTS streaming (start TTS before full LLM response)
 * - Sequential TTS output (sentence N finishes before N+1 starts)
 * - Detached utterance processing (STT loop never blocks, enabling interruption)
 * - AbortController propagation for interruption
 * - Deepgram's endpointing handles turn detection
 */

import { Logger } from '@neura/utils/logger';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceInterjector,
  TextAdapter,
  STTAdapter,
  STTStream,
  TTSAdapter,
  ChatMessage,
  ToolDefinition,
} from '@neura/types';
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
  type ToolCallContext,
} from '../tools/index.js';

const log = new Logger('pipeline-voice');

const MAX_TRANSCRIPT_HISTORY = 40;
const MIN_INTERJECT_INTERVAL_MS = 10_000;
/** Flush sentence buffer after this many characters even without punctuation */
const SENTENCE_FLUSH_CHARS = 200;

export interface PipelineVoiceConfig {
  systemPromptPrefix?: string;
  memoryTools?: MemoryToolHandler;
  enterMode?: EnterModeHandler;
  taskTools?: TaskToolHandler;
  skillTools?: SkillToolHandler;
  workerControl?: WorkerControlHandler;
  workerDispatch?: WorkerDispatchHandler;
  systemState?: SystemStateHandler;
}

export class PipelineVoiceProvider implements VoiceProvider, VoiceInterjector {
  private readonly cb: VoiceProviderCallbacks;
  private readonly config: PipelineVoiceConfig;
  private readonly textAdapter: TextAdapter;
  private readonly sttAdapter: STTAdapter;
  private readonly ttsAdapter: TTSAdapter;
  private readonly toolDefs: ToolDefinition[];
  private readonly toolCtx: ToolCallContext;

  private sttStream: STTStream | null = null;
  private currentTurnAbort: AbortController | null = null;
  private interjectionAbort: AbortController | null = null;
  private transcriptHistory: { role: 'user' | 'assistant'; text: string }[] = [];
  private lastSystemEvent: string | null = null;
  private connected = false;
  private closed = false;
  private lastInterjectAt = 0;
  private sttLoopRunning = false;

  constructor(
    cb: VoiceProviderCallbacks,
    config: PipelineVoiceConfig,
    textAdapter: TextAdapter,
    sttAdapter: STTAdapter,
    ttsAdapter: TTSAdapter
  ) {
    this.cb = cb;
    this.config = config;
    this.textAdapter = textAdapter;
    this.sttAdapter = sttAdapter;
    this.ttsAdapter = ttsAdapter;

    this.toolDefs = getToolDefs({
      includeMemory: !!config.memoryTools,
      includePresence: !!config.enterMode,
      includeTasks: !!config.taskTools,
      includeSkills: !!config.skillTools,
      includeWorkerControl: !!config.workerControl,
    });

    this.toolCtx = {
      queryWatcher: cb.queryWatcher,
      memoryTools: config.memoryTools,
      enterMode: config.enterMode,
      taskTools: config.taskTools,
      skillTools: config.skillTools,
      workerControl: config.workerControl,
      workerDispatch: config.workerDispatch,
      systemState: config.systemState,
    };
  }

  // ─── VoiceProvider interface ─────────────────────────────────

  connect(): void {
    if (this.connected) return;
    this.connected = true;

    // Create STT stream — it buffers audio internally until WS is open
    this.sttStream = this.sttAdapter.createStream('pcm16');
    this.sttStream.on('error', (err) => {
      log.warn('STT stream error', { err: err.message });
      this.cb.onError(`STT error: ${err.message}`);
      // Attempt reconnection
      void this.reconnectSTT();
    });

    // Start the async STT processing loop (detached — never blocks)
    void this.runSTTLoop();

    // Fire onReady after a short delay to let Deepgram WS connect.
    // The server replays buffered audio in onReady(), and we need the
    // STT WebSocket to be OPEN before that audio arrives.
    setTimeout(() => {
      if (!this.closed) this.cb.onReady();
    }, 500);
  }

  sendAudio(base64: string): void {
    if (!this.connected || this.closed || !this.sttStream) return;
    const buffer = Buffer.from(base64, 'base64');
    this.sttStream.write(buffer);
  }

  sendText(text: string): void {
    if (!this.connected || this.closed) return;
    // Inject as user message, skip STT, go directly to LLM
    this.startNewTurn(text);
  }

  sendSystemEvent(text: string): void {
    // Replace (not accumulate) — keeps context fresh
    this.lastSystemEvent = text;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;

    // Abort any in-flight work
    this.currentTurnAbort?.abort();
    this.currentTurnAbort = null;
    this.interjectionAbort?.abort();
    this.interjectionAbort = null;

    // Close STT stream
    this.sttStream?.abort();
    this.sttStream = null;

    this.cb.onClose();
  }

  // ─── VoiceInterjector interface ──────────────────────────────

  async interject(
    message: string,
    options: { immediate: boolean; bypassRateLimit?: boolean }
  ): Promise<void> {
    if (this.closed || !this.connected) {
      log.warn('interject called while closed', { preview: message.slice(0, 80) });
      return;
    }

    const now = Date.now();
    if (!options.bypassRateLimit && now - this.lastInterjectAt < MIN_INTERJECT_INTERVAL_MS) {
      log.info('interject rate-limited', { preview: message.slice(0, 80) });
      return;
    }
    this.lastInterjectAt = now;

    if (options.immediate) {
      // Cancel current turn
      this.currentTurnAbort?.abort();
      this.currentTurnAbort = null;
      this.cb.onInterrupted();
    }

    // Cancel any previous interjection
    this.interjectionAbort?.abort();
    this.interjectionAbort = new AbortController();
    const signal = this.interjectionAbort.signal;

    // Fire-and-forget TTS synthesis (matches Grok contract — resolves after queue, not playback)
    if (!options.immediate) {
      // Non-immediate: queue for after current turn finishes
      // For now, synthesize immediately but don't interrupt current audio
    }

    try {
      const stream = this.ttsAdapter.createStream(message, { signal });
      for await (const chunk of stream) {
        if (this.closed || signal.aborted) break;
        this.cb.onAudio(chunk.toString('base64'));
      }
    } catch (err) {
      if (!signal.aborted) {
        log.warn('interject TTS failed', { err: String(err) });
      }
    }
  }

  // ─── Internal: STT processing loop ──────────────────────────

  private async runSTTLoop(): Promise<void> {
    if (this.sttLoopRunning || !this.sttStream) return;
    this.sttLoopRunning = true;

    let accumulatedText = '';

    try {
      for await (const partial of this.sttStream) {
        if (this.closed) break;

        if (partial.text && !partial.isFinal) {
          // Interim result — send to client for display only.
          // Do NOT persist or use for clarification (avoids duplicate transcripts).
          this.cb.onInputTranscript(partial.text);
        }

        if (partial.isFinal && partial.text) {
          accumulatedText += (accumulatedText ? ' ' : '') + partial.text;
          // Send final transcript segment to client
          this.cb.onInputTranscript(accumulatedText);
        }

        // On utterance end (final + empty text = Deepgram endpoint),
        // process the accumulated utterance
        if (partial.isFinal && !partial.text && accumulatedText) {
          const utterance = accumulatedText.trim();
          accumulatedText = '';
          if (utterance) {
            // DETACHED — does not block the STT loop.
            // This allows the loop to detect interruptions (new speech)
            // while the current turn is being processed.
            this.startNewTurn(utterance);
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        log.warn('STT loop error', { err: String(err) });
        this.cb.onError(`STT loop error: ${String(err)}`);
        void this.reconnectSTT();
      }
    } finally {
      this.sttLoopRunning = false;
    }
  }

  // ─── Internal: STT reconnection ──────────────────────────────

  private reconnectSTT(): void {
    if (this.closed) return;
    log.info('attempting STT reconnection');
    try {
      this.sttStream?.abort();
      this.sttStream = this.sttAdapter.createStream('pcm16');
      this.sttStream.on('error', (err) => {
        log.warn('STT stream error after reconnect', { err: err.message });
        this.cb.onError(`STT error: ${err.message}`);
      });
      void this.runSTTLoop();
      this.cb.onReconnected();
    } catch (err) {
      log.warn('STT reconnection failed', { err: String(err) });
      this.cb.onError('STT reconnection failed');
    }
  }

  // ─── Internal: Start a new turn (detached) ──────────────────

  private startNewTurn(text: string): void {
    // Abort any in-flight turn
    if (this.currentTurnAbort) {
      this.currentTurnAbort.abort();
      this.cb.onInterrupted();
    }

    this.currentTurnAbort = new AbortController();
    const signal = this.currentTurnAbort.signal;

    // Fire-and-forget — does NOT block the STT loop
    void this.processUserUtterance(text, signal).catch((err) => {
      if (!signal.aborted) {
        log.warn('turn processing failed', { err: String(err) });
        this.cb.onError(`Processing error: ${String(err)}`);
      }
    });
  }

  // ─── Internal: Process a complete user utterance ─────────────

  private async processUserUtterance(text: string, signal: AbortSignal): Promise<void> {
    try {
      // Build messages for the LLM (includes history + current user text)
      const messages = this.buildMessages(text);

      // Stream LLM response with tool calling
      const fullResponse = await this.streamLLMResponse(messages, signal);

      if (fullResponse && !signal.aborted) {
        // Record both sides in transcript history AFTER the turn completes
        this.pushTranscript('user', text);
        this.pushTranscript('assistant', fullResponse);
        this.cb.onOutputTranscriptComplete(fullResponse);
        this.cb.onTurnComplete();
      }
    } finally {
      if (this.currentTurnAbort?.signal === signal) {
        this.currentTurnAbort = null;
      }
    }
  }

  // ─── Internal: Stream LLM response with sentence-level TTS ──

  private async streamLLMResponse(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    let fullResponse = '';
    let sentenceBuffer = '';

    // TTS output queue — sequential, not parallel
    let ttsChain = Promise.resolve();

    // Accumulate ALL tool calls in the current response before dispatching
    const pendingToolCalls = new Map<string, { name: string; args: string }>();

    const stream = this.textAdapter.chatWithToolsStream(messages, this.toolDefs, { signal });

    for await (const chunk of stream) {
      if (signal.aborted) break;

      switch (chunk.type) {
        case 'text_delta': {
          const delta = chunk.delta ?? '';
          fullResponse += delta;
          sentenceBuffer += delta;
          this.cb.onOutputTranscript(delta);

          // Check for sentence boundary OR character-count flush
          const sentenceEnd = findSentenceEnd(sentenceBuffer);
          const shouldFlush = sentenceEnd > 0 || sentenceBuffer.length >= SENTENCE_FLUSH_CHARS;

          if (shouldFlush) {
            const splitAt = sentenceEnd > 0 ? sentenceEnd : sentenceBuffer.length;
            const sentence = sentenceBuffer.slice(0, splitAt).trim();
            sentenceBuffer = sentenceBuffer.slice(splitAt);
            if (sentence) {
              // Chain sequentially — sentence N finishes before N+1 starts
              ttsChain = ttsChain.then(() => this.synthesizeAndSend(sentence, signal));
            }
          }
          break;
        }

        case 'tool_call_start': {
          const tc = chunk.toolCall;
          if (tc?.id) {
            pendingToolCalls.set(tc.id, { name: tc.name ?? '', args: '' });
          }
          break;
        }

        case 'tool_call_delta': {
          const tc = chunk.toolCall;
          if (tc?.id) {
            const existing = pendingToolCalls.get(tc.id);
            if (existing && tc.argsDelta) {
              existing.args += tc.argsDelta;
            }
          }
          break;
        }

        case 'tool_call_end': {
          // Don't dispatch yet — wait for 'done' to collect all tool calls
          break;
        }

        case 'done': {
          // If there are pending tool calls, dispatch them all
          if (pendingToolCalls.size > 0) {
            // Flush any buffered text before tool calls
            if (sentenceBuffer.trim()) {
              const sentence = sentenceBuffer.trim();
              sentenceBuffer = '';
              ttsChain = ttsChain.then(() => this.synthesizeAndSend(sentence, signal));
            }
            await ttsChain;

            // Build the assistant message with tool_calls structure
            const toolCallsArray = [...pendingToolCalls.entries()].map(([id, call]) => ({
              id,
              name: call.name,
              args: safeParseArgs(call.args),
            }));

            messages.push({
              role: 'assistant',
              content: fullResponse || '',
            });

            // Execute all tool calls and add results
            for (const tc of toolCallsArray) {
              this.cb.onToolCall(tc.name, tc.args);
              const result = await handleToolCall(tc.name, tc.args, this.toolCtx);
              this.cb.onToolResult(tc.name, result);

              messages.push({
                role: 'tool',
                content: JSON.stringify(result),
                toolCallId: tc.id,
                name: tc.name,
              });
            }

            pendingToolCalls.clear();

            // Continue with another LLM call (tool results → response)
            if (!signal.aborted) {
              const continuation = await this.streamLLMResponse(messages, signal);
              return fullResponse + continuation;
            }
          }
          break;
        }
      }
    }

    // Flush remaining sentence buffer
    if (sentenceBuffer.trim() && !signal.aborted) {
      ttsChain = ttsChain.then(() => this.synthesizeAndSend(sentenceBuffer.trim(), signal));
    }

    // Wait for all TTS to complete (sequential chain)
    await ttsChain;

    return fullResponse;
  }

  // ─── Internal: TTS synthesis ─────────────────────────────────

  private async synthesizeAndSend(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closed) return;

    try {
      const stream = this.ttsAdapter.createStream(text, { signal });
      for await (const chunk of stream) {
        if (signal.aborted || this.closed) break;
        this.cb.onAudio(chunk.toString('base64'));
      }
    } catch (err) {
      if (!signal.aborted) {
        log.warn('TTS synthesis failed', { err: String(err), text: text.slice(0, 40) });
      }
    }
  }

  // ─── Internal: Message building ──────────────────────────────

  private buildMessages(userText: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System prompt
    const systemParts: string[] = [];
    if (this.config.systemPromptPrefix) {
      systemParts.push(this.config.systemPromptPrefix);
    }
    if (this.lastSystemEvent) {
      systemParts.push('Context: ' + this.lastSystemEvent);
    }
    systemParts.push(
      'You are a voice assistant. Respond concisely in 1-2 sentences unless the user asks for detail. ' +
        'Do not use markdown formatting — your output will be spoken aloud.'
    );
    messages.push({ role: 'system', content: systemParts.join('\n\n') });

    // Conversation history (does NOT include current turn — added separately)
    for (const entry of this.transcriptHistory) {
      messages.push({ role: entry.role, content: entry.text });
    }

    // Current user message (NOT in history yet — pushed after turn completes)
    messages.push({ role: 'user', content: userText });

    return messages;
  }

  // ─── Internal: Transcript tracking ───────────────────────────

  private pushTranscript(role: 'user' | 'assistant', text: string): void {
    this.transcriptHistory.push({ role, text });
    if (this.transcriptHistory.length > MAX_TRANSCRIPT_HISTORY) {
      this.transcriptHistory.shift();
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Find the end of a sentence in a text buffer.
 * Returns the index after the sentence-ending punctuation, or 0 if no
 * complete sentence is found.
 */
function findSentenceEnd(text: string): number {
  const match = /[.!?]\s/g.exec(text);
  if (match) {
    return match.index + match[0].length;
  }
  return 0;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}
