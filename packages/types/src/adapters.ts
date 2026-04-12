import type { ToolDefinition } from './tools.js';

// ─── Base ──────────────────────────────────────────────────────

export interface Disposable {
  close(): void | Promise<void>;
}

// ─── Text (chat completions) ───────────────────────────────────

export interface TextAdapter extends Disposable {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>;
  chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<ChatToolResponse>;
  /** Streaming tool calls — yields text chunks and tool call deltas for pipeline voice */
  chatWithToolsStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatToolStreamChunk>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCallId?: string;
  name?: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType?: string };

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Request JSON output */
  json?: boolean;
  /** Enforce structured output with a JSON schema (provider support varies) */
  responseSchema?: Record<string, unknown>;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatStreamChunk {
  delta: string;
  done: boolean;
}

export interface ChatToolResponse {
  content: string | null;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatToolStreamChunk {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done';
  /** Text content delta (when type is 'text_delta') */
  delta?: string;
  /** Tool call info (when type is 'tool_call_*') */
  toolCall?: { id: string; name?: string; argsDelta?: string };
}

// ─── Embedding ─────────────────────────────────────────────────

export interface EmbeddingAdapter extends Disposable {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
}

// ─── STT (speech-to-text) ──────────────────────────────────────

export type AudioFormat = 'pcm16' | 'mp3' | 'opus' | 'wav' | 'webm';

export interface STTAdapter extends Disposable {
  /** One-shot transcription */
  transcribe(audio: Buffer, format?: AudioFormat): Promise<string>;
  /** Streaming transcription — returns a controllable stream */
  createStream(format?: AudioFormat): STTStream;
}

export interface STTStream {
  /** Push audio data into the stream */
  write(audio: Buffer): void;
  /** Signal end of audio input */
  end(): void;
  /** Abort the stream immediately (for interruption) */
  abort(): void;
  /** Error event */
  on(event: 'error', handler: (err: Error) => void): void;
  /** Async iteration of partial results */
  [Symbol.asyncIterator](): AsyncIterator<STTPartialResult>;
}

export interface STTPartialResult {
  text: string;
  isFinal: boolean;
}

// ─── TTS (text-to-speech) ──────────────────────────────────────

export interface TTSAdapter extends Disposable {
  /** One-shot synthesis */
  synthesize(text: string): Promise<Buffer>;
  /** Streaming synthesis — returns a controllable stream */
  createStream(text: string, options?: TTSStreamOptions): TTSStream;
  /** Audio format metadata */
  outputFormat(): AudioOutputFormat;
}

export interface TTSStreamOptions {
  /** AbortSignal for cancellation (user interrupts) */
  signal?: AbortSignal;
}

export interface TTSStream {
  /** Abort synthesis immediately (for interruption) */
  abort(): void;
  /** Error event */
  on(event: 'error', handler: (err: Error) => void): void;
  /** Async iteration of audio chunks */
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

export interface AudioOutputFormat {
  sampleRate: number;
  channels: number;
  encoding: 'pcm16' | 'mp3' | 'opus';
}

// ─── Vision (split interfaces) ─────────────────────────────────

/** Base vision interface — all vision adapters implement this */
export interface BaseVisionAdapter extends Disposable {
  query(prompt: string, frame: string): Promise<string>;
}

/** Streaming vision — maintains persistent connection, receives continuous frames */
export interface StreamingVisionAdapter extends BaseVisionAdapter {
  connect(): Promise<void>;
  sendFrame(base64Jpeg: string): void;
  isConnected(): boolean;
}

/** Snapshot vision — stateless, sends frame with each query.
 * Identical to BaseVisionAdapter — exists for type discrimination. */
export type SnapshotVisionAdapter = BaseVisionAdapter;

/** Union type for factory return */
export type VisionAdapter = StreamingVisionAdapter | SnapshotVisionAdapter;

/** Type guard */
export function isStreamingVision(v: VisionAdapter): v is StreamingVisionAdapter {
  return 'connect' in v && typeof v.connect === 'function';
}

// ─── Voice ─────────────────────────────────────────────────────

/**
 * Interface for injecting speech into an active voice session.
 * Used by VoiceFanoutBridge for worker output and ClarificationBridge
 * for worker questions. Both realtime and pipeline providers implement this.
 */
export interface VoiceInterjector {
  /**
   * In realtime mode: creates a conversation.item, optionally cancels
   * in-flight response (immediate), and triggers response.create.
   * In pipeline mode: queues text through TTS adapter -> audio to client.
   * If immediate, cancels any in-flight TTS playback first.
   *
   * Returns after the message is queued (before audio playback completes).
   * Never throws — logs and resolves on failure (fire-and-forget contract).
   */
  interject(
    message: string,
    options: { immediate: boolean; bypassRateLimit?: boolean }
  ): Promise<void>;
}

// ─── Route Descriptors ─────────────────────────────────────────

export interface RouteDescriptor {
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface VoiceRouteDescriptor {
  mode: 'realtime' | 'pipeline';
  /** For realtime mode */
  realtime?: RouteDescriptor & { voice?: string };
  /** For pipeline mode */
  pipeline?: {
    stt: RouteDescriptor;
    llm: RouteDescriptor;
    tts: RouteDescriptor & { voice?: string };
  };
}

export interface VisionRouteDescriptor {
  mode: 'streaming' | 'snapshot';
  route: RouteDescriptor;
}

// ─── Pricing ───────────────────────────────────────────────────

export interface AdapterPricing {
  /** Text/embedding: cost per 1K tokens */
  inputPer1kTokens?: number;
  outputPer1kTokens?: number;
  /** Voice/STT: cost per minute of audio */
  perMinuteAudio?: number;
  /** TTS: cost per 1K characters */
  per1kCharacters?: number;
}
