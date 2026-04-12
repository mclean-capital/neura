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
  type ToolCallContext,
} from '../tools/index.js';

const log = new Logger('pipeline-voice');

const MAX_TRANSCRIPT_HISTORY = 40;
const MIN_INTERJECT_INTERVAL_MS = 10_000;

export interface PipelineVoiceConfig {
  systemPromptPrefix?: string;
  memoryTools?: MemoryToolHandler;
  enterMode?: EnterModeHandler;
  taskTools?: TaskToolHandler;
  skillTools?: SkillToolHandler;
  workerControl?: WorkerControlHandler;
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
  private transcriptHistory: { role: 'user' | 'assistant'; text: string }[] = [];
  private systemEvents: string[] = [];
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
    };
  }

  // ─── VoiceProvider interface ─────────────────────────────────

  connect(): void {
    if (this.connected) return;
    this.connected = true;

    // Create STT stream and start processing loop
    this.sttStream = this.sttAdapter.createStream('pcm16');
    this.sttStream.on('error', (err) => {
      log.warn('STT stream error', { err: err.message });
      this.cb.onError(`STT error: ${err.message}`);
    });

    // Start the async STT processing loop
    void this.runSTTLoop();

    // Ready immediately — no async handshake needed
    this.cb.onReady();
  }

  sendAudio(base64: string): void {
    if (!this.connected || this.closed || !this.sttStream) return;
    const buffer = Buffer.from(base64, 'base64');
    this.sttStream.write(buffer);
  }

  sendText(text: string): void {
    if (!this.connected || this.closed) return;
    // Inject as user message, skip STT, go directly to LLM
    void this.processUserUtterance(text);
  }

  sendSystemEvent(text: string): void {
    this.systemEvents.push(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;

    // Abort any in-flight turn
    this.currentTurnAbort?.abort();
    this.currentTurnAbort = null;

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

    // Synthesize and send the interjection
    try {
      const stream = this.ttsAdapter.createStream(`[Neura: ${message}]`);
      for await (const chunk of stream) {
        if (this.closed) break;
        this.cb.onAudio(chunk.toString('base64'));
      }
    } catch (err) {
      log.warn('interject TTS failed', { err: String(err) });
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

        if (partial.text) {
          // Fire interim transcript for client display
          this.cb.onInputTranscript(partial.text);
        }

        if (partial.isFinal && partial.text) {
          accumulatedText += (accumulatedText ? ' ' : '') + partial.text;
        }

        // On utterance end (final + empty text = Deepgram endpoint),
        // process the accumulated utterance
        if (partial.isFinal && !partial.text && accumulatedText) {
          const utterance = accumulatedText.trim();
          accumulatedText = '';
          if (utterance) {
            await this.processUserUtterance(utterance);
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        log.warn('STT loop error', { err: String(err) });
        this.cb.onError(`STT loop error: ${String(err)}`);
      }
    } finally {
      this.sttLoopRunning = false;
    }
  }

  // ─── Internal: Process a complete user utterance ─────────────

  private async processUserUtterance(text: string): Promise<void> {
    // Interrupt any in-flight response
    if (this.currentTurnAbort) {
      this.currentTurnAbort.abort();
      this.cb.onInterrupted();
    }

    this.currentTurnAbort = new AbortController();
    const signal = this.currentTurnAbort.signal;

    // Record user turn
    this.pushTranscript('user', text);

    try {
      // Build messages for the LLM
      const messages = this.buildMessages(text);

      // Stream LLM response with tool calling
      const fullResponse = await this.streamLLMResponse(messages, signal);

      if (fullResponse && !signal.aborted) {
        this.pushTranscript('assistant', fullResponse);
        this.cb.onOutputTranscriptComplete(fullResponse);
        this.cb.onTurnComplete();
      }
    } catch (err) {
      if (!signal.aborted) {
        log.warn('turn processing failed', { err: String(err) });
        this.cb.onError(`Processing error: ${String(err)}`);
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
    const ttsPromises: Promise<void>[] = [];

    // Accumulate tool call state
    const toolCalls = new Map<string, { name: string; args: string }>();

    const stream = this.textAdapter.chatWithToolsStream(messages, this.toolDefs, { signal });

    for await (const chunk of stream) {
      if (signal.aborted) break;

      switch (chunk.type) {
        case 'text_delta': {
          const delta = chunk.delta ?? '';
          fullResponse += delta;
          sentenceBuffer += delta;
          this.cb.onOutputTranscript(delta);

          // Check for sentence boundary
          const sentenceEnd = findSentenceEnd(sentenceBuffer);
          if (sentenceEnd > 0) {
            const sentence = sentenceBuffer.slice(0, sentenceEnd).trim();
            sentenceBuffer = sentenceBuffer.slice(sentenceEnd);
            if (sentence) {
              ttsPromises.push(this.synthesizeAndSend(sentence, signal));
            }
          }
          break;
        }

        case 'tool_call_start': {
          const tc = chunk.toolCall;
          if (tc?.id) {
            toolCalls.set(tc.id, { name: tc.name ?? '', args: '' });
          }
          break;
        }

        case 'tool_call_delta': {
          const tc = chunk.toolCall;
          if (tc?.id) {
            const existing = toolCalls.get(tc.id);
            if (existing && tc.argsDelta) {
              existing.args += tc.argsDelta;
            }
          }
          break;
        }

        case 'tool_call_end': {
          const tc = chunk.toolCall;
          if (tc?.id) {
            const call = toolCalls.get(tc.id);
            if (call) {
              toolCalls.delete(tc.id);
              // Execute tool and continue conversation
              const toolResult = await this.executeTool(call.name, call.args);

              // Add tool call + result to messages and recurse
              messages.push({
                role: 'assistant',
                content: fullResponse || '',
              });
              messages.push({
                role: 'tool',
                content: JSON.stringify(toolResult),
                toolCallId: tc.id,
                name: call.name,
              });

              // Continue with another LLM call (tool result → response)
              const continuation = await this.streamLLMResponse(messages, signal);
              fullResponse += continuation;
              return fullResponse;
            }
          }
          break;
        }

        case 'done':
          break;
      }
    }

    // Flush remaining sentence buffer
    if (sentenceBuffer.trim() && !signal.aborted) {
      ttsPromises.push(this.synthesizeAndSend(sentenceBuffer.trim(), signal));
    }

    // Wait for all TTS to complete
    await Promise.all(ttsPromises);

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

  // ─── Internal: Tool execution ────────────────────────────────

  private async executeTool(name: string, argsJson: string): Promise<Record<string, unknown>> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      args = { _raw: argsJson };
    }

    this.cb.onToolCall(name, args);

    const result = await handleToolCall(name, args, this.toolCtx);

    this.cb.onToolResult(name, result);

    return result;
  }

  // ─── Internal: Message building ──────────────────────────────

  private buildMessages(userText: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System prompt
    const systemParts: string[] = [];
    if (this.config.systemPromptPrefix) {
      systemParts.push(this.config.systemPromptPrefix);
    }
    if (this.systemEvents.length > 0) {
      systemParts.push('Context: ' + this.systemEvents.join('. '));
    }
    systemParts.push(
      'You are a voice assistant. Respond concisely in 1-2 sentences unless the user asks for detail. ' +
        'Do not use markdown formatting — your output will be spoken aloud.'
    );
    messages.push({ role: 'system', content: systemParts.join('\n\n') });

    // Conversation history
    for (const entry of this.transcriptHistory) {
      messages.push({ role: entry.role, content: entry.text });
    }

    // Current user message
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
  // Match sentence-ending punctuation followed by a space or end-of-string
  const match = /[.!?]\s/g.exec(text);
  if (match) {
    return match.index + match[0].length;
  }
  return 0;
}
