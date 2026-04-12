# Model-Agnostic Refactor Plan

> **Version**: 3.0.0 (breaking change, no migration path)
> **Date**: 2026-04-12
> **Status**: Draft v4 — revised after review rounds 1, 2, & Codex round 2
> **Review round 1**: Codex (GPT-5.4) + NeuVybe Tech Lead subagent — 2026-04-12
> **Review round 2a**: NeuVybe Tech Lead subagent — 2026-04-12 (all 10 findings PASS, 2 new issues identified)
> **Review round 2b**: Codex (GPT-5.4) — 2026-04-12 (8 original PASS, additions A & B FAIL — now fixed in v4)

## Motivation

Neura is currently hardcoded to two providers: **xAI (Grok)** for voice orchestration and **Google (Gemini)** for vision, memory extraction, reranking, embeddings, and discovery. This creates vendor lock-in, limits user choice, and makes the onboarding story awkward (users must obtain keys from two specific providers).

This refactor introduces a **provider-agnostic adapter layer** so users can mix and match models from any supported provider — or use a single gateway like OpenRouter to access everything with one API key.

## Design Principles

1. **Gateway-first for text/embedding/snapshot-vision** — OpenRouter / Vercel AI Gateway / LiteLLM as first-class citizens for chat completions, embeddings, and snapshot vision queries. One API key = access to 200+ models. Realtime voice, streaming vision, STT, and TTS use direct provider APIs (gateways don't proxy these).
2. **Config-driven routing** — Config maps capabilities (voice, vision, text, embedding, STT, TTS) to `{ provider, model }` pairs. No provider-level capability booleans — the routing config is the source of truth, validated at startup.
3. **Pipeline voice as first-class** — Support STT → LLM → TTS pipeline alongside native realtime audio. More providers, cheaper, more control. Documented latency trade-offs vs realtime mode.
4. **Streaming + snapshot vision** — Separate interfaces for continuous frame streaming (Gemini Live) and on-demand snapshot queries (any vision-capable LLM). No no-op methods.
5. **pi-ai stays for workers** — Keep `@mariozechner/pi-coding-agent` exclusively for the worker runtime. Build Neura's own registry for everything else. Spike pi-ai provider compatibility early.
6. **Breaking change** — Major version bump. No migration path from v2 config. v2 config detected at startup → clear error message with upgrade instructions.

## Current Hardcoded Coupling Points

| Capability             | Current Provider              | Hardcoded Location                                          |
| ---------------------- | ----------------------------- | ----------------------------------------------------------- |
| Voice orchestration    | Grok (xAI Realtime WS)        | `providers/grok-voice.ts`, `providers/voice-session.ts`     |
| Vision (camera/screen) | Gemini Live API               | `providers/gemini-vision.ts`, `providers/vision-watcher.ts` |
| Memory extraction      | Gemini 2.5 Flash              | `memory/extraction-pipeline.ts:7`                           |
| Memory reranking       | Gemini 2.5 Flash              | `memory/reranker.ts:7`                                      |
| Embeddings             | Gemini Embedding 2 (3072 dim) | `memory/extraction-pipeline.ts:8`                           |
| Discovery loop         | Gemini 2.5 Flash              | `discovery/discovery-loop.ts:104`                           |
| Worker runtime         | xAI grok-4-fast (via pi-ai)   | `server/lifecycle.ts:389`                                   |
| Cost tracking          | Fixed rates per provider      | `grok-voice.ts:26`, `gemini-vision.ts:14`                   |
| Config / API keys      | Only xAI + Google             | `config/config.ts`, desktop setup wizard                    |

## Architecture

### Provider Registry

Central registry in `@neura/core` that resolves **route descriptors** and provides **adapter factories**. The registry does NOT store live adapter instances — stateful adapters (voice, vision, STT, TTS) are session-scoped and created per-client via factories.

```
ProviderRegistry
├── route resolution:
│   ├── resolveText()       → RouteDescriptor { providerId, model, apiKey, baseUrl? }
│   ├── resolveEmbedding()  → RouteDescriptor
│   ├── resolveVision()     → VisionRouteDescriptor (includes mode: streaming | snapshot)
│   ├── resolveVoice()      → VoiceRouteDescriptor (includes mode: realtime | pipeline)
│   ├── resolveSTT()        → RouteDescriptor (only for pipeline voice mode)
│   └── resolveTTS()        → RouteDescriptor (only for pipeline voice mode)
├── singleton adapters (stateless, shared):
│   ├── text      → OpenAICompatibleTextAdapter (covers OpenAI, OpenRouter, Vercel AI Gateway, xAI, Google)
│   └── embedding → OpenAICompatibleEmbeddingAdapter
├── adapter factories (stateful, per-session):
│   ├── createVoiceAdapter(callbacks, config)  → VoiceProvider
│   ├── createVisionAdapter(label)             → StreamingVisionAdapter | SnapshotVisionAdapter
│   ├── createSTTStream(format)                → STTStream
│   └── createTTSStream()                      → TTSStream
└── provider credentials:
    └── Map<providerId, { apiKey, baseUrl? }>
```

### Gateway Support

Gateways (OpenRouter, Vercel AI Gateway, LiteLLM) expose OpenAI-compatible APIs. Scope: **text, embedding, and snapshot vision only** — gateways don't proxy realtime voice, streaming vision, STT, or TTS.

Implementation:

- Single `OpenAICompatibleTextAdapter` with configurable `baseUrl`
- Provider config: `{ "provider": "openrouter", "model": "anthropic/claude-sonnet-4-6" }`
- Gateway-specific auth headers handled in adapter
- Note: Vercel AI Gateway is the proxy product, not the Vercel AI SDK (which is a client-side library)

### Config Schema (v3)

```jsonc
// ~/.neura/config.json
{
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "xai": { "apiKey": "xai-..." },
    "google": { "apiKey": "AIza..." },
    "openai": { "apiKey": "sk-..." },
    "anthropic": { "apiKey": "sk-ant-..." },
    "elevenlabs": { "apiKey": "..." },
    "deepgram": { "apiKey": "..." },
    "cartesia": { "apiKey": "..." },
  },
  "routing": {
    "voice": {
      "mode": "realtime",
      "provider": "openai",
      "model": "gpt-4o-realtime",
      "voice": "alloy",
    },
    // --- OR for pipeline mode ---
    // "voice": {
    //   "mode": "pipeline",
    //   "stt": { "provider": "deepgram", "model": "nova-3" },
    //   "llm": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4-6" },
    //   "tts": { "provider": "elevenlabs", "model": "eleven_turbo_v2", "voice": "rachel" }
    // },
    "vision": {
      "mode": "streaming",
      "provider": "google",
      "model": "gemini-2.5-flash",
    },
    // --- OR for snapshot mode ---
    // "vision": {
    //   "mode": "snapshot",
    //   "provider": "openrouter",
    //   "model": "openai/gpt-4o"
    // },
    "text": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4-6" },
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
    },
    "worker": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4-6" },
  },
  "assistantName": "Neura",
  "wakeWord": "jarvis",
  "port": 0,
}
```

**Validation (Zod at startup):**

- Discriminated union on `routing.voice.mode` — `"pipeline"` requires `stt`, `llm`, `tts` sub-objects
- Discriminated union on `routing.vision.mode` — `"streaming"` vs `"snapshot"`
- Every `routing.*.provider` must have a matching key in `providers` map — fail fast at startup, not at first API call
- `routing.embedding.dimensions` is required — stored in pgvector metadata table for mismatch detection
- v2 config detection: if `apiKeys.xai` or `apiKeys.google` exists at top level → clear error with upgrade instructions

**Environment variable overrides (for Docker/CI):**

```bash
# Provider API keys: NEURA_PROVIDER_{ID}_API_KEY
NEURA_PROVIDER_OPENROUTER_API_KEY=sk-or-...
NEURA_PROVIDER_OPENAI_API_KEY=sk-...
NEURA_PROVIDER_DEEPGRAM_API_KEY=...

# Routing overrides: NEURA_ROUTING_{CAPABILITY}_{FIELD}
NEURA_ROUTING_TEXT_PROVIDER=openrouter
NEURA_ROUTING_TEXT_MODEL=anthropic/claude-sonnet-4-6
NEURA_ROUTING_VOICE_MODE=pipeline
```

### Adapter Interfaces

All interfaces live in `@neura/types/adapters.ts`. Every adapter has a `close()` method for lifecycle cleanup.

```typescript
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

/** Snapshot vision — stateless, sends frame with each query */
export interface SnapshotVisionAdapter extends BaseVisionAdapter {
  // query() inherited from base — frame is required
}

/** Union type for factory return */
export type VisionAdapter = StreamingVisionAdapter | SnapshotVisionAdapter;

/** Type guard */
export function isStreamingVision(v: VisionAdapter): v is StreamingVisionAdapter {
  return 'connect' in v && typeof v.connect === 'function';
}

// ─── Voice ─────────────────────────────────────────────────────
// VoiceProvider base interface remains as-is from providers.ts.
// New: VoiceInterjector interface for worker fanout integration.
// Both realtime and pipeline providers must implement this so workers
// can inject speech into the active voice session.

export interface VoiceInterjector {
  /**
   * Inject text into the active voice session (used by VoiceFanoutBridge
   * for worker output and ClarificationBridge for worker questions).
   *
   * In realtime mode: creates a conversation.item, optionally cancels
   * in-flight response (immediate), and triggers response.create.
   * In pipeline mode: queues text through TTS adapter → audio to client.
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

// This matches the existing contract in voice-fanout-bridge.ts (VoiceInterjector)
// and grok-voice.ts (GrokVoiceProvider.interject). The bridge and clarification
// bridge already depend on { immediate, bypassRateLimit? } + Promise<void>.

// VoiceProvider implementations (XaiRealtimeAdapter, OpenAIRealtimeAdapter,
// PipelineVoiceProvider) all implement both VoiceProvider & VoiceInterjector.
// The websocket handler can use the VoiceInterjector interface directly
// instead of casting to `unknown`.

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
```

### Pipeline Voice Architecture

The `PipelineVoiceProvider` implements `VoiceProvider` by orchestrating three adapters with **sentence-level streaming** to minimize latency:

```
Audio IN → STTAdapter.createStream()
              ↓ (partial transcripts, wait for isFinal)
         TextAdapter.chatWithToolsStream() ← system prompt, memory context, tools
              ↓ (streamed text deltas + tool call deltas)
         [if tool_call_end: dispatch via handleToolCall(), feed result back, continue stream]
              ↓ (sentence boundary detected in text deltas)
         TTSAdapter.createStream(sentence) ← start TTS before full LLM response
              ↓ (audio chunks)
         Audio OUT → client
```

**Latency budget (realistic estimates):**

- STT final transcript after silence: ~200-300ms (Deepgram Nova-3 streaming)
- LLM time to first token: ~300-600ms (varies by provider/model)
- TTS first audio chunk: ~200-300ms (ElevenLabs Turbo / Cartesia streaming)
- **Total first-byte: ~700-1200ms** (no tool calls)
- **With tool calls: +500-1500ms per tool round-trip** (tool exec + LLM continuation + TTS)

**Key design considerations:**

- **Sentence-level streaming**: Detect sentence boundaries in LLM text deltas, start TTS for each sentence immediately — don't wait for full LLM response
- **Interruption**: `AbortController` propagates cancel to all in-flight streams (STT abort, LLM signal, TTS abort) when VAD detects new speech
- **Tool calls**: Streamed tool call deltas accumulate args; on `tool_call_end`, dispatch via existing `handleToolCall()`, send result back to LLM, continue streaming
- **VAD**: Pipeline mode requires a local VAD module (e.g., @ricky0123/vad-node or silero-vad ONNX) since there's no server-side VAD from the realtime provider. Current Grok provider uses server_vad (grok-voice.ts:150).
- **Transcript callbacks**: `onInputTranscript` from STT partials, `onOutputTranscript` from LLM text deltas — same callbacks as realtime mode
- **Documented trade-off**: Pipeline mode is cheaper and supports more LLM providers but has higher latency than native realtime, especially for tool-heavy interactions. Users choose based on their priorities.

### Snapshot Vision Architecture

`SnapshotVisionAdapter` wraps any vision-capable `TextAdapter`:

```
VisionWatcher captures frame → stores latest frame per source (camera | screen)
    ↓ (on query from tool handler)
SnapshotVisionAdapter.query(prompt, latestFrame)
    ↓
TextAdapter.chat([{
  role: 'user',
  content: [
    { type: 'image', data: frame, mimeType: 'image/jpeg' },
    { type: 'text', text: prompt }
  ]
}])
    ↓
Response text
```

No streaming, no persistent connection. Works with any model that accepts images in chat messages. Source (camera vs screen) is managed by the VisionWatcher, not the adapter — one adapter instance per source, same as current architecture.

### Embedding Dimension Management

Current: Gemini Embedding 2 at 3072 dimensions, stored in pgvector `vector(3072)` columns.

**Problem**: Switching embedding providers changes dimensions (OpenAI = 1536, Cohere = 1024, etc.), which is incompatible with existing pgvector data.

**Affected tables** (all have `embedding vector(3072)` columns per `migrations.ts`):

- `facts.embedding` (line 69)
- `transcripts.embedding` (line 196)
- `transcript_chunks.embedding` (line 246)

All three must be migrated when dimensions change.

**Solution (crash-safe temp-column approach with fine-grained state machine):**

1. Store active embedding dimensions + migration state in a `_meta` table:
   - `{ key: 'embedding_dimensions', value: '3072' }`
   - `{ key: 'embedding_migration_state', value: '<state>' }`
   - `{ key: 'embedding_migration_table', value: '<current table being migrated>' }`

2. State machine (each state is idempotent — safe to re-enter on crash):

   ```
   idle
     → backfill:<table>     (for each table: facts, transcripts, transcript_chunks)
     → swap:<table>         (for each table)
     → done
     → idle
   ```

3. On startup, compare `config.routing.embedding.dimensions` against `_meta.embedding_dimensions`

4. If mismatch detected OR state is NOT `idle` (crash recovery — resume from last state):

   **For each table** (facts, transcripts, transcript_chunks) in sequence:

   **State: `backfill:<table>`**
   - `ALTER TABLE <table> ADD COLUMN IF NOT EXISTS embedding_new vector(N)` (idempotent via IF NOT EXISTS)
   - Backfill in batches: read rows, call `EmbeddingAdapter.embed()`, write to `embedding_new` (skip rows where `embedding_new IS NOT NULL` — idempotent)
   - Set state to `swap:<table>`

   **State: `swap:<table>`**
   - All swap operations in a single transaction:
     ```sql
     BEGIN;
     ALTER TABLE <table> DROP COLUMN IF EXISTS embedding;
     ALTER TABLE <table> RENAME COLUMN embedding_new TO embedding;
     -- Index rebuild (DROP IF EXISTS + CREATE)
     DROP INDEX IF EXISTS idx_<table>_embedding;
     CREATE INDEX idx_<table>_embedding ON <table> USING ivfflat (embedding vector_cosine_ops);
     COMMIT;
     ```
   - `IF EXISTS` / `IF NOT EXISTS` guards make this idempotent on re-entry
   - Set state to `backfill:<next_table>` or `done` if last table

   **State: `done`**
   - Update `_meta.embedding_dimensions` to new value
   - Set state to `idle`

5. `dimensions` is required in embedding config to make this explicit — no silent surprises
6. OpenAI's `text-embedding-3-*` models support a `dimensions` parameter for truncation, which we pass through
7. During migration, vector search is degraded (returns empty results for in-progress tables). Log a warning on each query attempt during migration.

### Worker Runtime Changes

Current: hardcoded `getModel('xai', 'grok-4-fast')` in `lifecycle.ts:389`.

New:

1. Read `config.routing.worker` → `{ provider, model }`
2. Populate pi-ai's `AuthStorage` from `config.providers[provider].apiKey`
3. Call `getModel(provider, model)` with user's chosen provider/model
4. pi-ai handles the rest (agent sessions, tool dispatch, persistence)

**Required spike (Phase 1)**: Verify which providers pi-ai's `getModel()` actually supports. If it only supports a fixed set (xai, openai, anthropic, google), document this constraint. If pi-ai doesn't support a user's chosen provider, fail fast at startup with a clear message listing supported worker providers.

## Implementation Phases

### Phase 1 — Foundation + Config + Minimal CLI

**Goal**: Core abstractions, config schema, first adapters, config tooling, v2 detection. Everything needed so a user can configure and run Neura with the new schema.

Files to create:

- `packages/types/src/adapters.ts` — All adapter interfaces above
- `packages/types/src/config.ts` — Rewrite config interfaces (breaking), Zod schema
- `packages/core/src/registry/provider-registry.ts` — Central registry class (route resolution + adapter factories)
- `packages/core/src/registry/index.ts` — Barrel export
- `packages/core/src/adapters/openai-compatible-text.ts` — Text adapter (covers OpenAI, OpenRouter, Vercel AI Gateway, xAI, Google)
- `packages/core/src/adapters/openai-compatible-embedding.ts` — Embedding adapter
- `packages/core/src/adapters/index.ts` — Barrel export

Files to modify:

- `packages/core/src/config/config.ts` — New config loading logic, Zod validation, v2 detection, env var overrides
- `packages/core/src/server/lifecycle.ts` — Wire registry into server startup
- `packages/cli/src/config.ts` — New config schema support (read/write v3 format)
- `packages/cli/src/commands/config.ts` — `neura config set providers.openrouter.apiKey <key>`, `neura config set routing.text.provider openrouter`, etc.
- `packages/desktop/src/renderer/wizard/SetupWizard.tsx` — Minimal update: accept new provider key structure (full multi-provider UX in Phase 6)

Spike tasks (resolve before locking interfaces):

- [ ] Verify pi-ai `getModel()` supported providers — document constraints for worker routing
- [ ] Verify Anthropic OpenAI-compatible endpoint availability and tool calling support
- [ ] Test OpenRouter streaming tool call behavior across top 5 models

Test migration:

- Update all existing tests that reference `xaiApiKey`, `googleApiKey`, `loadConfig()` to use v3 schema
- Add config validation tests: valid v3, invalid v3, v2 detection error

Estimated scope: ~1000-1500 lines new code, ~400 lines modified.

### Phase 2 — Decouple Internal Models

**Goal**: Memory, reranking, discovery use adapters instead of hardcoded Gemini.

Files to modify:

- `packages/core/src/memory/extraction-pipeline.ts` — Accept `TextAdapter` + `EmbeddingAdapter` via constructor, remove hardcoded models. Note: currently uses `responseMimeType: 'application/json'` + `responseSchema` — must use `ChatOptions.responseSchema` with adapter.
- `packages/core/src/memory/reranker.ts` — Accept `TextAdapter` via constructor, remove hardcoded model
- `packages/core/src/memory/memory-manager.ts` — Accept adapters in options, pass through to extraction pipeline and reranker
- `packages/core/src/discovery/discovery-loop.ts` — Accept `TextAdapter` via constructor, remove hardcoded model and `GoogleGenAI` import
- `packages/core/src/server/lifecycle.ts` — Resolve text + embedding adapters from registry, inject into memory manager and discovery loop
- `packages/core/src/stores/` — Add `_meta` table for embedding dimensions, dimension mismatch detection, re-embedding job

Estimated scope: ~200 lines new, ~400 lines modified.

### Phase 3 — Pipeline Voice Mode

**Goal**: STT → LLM → TTS pipeline as an alternative to native realtime.

Files to create:

- `packages/core/src/adapters/deepgram-stt.ts` — Deepgram WebSocket streaming STT with abort support
- `packages/core/src/adapters/elevenlabs-tts.ts` — ElevenLabs WebSocket streaming TTS with abort support
- `packages/core/src/adapters/openai-tts.ts` — OpenAI TTS (HTTP streaming) with AbortSignal
- `packages/core/src/adapters/cartesia-tts.ts` — Cartesia WebSocket TTS with abort support
- `packages/core/src/providers/pipeline-voice.ts` — PipelineVoiceProvider: sentence-level streaming, VAD, interruption via AbortController, tool call loop
- `packages/core/src/providers/vad.ts` — Local VAD module for pipeline mode (silero-vad ONNX or @ricky0123/vad-node)

Files to modify:

- `packages/core/src/providers/voice-session.ts` — Factory switches on `config.routing.voice.mode`
- `packages/core/src/server/websocket.ts` — Pass routing config to voice session factory

Estimated scope: ~1800-2500 lines new code, ~150 lines modified.

### Phase 4 — Additional Realtime Adapters

**Goal**: Extract current Grok into adapter shape, add OpenAI Realtime.

Files to modify:

- `packages/core/src/providers/grok-voice.ts` → Refactor into `packages/core/src/adapters/xai-realtime-voice.ts`. Accept config from registry route descriptor instead of reading env vars directly.

Files to create:

- `packages/core/src/adapters/openai-realtime-voice.ts` — OpenAI Realtime API adapter (very similar WebSocket protocol to xAI)

Estimated scope: ~600-800 lines new, ~200 lines modified (mostly extracting/moving code).

### Phase 5 — Vision Adapters

**Goal**: Both streaming (Gemini) and snapshot (any vision LLM) vision.

Files to modify:

- `packages/core/src/providers/gemini-vision.ts` → Refactor into `packages/core/src/adapters/gemini-streaming-vision.ts`. Implement `StreamingVisionAdapter` interface.

Files to create:

- `packages/core/src/adapters/snapshot-vision.ts` — Implements `SnapshotVisionAdapter`, delegates to `TextAdapter` with image content part.

Files to modify:

- `packages/core/src/providers/vision-watcher.ts` — Factory reads `config.routing.vision.mode`, creates appropriate adapter type. Type guard `isStreamingVision()` for frame dispatch.

Estimated scope: ~300-400 lines new, ~200 lines modified.

### Phase 6 — Full Setup Wizard + Cost Tracking + Polish

**Goal**: Rich multi-provider onboarding UX, dynamic pricing, worker config.

Files to modify:

- `packages/core/src/server/lifecycle.ts` — Worker reads `config.routing.worker`, pi-ai AuthStorage bridge
- `packages/core/src/cost/cost-tracker.ts` — Dynamic pricing from `AdapterPricing` metadata (supports per-token, per-minute, per-character pricing models)
- `packages/desktop/src/renderer/wizard/SetupWizard.tsx` — Full multi-provider selection: pick voice mode, pick providers per capability, enter API keys only for selected providers, sensible defaults
- `packages/cli/src/commands/config.ts` — Interactive guided setup: `neura setup` walks through provider selection
- Session recording: `store.createSession()` uses actual provider/model from config, not hardcoded `'grok'`/`'gemini'`

Estimated scope: ~500-800 lines modified across packages.

## Supported Providers at Launch

| Provider          | Text | Embedding | Vision         | STT          | TTS | Voice Realtime |
| ----------------- | ---- | --------- | -------------- | ------------ | --- | -------------- |
| OpenAI            | ✅   | ✅        | ✅ (snapshot)  | ✅ (Whisper) | ✅  | ✅             |
| OpenRouter        | ✅   | ✅        | ✅ (snapshot)  | —            | —   | —              |
| Vercel AI Gateway | ✅   | ✅        | ✅ (snapshot)  | —            | —   | —              |
| xAI               | ✅   | —         | —              | —            | —   | ✅             |
| Google            | ✅   | ✅        | ✅ (streaming) | —            | —   | —              |
| Anthropic         | ✅   | —         | ✅ (snapshot)  | —            | —   | —              |
| Deepgram          | —    | —         | —              | ✅           | —   | —              |
| ElevenLabs        | —    | —         | —              | —            | ✅  | —              |
| Cartesia          | —    | —         | —              | —            | ✅  | —              |

## Testing Strategy

- **Unit tests per adapter**: Mocked HTTP/WS responses, verify request format, error handling, abort behavior
- **Registry tests**: Route resolution, missing provider fail-fast, gateway baseUrl override, factory instantiation
- **Config tests**: Valid v3 schema, invalid v3 (missing provider ref), v2 detection error, env var overrides, Zod validation
- **Pipeline voice integration tests**: Faux STT + TextAdapter + TTS composing through PipelineVoiceProvider, verify transcript callbacks, tool call loop, interruption/abort
- **Embedding migration test**: Dimension mismatch detection, re-embedding job trigger
- **Test migration in Phase 1**: All existing 147 tests updated to v3 config schema — scoped explicitly as Phase 1 work
- **No e2e latency tests in CI** (nondeterministic), but provide a manual benchmark script for pipeline voice timing

## Resolved Questions (from review round 1)

1. **Registry lifecycle**: Registry vends route descriptors + factories, not singleton adapter instances. Stateful adapters (voice, vision, STT, TTS) are created per-session. Stateless adapters (text, embedding) are singletons.
2. **Capability metadata**: Dropped `ProviderCapabilities` and `ProviderDefinition`. Config routing is the source of truth, validated via Zod at startup.
3. **Adapter contracts**: Added `responseSchema` to ChatOptions, `chatWithToolsStream()` for pipeline voice, `Disposable` base with `close()`, `abort()` on STT/TTS streams, `AbortSignal` support on ChatOptions and TTSStreamOptions.
4. **Vision interface split**: Separate `StreamingVisionAdapter` and `SnapshotVisionAdapter` extending `BaseVisionAdapter`. Type guard `isStreamingVision()` for branching.
5. **Phase ordering**: CLI config commands and minimal wizard support moved into Phase 1. Users can create valid v3 config from day one.
6. **Embedding dimensions**: Explicit `dimensions` in config, `_meta` table in pgvector, mismatch detection + background re-embedding.
7. **Pipeline latency**: Documented realistic budget (700-1200ms no tools, +500-1500ms per tool), sentence-level streaming, explicit trade-off documentation.
8. **Gateway scope**: Narrowed to text/embedding/snapshot-vision only. Direct provider APIs for realtime voice, streaming vision, STT, TTS.
9. **Pricing model**: `AdapterPricing` supports per-token (text), per-minute (voice/STT), and per-character (TTS).
10. **v2 config**: Detected at startup with clear error message.
11. **Worker interject in pipeline mode**: Formalized `VoiceInterjector` interface with full contract: `interject(message, { immediate, bypassRateLimit? }): Promise<void>`. Matches existing `voice-fanout-bridge.ts` and `clarification-bridge.ts` usage. Both realtime and pipeline providers implement it.
12. **Crash-safe re-embedding**: Fine-grained state machine (`backfill:<table>` → `swap:<table>` → `done` → `idle`) with idempotent guards (`IF NOT EXISTS`, `IF EXISTS`, transactional swap). Covers all 3 vector tables: `facts`, `transcripts`, `transcript_chunks`.

## Open Questions

1. **Anthropic native API vs OpenAI-compatible?** Verify during Phase 1 spike whether Anthropic's OpenAI-compatible endpoint supports streaming tool calls reliably. If not, build a thin `AnthropicTextAdapter`.
2. **Local models?** Ollama support is straightforward (OpenAI-compatible API). Include in v3.0 or defer to v3.1?
3. **Default provider combo?** Recommend OpenRouter (text/embedding/vision) + Deepgram (STT) + ElevenLabs (TTS) as the "easy default" for pipeline mode. Or OpenAI (realtime) as the single-key realtime default.
4. **pi-ai provider support**: Blocked on Phase 1 spike result. If pi-ai only supports a fixed set of providers, worker routing is constrained to that set regardless of what Neura supports elsewhere.
