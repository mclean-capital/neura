# Phase 3b — Presence & Wake: Prototype Notes

## Prototype 1: Client-Side Wake Word (Storybook)

**Stack:** Silero VAD (`@ricky0123/vad-web` v0.0.30) + Whisper-tiny (`@huggingface/transformers` v4.0.1)

**Pipeline:** Mic → Silero VAD (speech detection) → Whisper-tiny (local transcription) → keyword match

**Results:**

- Pipeline works end-to-end, fully local, no audio leaves device
- Silero VAD: ~2 MB model, <1ms per 30ms chunk, near-zero CPU when silent
- Whisper-tiny fp32: ~150 MB (cached after first download), 1-3s transcription latency per segment
- Whisper q8 (`onnx-community/whisper-tiny.en`): ONNX Runtime WASM doesn't support the quantization format (MatMulNBits error)
- Common words like "jarvis" detected perfectly on first try
- Uncommon names like "neura" get misheared: "nura", "nure", "noora"
- Fuzzy matching (Levenshtein distance ≤ 2) catches mishearings reliably

**Setup friction (Storybook/Vite):**

- `onnxruntime-web` WASM files not resolved by Vite's bundler — needed Storybook `staticDirs` to serve them
- VAD model + worklet files also needed static serving
- Two `staticDirs` entries: vad-web/dist + onnxruntime-web/dist → `/vad/`

**Files created:**

- `packages/design-system/src/hooks/useWakeWord.ts` — React hook (VAD + Whisper + fuzzy match)
- `packages/design-system/src/hooks/WakeWordDemo.stories.tsx` — Storybook interactive demo

**Key findings:**

- 150 MB model download is heavy but one-time (browser cache)
- 1-3s latency acceptable for "hey Neura" → session start, but not great
- Fuzzy matching required for uncommon wake words — exact match insufficient
- `@ricky0123/vad-web` is browser/Electron only (no React Native)

---

## Alternative Models Evaluated

### Sherpa-ONNX KWS

- ~5.3 MB int8, streaming, open vocabulary
- **Rejected for now:** No pre-built browser WASM, keywords require BPE pre-tokenization via Python CLI, no browser npm package, custom Emscripten build required

### Picovoice Porcupine

- Best-in-class accuracy, instant custom keywords, polished SDKs for all platforms
- **Rejected:** $6,000/year commercial license, 3-user free tier

### openWakeWord

- ~3.5-5 MB, self-service custom model training (Colab, <1hr), Apache-2.0 code
- **Most promising for production** — train "neura" model once, deploy .onnx everywhere via onnxruntime
- **Gap:** No production browser/WASM or React Native SDK (Python-first)
- Browser WASM PoC exists (`openwakeword_wasm`, 2 stars) but immature

### DaVoice

- **Rejected:** Commercial product disguised as MIT. Requires license key (time-limited), custom wake words require contacting vendor, obfuscated engine, total vendor lock-in.

---

## Architecture Pivot: Server-Side Wake Word Detection

**Decision:** Move wake word detection from client to core.

**Rationale:**

1. Single implementation serves all clients (web, desktop, mobile, future)
2. No model size/platform constraints on core (Node.js, can use onnxruntime-node or Python)
3. Clients stay lightweight — no ML dependencies
4. openWakeWord becomes fully viable (onnxruntime-node, native speed)
5. Centralized state machine in core

**Local deployments (desktop/CLI):**

- Client streams ALL audio to core, always (48 KB/s on localhost — trivial)
- No client-side VAD needed
- Core handles everything: VAD, wake word detection, Grok session lifecycle

**Cloud deployments (future optimization):**

- Client-side VAD reduces bandwidth (only send speech segments)
- Need per-platform VAD: Silero for web/Electron, native VAD for React Native

**Protocol additions needed:**

- Server → Client: `presenceState` message (`passive` | `active` | `idle`)
- Client behavior changes based on state (VAD-only vs full-stream vs off)
- New tool: `enter_mode('passive' | 'active' | 'silent')` for AI-driven transitions

**State machine (owned by core):**

```
PASSIVE (default on connect)
  → wake word detected → ACTIVE
ACTIVE
  → AI calls enter_mode('passive') → PASSIVE
  → idle timeout (no addressed speech for 30s) → PASSIVE
  → client disconnects → IDLE
PASSIVE
  → client disconnects → IDLE
```

---

## Prototype 2: Server-Side Wake Word (Core + Web UI)

**Stack:** Energy-based VAD + Whisper-tiny (`@huggingface/transformers` v4.0.1 + `onnxruntime-node`) running in core, presence state machine, `enter_mode` tool for AI-driven transitions.

**Pipeline:** Client streams audio → Core energy VAD → speech segment → Whisper-tiny transcription → fuzzy keyword match + known aliases → wake trigger → Grok session

**Files created/modified:**

- `packages/core/src/presence/wake-detector.ts` — NEW: energy VAD + Whisper + fuzzy match + known aliases
- `packages/core/src/presence/presence-manager.ts` — NEW: PASSIVE/ACTIVE/IDLE state machine
- `packages/core/src/server/server.ts` — MODIFIED: refactored WS handler to use presence manager, deferred voice session creation
- `packages/core/src/tools/` — MODIFIED: added `enter_mode` tool, `getToolDefs` takes options object
- `packages/core/src/providers/grok-voice.ts` — MODIFIED: `enterMode` callback, `onReady` callback
- `packages/types/src/protocol.ts` — MODIFIED: added `PresenceStateMessage`
- `packages/types/src/providers.ts` — MODIFIED: added `onReady` to `VoiceProviderCallbacks`
- `packages/types/src/config.ts` — MODIFIED: added `assistantName`
- `packages/types/src/tools.ts` — MODIFIED: added `enum` to `ToolParameter`
- `packages/ui/src/App.tsx` — MODIFIED: presence state indicator (PASSIVE/ACTIVE badge)

**Results — what works:**

- Full pipeline validated end-to-end: client audio → core wake detection → Grok session → conversation
- State machine transitions correctly: PASSIVE → ACTIVE → PASSIVE
- UI shows PASSIVE/ACTIVE indicator with pulsing green dot
- Wake transcript forwarded to Grok via `onReady` callback (fires when Grok session is configured)
- Grok responds to wake activation (e.g., "Hey! What can I help you with?")
- `enter_mode('passive')` tool available for AI-driven deactivation
- whisper.cpp CLI validated separately — confirms transcription works on recorded speech
- Known aliases list catches common Whisper mishearings of "neura"
- 102 tests passing, full typecheck clean

**Results — problems found:**

1. **Wake word detection unreliable for "Neura"** — Whisper-tiny consistently mishears it as "nura", "europe", "norman", "anybody", etc. Required multiple attempts to trigger. Common English words like "jarvis" work perfectly on first try. The issue is fundamental to Whisper + uncommon proper nouns.
2. **Energy-based VAD is crude** — simple RMS threshold doesn't reliably distinguish speech from background noise. Tuning thresholds (0.01 → 0.005) helped but didn't solve it. Real VAD (Silero) would be much better but adds complexity on the server side.
3. **~150 MB model for server-side** — acceptable for a server (not constrained like browser), but still heavy. whisper.cpp with tiny.en model is ~75 MB and much faster.
4. **Latency** — 1-3s from speech end to wake detection (Whisper transcription time). Acceptable but noticeable.
5. **Grok content filter** — forwarding raw transcripts or instruction-like text as user messages can trigger Grok's content filter. Natural phrasing works better.

**Key insight:** The Whisper-based approach has a fundamental accuracy problem for uncommon wake words. Common names (Jarvis, Alexa, Siri) work great because Whisper was trained on them. "Neura" is not in Whisper's vocabulary, so it guesses similar-sounding words. Fuzzy matching + aliases help but don't fully solve it.

**Options explored (post-prototype 2):**

### Sherpa-ONNX KWS

- `sherpa-onnx-node` installs and works on Node 24 (unlike `vosk` which is broken)
- Has `KeywordSpotter` with open vocabulary, but keywords must be BPE pre-tokenized
- **Rejected:** can't tokenize arbitrary user-chosen names at runtime without a JS sentencepiece library or Python CLI

### Vosk + Grammar Mode

- Would constrain recognition to only the wake word — perfect accuracy
- `vosk` npm package uses `ffi-napi` which doesn't build on Node 24 (last updated 2022)
- **Rejected:** Node 24 incompatibility

### Moonshine

- Excellent ASR (beats Whisper at every size, 5-44x faster), MIT license, 7.6k stars
- Streaming v2 with 50ms latency, runs locally at ~26MB (int8 tiny)
- **Rejected for wake word:** same fundamental problem as Whisper — no grammar/vocabulary constraint, BPE tokenizer will mishear uncommon words

### Gemma 4

- E2B/E4B have native audio input via 300M-param conformer encoder
- **Rejected for wake word:** processes 30-second chunks (not streaming), too heavy for always-on

### Gemini Live (always-on)

- Proactive Audio mode on `gemini-live-2.5-flash-native-audio` — system prompt "only respond when user says 'Neura'"
- **Rejected:** $0.005/min = $7.20/day for always-on streaming, latency spikes 7-15s

---

## Prototype 3: VAD + Gemini Transcription + Fuzzy Match + Audio Replay (final)

**Key insight:** Instead of running a local ASR model (which struggles with uncommon names), use VAD to detect speech segments, send them to Gemini for transcription, then match locally via edit distance. Buffer raw audio and replay it to Grok on activation so no context is lost.

**Architecture:**

```
Client streams audio → Core
                        ↓
                    [Energy VAD: speech detected?]
                     no → discard (zero cost)
                     yes → buffer Float32 frames
                        ↓
                    [Gemini 2.5 Flash: "Transcribe what the speaker said."]
                        ↓
                    [Local fuzzy match: edit distance ≤ floor(len/3)]
                     no → discard
                     yes ↓
                    [ACTIVE: connect Grok session]
                        ↓
                    [Replay buffered PCM audio to Grok via sendAudio()]
                        ↓
                    Grok hears original speech, responds naturally
```

**Evolution during prototyping:**

The initial approach asked Gemini a binary question: "Is the speaker saying the name X?" This worked on the first test (100% accuracy) but proved unreliable in extended testing — Gemini was too eager to say "yes" on ambiguous audio, causing false positives (e.g., Spanish speech "Ajá, está bien" triggered wake). Gemini 2.5 Flash-Lite was tested for lower latency (1.4s vs 3.2s) but had even worse accuracy (1/3 success rate on valid wakes).

The fix: **separate transcription from classification**. Gemini transcribes the audio (what it's great at), we do string matching locally (what we can control precisely). This eliminated all false positives while maintaining detection accuracy.

**Files created/modified:**

- `packages/core/src/presence/wake-detector.ts` — Energy VAD + Gemini transcription + Levenshtein fuzzy match + pre-speech buffer
- `packages/core/src/presence/presence-manager.ts` — PASSIVE/ACTIVE/IDLE state machine (5-min idle timeout)
- `packages/core/src/server/server.ts` — Presence-aware WS handler, audio replay on wake via `onReady` callback, manual start support
- `packages/core/src/tools/` — Added `enter_mode` tool (deferred via `queueMicrotask`)
- `packages/core/src/config/config.ts` — Added `assistantName` config (default: "jarvis")
- `packages/types/src/protocol.ts` — Added `PresenceStateMessage`, `ManualStartMessage`
- `packages/types/src/providers.ts` — Added `onReady` to `VoiceProviderCallbacks`
- `packages/types/src/tools.ts` — Added `enum` to `ToolParameter`
- `packages/ui/src/App.tsx` — Presence indicator, manual Start button, auto-mic on connect

**Live test results:**

- 14 consecutive false positive rejections (random speech, Spanish, ambient chatter) — zero false triggers
- Wake word detected reliably via fuzzy match ("Nura" → distance 1 from "neura" → match)
- Grok heard replayed audio and responded to the actual question (tool calls worked, e.g., `get_current_time`)
- Gemini transcription latency: ~1.5-2s per speech segment
- End-to-end wake-to-response: ~5s

**Cost analysis (Gemini 2.5 Flash):**

- Per check (avg 2.7s audio): ~$0.000115
- Quiet office (30 checks/hr): ~$0.84/month
- Moderate (120 checks/hr): ~$3.30/month
- Heavy (400 checks/hr): ~$11/month
- Negligible compared to Grok ACTIVE mode ($3/hr)

**Local model comparison (Parakeet TDT 0.6B):**
Tested NVIDIA Parakeet as a free/local alternative (via sherpa-onnx-node, int8 quantized, 630MB):

- Parakeet: transcribed "Neura" as "Nura" (1/4), "Newer" (1/4), "Noor" (1/4), missed (1/4)
- Gemini: transcribed "Neura" as "Nura" (live, reliable), "Enura"/"Neuron"/"Nora" (pre-recorded, distance 2)
- **Verdict:** Parakeet has the same fundamental accuracy problem as Whisper for uncommon names. Gemini is more reliable and already cheaper than dedicated STT services ($0.002/min vs $0.006-0.024/min).

**Model comparison for wake word transcription:**

| Model                     | Cost/min | Latency | "Neura" transcription            | Verdict            |
| ------------------------- | -------- | ------- | -------------------------------- | ------------------ |
| Whisper-tiny (local)      | Free     | 1-3s    | "nura", "europe", "norman"       | Unreliable         |
| Parakeet TDT 0.6B (local) | Free     | ~100ms  | "Nura", "Newer", "Noor"          | Unreliable         |
| Gemini 2.5 Flash-Lite     | $0.0004  | ~1.4s   | Binary classification unreliable | Rejected           |
| Gemini 2.5 Flash          | $0.002   | ~1.5-2s | "Nura" (live, consistent)        | **Selected**       |
| Google Cloud STT          | $0.024   | ~1s     | Unknown                          | 12× more expensive |
| Deepgram Nova-2           | $0.0043  | ~300ms  | Unknown                          | 2× more expensive  |

**Why this approach (final):**

1. **Best accuracy for any name** — Gemini transcription + local fuzzy match eliminates both false positives and false negatives
2. **User-configurable wake word** — just a config string, no retraining
3. **Zero new dependencies** — uses existing `@google/genai` SDK
4. **No local model files** — no 150MB+ downloads
5. **Audio replay** — Grok hears the original speech, responds naturally to the actual question
6. **Manual start fallback** — button in UI for when wake detection fails
7. **Cost negligible** — ~$1-3/month, dwarfed by Grok voice costs

**Trade-offs:**

- Cloud dependency for passive mode (requires internet)
- ~1.5-2s latency per wake check (Gemini API round-trip)
- Pre-speech buffer (150ms) needed to capture word onset
- Default wake word changed to "jarvis" (common word, transcribes perfectly) — configurable via `NEURA_ASSISTANT_NAME` env var or `assistantName` in config.json

**Future optimizations (completed — see Prototype 4 below):**

- ~~openWakeWord for fixed/default wake word (free, <1ms, ~2MB) with Gemini fallback for custom names~~ → Replaced by livekit-wakeword ONNX pipeline
- Silero VAD to replace energy-based VAD for better speech boundary detection
- Client-side VAD for cloud deployments (reduce bandwidth)

---

## Prototype 4: ONNX-Based Wake Detection (final, replaces Prototype 3)

**Key insight:** [livekit-wakeword](https://github.com/livekit/livekit-wakeword) (Apache 2.0) provides a complete pipeline for training and deploying custom wake word models. Unlike openWakeWord (which was evaluated but lacked Node.js/browser support), livekit-wakeword's ONNX models run directly in Node.js via `onnxruntime-node` — no Python sidecar needed.

**Architecture:**

```
Client streams audio (24kHz PCM) → Core
                                    ↓
                              [Resample 24kHz → 16kHz]
                                    ↓
                              [2-second sliding window ring buffer]
                                    ↓  (every ~320ms)
                              [Energy gate: skip if silent]
                                    ↓
                              [Mel spectrogram ONNX (1 MB)]
                                    ↓
                              [Speech embedding ONNX (1.3 MB)]
                                    ↓
                              [Classifier ONNX (~170 KB)]
                                    ↓
                              [Score ≥ 0.5 → WAKE DETECTED]
                                    ↓
                              [Replay buffered audio to Grok]
```

**Why this replaced Gemini transcription:**

| Metric            | Gemini (Prototype 3)          | ONNX (Prototype 4)                 |
| ----------------- | ----------------------------- | ---------------------------------- |
| Latency           | ~2-5s (API round-trip)        | ~5-20ms (local inference)          |
| Cost/wake         | $0.000115                     | $0                                 |
| Offline           | No (requires internet)        | Yes                                |
| False positives   | 0 in testing (14/14 rejected) | 0.17 FPPH at optimal threshold     |
| Custom wake words | Any word, no training         | Requires ~45 min training per word |
| Dependencies      | Google API key                | onnxruntime-node (~2.5 MB models)  |

**Training pipeline (via livekit-wakeword):**

1. VITS TTS synthesizes 10,000 audio clips (positive + adversarial negatives) with 904 speaker blending
2. Augmentation adds room reverb, background noise, EQ distortion (2 rounds)
3. Feature extraction: mel spectrogram → Google CNN speech embeddings (both frozen ONNX)
4. 3-phase adaptive training of Conv-Attention classifier (30K steps)
5. Export to ONNX (~170 KB per wake word)
6. Deploy to `~/.neura/models/{name}.onnx`

**Trained models:**

| Model  | Accuracy | Recall | FPPH                   | Size   |
| ------ | -------- | ------ | ---------------------- | ------ |
| jarvis | 91.7%    | 83.5%  | 1.9 (0.17 at optimal)  | 172 KB |
| neura  | 95.1%    | 90.4%  | 1.46 (0.17 at optimal) | 172 KB |

**Files created/modified:**

- `packages/core/src/presence/onnx-wake-detector.ts` — NEW: ONNX 3-stage pipeline (mel → embedding → classifier), ring buffer, resampling, energy gate, debounce
- `packages/core/src/presence/onnx-wake-detector.test.ts` — NEW: 7 unit tests with mocked ONNX runtime
- `packages/core/src/server/websocket.ts` — MODIFIED: `startWakeDetector()` loads ONNX models, scans available wake words
- `packages/core/src/presence/wake-detector.ts` — PRESERVED: legacy Gemini-based detector (unused, kept for reference)
- `tools/wake-word/` — NEW: training configs, setup/train/deploy scripts, full documentation

**Apple Silicon gotcha:** The training environment (Python + livekit-wakeword) requires arm64-compatible native extensions. When the shell runs under Rosetta (x86_64), use `ARCHFLAGS="-arch arm64"` to rebuild webrtcvad. The setup script handles this automatically.
