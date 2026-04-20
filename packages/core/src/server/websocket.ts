import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { URL } from 'url';
import type { ClientMessage, ServerMessage, VoiceProvider } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { createVoiceSession } from '../providers/voice-session.js';
import { createVisionWatcher } from '../providers/vision-watcher.js';
import { CostTracker } from '../cost/index.js';
import type { MemoryToolHandler, TaskToolHandler } from '../tools/index.js';
import { applyTaskUpdate, resolveTask } from '../tools/task-update-handler.js';
import { listComments } from '../stores/task-comment-queries.js';
import type { LogSource } from '../tools/log-reader.js';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { OnnxWakeDetector } from '../presence/onnx-wake-detector.js';
import { PresenceManager } from '../presence/presence-manager.js';
import { verifyToken } from './auth.js';
import type { CoreServices } from './lifecycle.js';

const log = new Logger('server');

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const COST_UPDATE_INTERVAL_MS = 30_000;

/** Infrastructure models that are not wake word classifiers */
const INFRA_MODELS = new Set(['melspectrogram', 'embedding_model']);

/** Scan models directory for available wake word classifiers */
function buildSource(options: { source?: 'core' | 'session'; sessionFile?: string }): LogSource {
  if (options.source === 'session') {
    // Tool handler already validates this combination; assert so a
    // future refactor can't silently pass an empty path through to
    // the reader (which would read the sessions dir itself).
    if (!options.sessionFile) {
      throw new Error("read_log with source='session' requires session_file");
    }
    return { kind: 'session', sessionFile: options.sessionFile };
  }
  return { kind: 'core' };
}

function getAvailableWakeWords(modelsDir: string): string[] {
  try {
    return readdirSync(modelsDir)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.replace('.onnx', ''))
      .filter((name) => !INFRA_MODELS.has(name));
  } catch {
    return [];
  }
}

export function attachWebSocket(httpServer: Server, services: CoreServices): WebSocketServer {
  const {
    store,
    memoryManager,
    config,
    connectedClients,
    pendingCleanups,
    voiceFanoutBridge,
    clarificationBridge,
    skillToolHandler,
    workerControlHandler,
    systemStateHandler,
    workerDispatchHandler,
    skillRegistry,
  } = services;
  const { authToken } = config;

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 10 * 1024 * 1024, // 10 MB — accommodates 4K screen share frames
    verifyClient: authToken
      ? (
          info: { req: IncomingMessage },
          done: (ok: boolean, code?: number, msg?: string) => void
        ) => {
          const url = new URL(info.req.url ?? '', 'http://localhost');
          const token = url.searchParams.get('token');
          if (token && verifyToken(token, authToken)) {
            done(true);
          } else {
            log.warn('websocket auth rejected');
            done(false, 401, 'Unauthorized');
          }
        }
      : undefined,
  });

  wss.on('connection', (ws: WebSocket) => {
    log.info('client connected');

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'presenceState', state: 'passive' }));
    }

    // Create DB session in the background — handlers are registered synchronously
    // so no messages or close events are missed while the insert runs.
    // Use actual provider/model names from config for session recording
    const voiceRoute = services.config.routing.voice;
    const visionRoute = services.config.routing.vision;
    let voiceProviderLabel: string;
    if (!voiceRoute) {
      // No voice routing configured, but voice-session factory may still fall back
      // to GrokVoiceProvider via env var — record that as a fallback
      voiceProviderLabel = process.env.XAI_API_KEY ? 'xai/grok (fallback)' : 'none';
    } else if (voiceRoute.mode === 'realtime') {
      voiceProviderLabel = `${voiceRoute.provider}/${voiceRoute.model}`;
    } else {
      // Pipeline mode — record actual STT/LLM/TTS providers
      voiceProviderLabel = `pipeline:${voiceRoute.stt.provider}+${voiceRoute.llm.provider}+${voiceRoute.tts.provider}`;
    }
    const visionProviderLabel = visionRoute
      ? `${visionRoute.provider}/${visionRoute.model} (${visionRoute.mode})`
      : 'none';

    const sessionIdPromise: Promise<string | null> = store
      ? store.createSession(voiceProviderLabel, visionProviderLabel).catch((err) => {
          log.warn('session creation failed', { err: String(err) });
          return null;
        })
      : Promise.resolve(null);

    // Track in-flight store writes so the close handler can drain them
    const pendingWrites = new Set<Promise<void>>();
    function trackWrite(p: Promise<void>) {
      pendingWrites.add(p);
      void p.finally(() => pendingWrites.delete(p));
    }

    // Extraction flag — prevents double extraction from idle timer + close
    let extractionTriggered = false;
    function triggerExtraction() {
      if (extractionTriggered || !memoryManager) return;
      extractionTriggered = true;
      const extractionPromise = sessionIdPromise
        .then(async (sid) => {
          if (sid) {
            await Promise.allSettled([...pendingWrites]);
            await memoryManager.queueExtraction(sid);
          }
        })
        .catch((err) => {
          log.warn('extraction failed', { err: String(err) });
        });
      pendingCleanups.add(extractionPromise);
      void extractionPromise.finally(() => pendingCleanups.delete(extractionPromise));
    }

    // Idle timer — triggers extraction after inactivity
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info('idle timeout, triggering extraction');
        triggerExtraction();
      }, IDLE_TIMEOUT_MS);
    }

    // One watcher per source — created on demand, destroyed on stop
    let cameraWatcher: ReturnType<typeof createVisionWatcher> | null = null;
    let screenWatcher: ReturnType<typeof createVisionWatcher> | null = null;
    const costTracker = new CostTracker();

    function getOrCreateWatcher(source: 'camera' | 'screen') {
      const existing = source === 'camera' ? cameraWatcher : screenWatcher;
      if (existing) return existing;

      const visionRoute = services.config.routing.vision;
      const visionApiKey = visionRoute
        ? services.config.providers[visionRoute.provider]?.apiKey
        : undefined;
      // For snapshot mode, create a dedicated text adapter from the vision route
      // so routing.vision.provider/model is respected (not the singleton routing.text)
      let snapshotTextAdapter;
      if (visionRoute?.mode === 'snapshot') {
        const route = services.registry.resolveVision();
        if (route) {
          snapshotTextAdapter = services.registry.createTextAdapterForRoute(route.route);
        }
      }
      const watcher = createVisionWatcher({
        label: source,
        mode: visionRoute?.mode,
        apiKey: visionApiKey,
        model: visionRoute?.model,
        textAdapter: snapshotTextAdapter,
      });
      if (source === 'camera') cameraWatcher = watcher;
      else screenWatcher = watcher;

      // Capture ref before async gap so cost tracker targets the right instance
      void watcher.connect().then(() => {
        const current = source === 'camera' ? cameraWatcher : screenWatcher;
        if (watcher === current && watcher.isConnected()) {
          costTracker.markVisionActive(source);
        }
      });

      return watcher;
    }

    function closeWatcher(source: 'camera' | 'screen') {
      if (source === 'camera' && cameraWatcher) {
        cameraWatcher.close();
        cameraWatcher = null;
        costTracker.markVisionInactive('camera');
        log.info('camera watcher closed');
      } else if (source === 'screen' && screenWatcher) {
        screenWatcher.close();
        screenWatcher = null;
        costTracker.markVisionInactive('screen');
        log.info('screen watcher closed');
      }
    }

    // Build memory tools handler (closes over memoryManager)
    const memoryTools: MemoryToolHandler | undefined = memoryManager
      ? {
          storeFact: (content, category, tags, sessionId) =>
            memoryManager.storeFact(content, category, tags, sessionId),
          recall: (query, limit) => memoryManager.recall(query, limit),
          storePreference: (preference, category, sessionId) =>
            memoryManager.storePreference(preference, category, sessionId),
          invalidateFact: (query) => memoryManager.invalidateFact(query),
          getTimeline: (daysBack, entityFilter) =>
            memoryManager.getTimeline(daysBack, entityFilter),
          getMemoryStats: () => memoryManager.getMemoryStats(),
        }
      : undefined;

    // Build task tools handler (closes over store). Phase 6b: unified
    // update_task takes a structured payload (status / comment / fields)
    // and returns { task, version, comment? } so the orchestrator can
    // relay details to the user.
    const taskTools: TaskToolHandler | undefined = store
      ? {
          createTask: (title, priority, opts) => store.createWorkItem(title, priority, opts),
          listTasks: async (filter) => {
            const limit = filter?.limit ?? 100;

            // Default: no filters → non-terminal tasks only.
            if (
              !filter ||
              (!filter.status && !filter.needsAttention && !filter.source && !filter.since)
            ) {
              return store.getOpenWorkItems(limit);
            }

            // needs_attention shortcut wins over other filters — it's the
            // orchestrator's "what's blocked on me" query.
            if (filter.needsAttention) {
              const items = await store.getWorkItems({ limit: 500 });
              return items.filter(
                (t) =>
                  t.status === 'awaiting_clarification' ||
                  t.status === 'awaiting_approval' ||
                  (t.source !== 'user' && t.status === 'pending')
              );
            }

            // Fetch a candidate set based on the status filter, then apply
            // source/since filters client-side. Tiny scale at current
            // volume — swap to index-backed SQL before enabling
            // system_proactive at scale (tracked in plan §Worktree risks).
            let candidates: Awaited<ReturnType<typeof store.getWorkItems>>;

            const hasAllInArrayOrScalar =
              filter.status === 'all' ||
              (Array.isArray(filter.status) && filter.status.includes('all' as never));

            if (hasAllInArrayOrScalar) {
              candidates = await store.getWorkItems({ limit: 500 });
            } else if (Array.isArray(filter.status)) {
              const all = await store.getWorkItems({ limit: 500 });
              const wanted = new Set(filter.status);
              candidates = all.filter((t) => wanted.has(t.status));
            } else if (typeof filter.status === 'string') {
              candidates = await store.getWorkItems({ status: filter.status, limit: 500 });
            } else {
              candidates = await store.getOpenWorkItems(500);
            }

            // Apply source filter.
            if (filter.source) {
              candidates = candidates.filter((t) => t.source === filter.source);
            }

            // Apply since filter — updated_at greater than the given ISO.
            if (filter.since) {
              const sinceMs = Date.parse(filter.since);
              if (!Number.isNaN(sinceMs)) {
                candidates = candidates.filter((t) => Date.parse(t.updatedAt) > sinceMs);
              }
            }

            return candidates.slice(0, limit);
          },
          getTask: (idOrTitle) => resolveTask(store, idOrTitle),
          listTaskComments: async (taskId, options) => {
            const db = store.getRawDb?.() as import('@electric-sql/pglite').PGlite | undefined;
            if (!db) throw new Error('store does not expose a raw PGlite handle');
            return listComments(db, {
              taskId,
              limit: options?.limit,
              order: options?.order,
              excludeTypes: options?.excludeTypes,
            });
          },
          getWorkerSessionFile: async (workerId) => {
            const db = store.getRawDb?.() as import('@electric-sql/pglite').PGlite | undefined;
            if (!db) return null;
            const { getWorker } = await import('../stores/worker-queries.js');
            const worker = await getWorker(db, workerId);
            return worker?.sessionFile ?? null;
          },
          updateTask: async (idOrTitle, payload) => {
            const current = await resolveTask(store, idOrTitle);
            if (!current) return null;
            const db = store.getRawDb?.() as import('@electric-sql/pglite').PGlite | undefined;
            if (!db) throw new Error('store does not expose a raw PGlite handle');
            return applyTaskUpdate({ db, task: current, payload, actor: 'orchestrator' });
          },
          deleteTask: async (idOrTitle) => {
            const byId = await store.getWorkItem(idOrTitle);
            if (byId) {
              await store.deleteWorkItem(byId.id);
              return true;
            }
            const all = await store.getWorkItems({ limit: 200 });
            const lower = idOrTitle.toLowerCase();
            const match = all.find((t) => t.title.toLowerCase().includes(lower));
            if (!match) return false;
            await store.deleteWorkItem(match.id);
            return true;
          },
        }
      : undefined;

    // ── Presence state machine ─────────────────────────────────────
    let session: VoiceProvider | null = null;
    let connectionClosed = false;
    let wakeDetector: OnnxWakeDetector | null = null;

    function send(msg: ServerMessage) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    const voiceCallbacks = {
      onAudio(data: string) {
        send({ type: 'audio', data });
      },
      onInputTranscript(text: string) {
        send({ type: 'inputTranscript', text });
        if (store) {
          trackWrite(
            sessionIdPromise
              .then(async (sid) => {
                if (sid) await store.appendTranscript(sid, 'user', text);
              })
              .catch((err) => {
                log.warn('transcript write failed', { err: String(err) });
              })
          );
        }
        // Phase 6: if any worker is currently blocked on a
        // request_clarification tool call, resolve the oldest pending
        // clarification with this transcript. Returns true if
        // consumed so future logic can branch on it — today we still
        // let Grok see the transcript too (it's normal user speech,
        // not a special sentinel) so the orchestrator has full
        // context of the conversation.
        clarificationBridge?.notifyUserTurn(text);
      },
      onOutputTranscript(text: string) {
        send({ type: 'outputTranscript', text });
      },
      onOutputTranscriptComplete(text: string) {
        if (store) {
          trackWrite(
            sessionIdPromise
              .then(async (sid) => {
                if (sid) await store.appendTranscript(sid, 'assistant', text);
              })
              .catch((err) => {
                log.warn('transcript write failed', { err: String(err) });
              })
          );
        }
      },
      onInterrupted() {
        send({ type: 'interrupted' });
      },
      onTurnComplete() {
        send({ type: 'turnComplete' });
      },
      onToolCall(name: string, args: Record<string, unknown>) {
        send({ type: 'toolCall', name, args });
      },
      onToolResult(name: string, result: Record<string, unknown>) {
        send({ type: 'toolResult', name, result });
      },
      onError(error: string) {
        send({ type: 'error', error });
      },
      onClose() {
        send({ type: 'sessionClosed' });
      },
      onReady() {
        // Grok session is configured — replay the buffered audio in
        // chronological order:
        //
        //   1. pendingWakeAudio   = the ~2.4s of audio BEFORE the wake
        //                           detector fired (rolling replay
        //                           buffer inside OnnxWakeDetector).
        //                           Contains "Hey Jarvis" and whatever
        //                           ambient context preceded it.
        //   2. pendingActivationAudio = audio frames that arrived AFTER
        //                               the wake fired but BEFORE this
        //                               onReady callback — the rest of
        //                               the user's initial utterance
        //                               ("how's it going?") captured
        //                               during the async activation
        //                               window. Without this replay
        //                               Grok only hears the wake word
        //                               itself and has nothing to
        //                               respond to.
        //   3. pendingText         = any text messages that also
        //                            arrived during activation.
        //
        // All three get drained into the session in order.
        if (pendingWakeAudio) {
          const chunks = pendingWakeAudio;
          pendingWakeAudio = null;
          for (const chunk of chunks) {
            session?.sendAudio(chunk);
          }
        }
        if (pendingActivationAudio.length > 0) {
          const chunks = pendingActivationAudio;
          pendingActivationAudio = [];
          for (const chunk of chunks) {
            session?.sendAudio(chunk);
          }
        }
        if (pendingText.length > 0) {
          const texts = pendingText;
          pendingText = [];
          for (const text of texts) {
            session?.sendText(text);
          }
        }
      },
      onReconnected() {
        if (cameraWatcher?.isConnected()) {
          session?.sendSystemEvent(
            'The user is currently sharing their camera. You can use the describe_camera tool to see it.'
          );
        }
        if (screenWatcher?.isConnected()) {
          session?.sendSystemEvent(
            'The user is currently sharing their screen. You can use the describe_screen tool to see it.'
          );
        }
      },
      queryWatcher(prompt: string, source: 'camera' | 'screen') {
        const watcher = source === 'camera' ? cameraWatcher : screenWatcher;
        if (!watcher) {
          return Promise.resolve(`${source} not active — user hasn't shared their ${source}.`);
        }
        return watcher.query(prompt);
      },
    };

    let pendingWakeAudio: string[] | null = null;
    // Text messages that arrived while the voice session was still being
    // asynchronously activated (between presence.state=active and
    // session.connect() completing). Replayed in onReady().
    let pendingText: string[] = [];
    // Audio frames that arrived while the voice session was still being
    // asynchronously activated. The user keeps talking after the wake
    // word fires ("Hey Jarvis, how's it going?"), and those audio frames
    // need to reach Grok when it comes up — otherwise Grok only hears
    // the pre-wake replay ("Hey Jarvis") and has nothing to respond to.
    // Capped to prevent unbounded growth if the session never becomes
    // ready (e.g. Grok API is down). 100 frames ≈ 20s of audio at the
    // 200ms/chunk cadence the client sends, which is far longer than a
    // normal activation window (typically 200-1000ms).
    let pendingActivationAudio: string[] = [];
    const MAX_PENDING_ACTIVATION_AUDIO = 100;

    async function activateVoiceSession(wakeTranscript: string) {
      if (connectionClosed || session) return;
      log.info('activating voice session', { wakeTranscript });

      // Reset extraction flag so this active session gets its own extraction
      extractionTriggered = false;

      // NOTE: we deliberately do NOT close or null out `wakeDetector`
      // here. The audio router below (see `ws.on('message')`) already
      // gates on `presence.state === 'active'` to route frames to
      // Grok instead of the detector, so the detector simply stops
      // receiving audio while active — no need to tear it down.
      //
      // Keeping it alive avoids a race on deactivate: previously we
      // closed the detector here and then re-created it async via
      // `void startWakeDetector()` in `deactivateVoiceSession()`,
      // which meant incoming audio frames arriving during the ~100ms
      // `OnnxWakeDetector.create()` window hit a null detector and
      // got silently dropped. The user's second wake word landed in
      // that dead zone and never fired.
      //
      // The detector is now created once at connection start and
      // kept for the full WebSocket lifetime. We call `reset()` on
      // deactivate to clear stale audio from before the active
      // session without releasing the expensive ONNX sessions.

      // Build fresh system prompt each activation (memory context may have changed)
      let systemPromptPrefix = memoryManager
        ? await memoryManager.buildSystemPrompt().catch((err) => {
            log.warn('memory prompt build failed', { err: String(err) });
            return undefined;
          })
        : undefined;

      // Append open tasks to system prompt so Grok knows about them
      if (store) {
        const openTasks = await store.getOpenWorkItems(20);
        if (openTasks.length > 0) {
          const taskBlock =
            '\n\nOpen tasks:\n' +
            openTasks
              .map((t) => {
                const due = t.dueAt ? ` (due: ${new Date(t.dueAt).toLocaleString()})` : '';
                return `- [${t.priority}] ${t.title}${due}`;
              })
              .join('\n') +
            '\nYou can reference these tasks and help the user manage them.';
          systemPromptPrefix = (systemPromptPrefix ?? '') + taskBlock;
        }
      }

      // Phase 6: inject every loaded orchestrator skill's markdown
      // body into the system prompt. These are skills tagged with
      // `metadata.neura_level: 'orchestrator'` in their frontmatter;
      // their bodies describe always-on orchestrator behavior
      // (pause/resume/cancel routing, clarification handling, etc.)
      // that Grok reads at every turn. Driven by SKILL.md files so
      // behavior can be edited without touching code.
      if (skillRegistry) {
        const orchestratorPrefix = skillRegistry.buildOrchestratorPromptPrefix();
        if (orchestratorPrefix.length > 0) {
          systemPromptPrefix = (systemPromptPrefix ?? '') + orchestratorPrefix;
        }
      }

      // Re-check state after async gap — may have gone passive/idle during await
      if (connectionClosed || presence.state !== 'active') return;

      session = createVoiceSession(
        voiceCallbacks,
        {
          mode: services.config.routing.voice?.mode ?? 'realtime',
          systemPromptPrefix,
          memoryTools,
          enterMode: (mode) => presence.enterMode(mode),
          taskTools,
          skillTools: skillToolHandler ?? undefined,
          workerControl: workerControlHandler ?? undefined,
          systemState: systemStateHandler ?? undefined,
          workerDispatch: workerDispatchHandler ?? undefined,
          workerLogs: {
            // readLog is sync. The async wrapper satisfies the
            // interface contract and leaves room for future I/O
            // (e.g. a streamed read), but there's no await here.
            read: async (options) => {
              const { readLog } = await import('../tools/log-reader.js');
              return readLog({
                neuraHome: services.config.neuraHome,
                ...(options.source ? { source: buildSource(options) } : {}),
                ...(options.path ? { path: options.path } : {}),
                ...(options.workerId ? { workerId: options.workerId } : {}),
                ...(options.taskId ? { taskId: options.taskId } : {}),
                minLevel: options.includeInfo ? 'info' : 'warn',
                ...(options.lines !== undefined ? { limit: options.lines } : {}),
              });
            },
          },
        },
        services.registry
      );
      costTracker.startInterval(send, COST_UPDATE_INTERVAL_MS);
      session.connect();
      resetIdleTimer();

      // Phase 6: attach this client's voice session to the fanout
      // bridge so worker events (tool_start affordances, text delta
      // batches, "Done." on completion) speak through it. Detached
      // in deactivateVoiceSession() and on ws close.
      if (voiceFanoutBridge && session) {
        voiceFanoutBridge.setInterjector(
          session as unknown as {
            interject: (
              message: string,
              options: { immediate: boolean; bypassRateLimit?: boolean }
            ) => Promise<void>;
          }
        );
      }
    }

    function deactivateVoiceSession() {
      log.info('deactivating voice session');
      pendingWakeAudio = null;
      pendingActivationAudio = [];
      pendingText = [];
      costTracker.stopInterval();
      triggerExtraction();

      session?.close();
      session = null;

      // Detach the fanout bridge from this client's (now-dead) voice
      // session so ambient worker events fall back to the no-op
      // interjector instead of trying to speak through a closed ws.
      voiceFanoutBridge?.setInterjector(null);

      // Resume wake-word detection by resetting the long-lived
      // detector instance. This clears its ring buffer, replay
      // chunks, and frame counters so stale audio from before the
      // active session doesn't contaminate the next wake cycle.
      //
      // `reset()` is synchronous and operates on an already-loaded
      // detector — the next audio frame the message handler routes
      // here (see `ws.on('message')` below, 'passive' branch) will
      // be processed immediately. No async gap, no dropped audio,
      // no second-wake failure.
      wakeDetector?.reset();
    }

    async function startWakeDetector() {
      if (connectionClosed) return;

      const modelsDir = join(config.neuraHome, 'models');
      const melPath = join(modelsDir, 'melspectrogram.onnx');
      const embPath = join(modelsDir, 'embedding_model.onnx');
      const classifierPath = join(modelsDir, `${config.assistantName}.onnx`);

      if (!existsSync(melPath) || !existsSync(embPath)) {
        log.warn('ONNX base models not found, wake detection disabled', { modelsDir });
        return;
      }

      if (!existsSync(classifierPath)) {
        const available = getAvailableWakeWords(modelsDir);
        log.warn('no wake word model for configured name', {
          assistantName: config.assistantName,
          available,
        });
        return;
      }

      try {
        wakeDetector = await OnnxWakeDetector.create({
          assistantName: config.assistantName,
          modelsDir,
          onWake: (audioChunks) => {
            pendingWakeAudio = audioChunks;
            presence.wake('(detected via onnx)');
          },
          onDebug: (info) => {
            log.debug('onnx wake check', info);
          },
        });
        log.info('wake word detection active', { assistantName: config.assistantName });
      } catch (err) {
        log.error('ONNX wake detector failed to start', { err: String(err) });
      }
    }

    const presence = new PresenceManager({
      onActivate: (wakeTranscript) => void activateVoiceSession(wakeTranscript),
      onDeactivate: () => deactivateVoiceSession(),
      onStateChange: (state) =>
        send({
          type: 'presenceState',
          state,
          // Tell the client whether wake-word detection is available so
          // it can show the right banner in passive mode. `wakeDetector`
          // is null if the ONNX models failed to load on connection start
          // (missing files, wrong assistant name, onnxruntime failure).
          wakeDetection: wakeDetector ? 'active' : 'disabled',
        }),
    });

    // Register in connected clients for discovery loop notifications
    connectedClients.set(ws, {
      send,
      presence,
      getSession: () => session,
    });

    // Start in passive mode with wake detection
    void startWakeDetector();

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        switch (msg.type) {
          case 'audio':
            if (presence.state === 'active') {
              if (session) {
                // Active + session ready: forward audio to Grok directly.
                resetIdleTimer();
                presence.resetIdleTimer();
                extractionTriggered = false;
                session.sendAudio(msg.data);
              } else {
                // Active but session is still asynchronously activating
                // (memory prompt build + Grok WebSocket connect). The
                // user's continued speech after the wake word — e.g. the
                // "how's it going?" in "Hey Jarvis, how's it going?" —
                // arrives during this window and would otherwise be
                // silently dropped. Buffer it so onReady() can replay
                // it after the pre-wake audio, preserving the full
                // utterance from the user's point of view.
                //
                // Capped to avoid unbounded growth if activation hangs;
                // when we hit the cap we drop OLDEST frames so the tail
                // (what the user most recently said) stays intact.
                pendingActivationAudio.push(msg.data);
                if (pendingActivationAudio.length > MAX_PENDING_ACTIVATION_AUDIO) {
                  pendingActivationAudio.shift();
                }
              }
            } else if (presence.state === 'passive') {
              if (wakeDetector) {
                wakeDetector.feedAudio(msg.data);
              } else {
                log.debug('audio received but no wake detector');
              }
            }
            break;
          case 'text':
            if (presence.state === 'active') {
              resetIdleTimer();
              extractionTriggered = false;
              if (session) {
                session.sendText(msg.text);
              } else {
                // Session is still asynchronously activating (memoryManager
                // prompt build + Grok WebSocket connect). Buffer the text so
                // it isn't lost; onReady() will replay it when session is up.
                pendingText.push(msg.text);
              }
            }
            break;
          case 'videoFrame': {
            if (presence.state !== 'active') break;
            const watcher = getOrCreateWatcher(msg.source);
            watcher.sendFrame(msg.data);
            break;
          }
          case 'sourceChanged':
            if (presence.state !== 'active' || !session) break;
            if (msg.active) {
              closeWatcher(msg.source);
              getOrCreateWatcher(msg.source);
              session.sendSystemEvent(
                `The user just started sharing their ${msg.source}. You can now use the describe_${msg.source} tool to see it.`
              );
            } else {
              closeWatcher(msg.source);
              session.sendSystemEvent(
                `The user stopped sharing their ${msg.source}. The describe_${msg.source} tool is no longer available.`
              );
            }
            break;
          case 'manualStart':
            if (presence.state === 'passive') {
              log.info('manual session start');
              presence.enterMode('active');
            }
            break;
        }
      } catch (err) {
        log.error('bad message', { err: String(err) });
      }
    });

    ws.on('close', () => {
      log.info('client disconnected');
      connectionClosed = true;
      connectedClients.delete(ws);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }

      // Detach the fanout bridge — deactivateVoiceSession() may have
      // already done this but on a hard ws close we reach here without
      // going through deactivate. Idempotent.
      voiceFanoutBridge?.setInterjector(null);

      // Clean up presence (triggers deactivate if active)
      presence.close();
      wakeDetector?.close();
      wakeDetector = null;

      const cleanup = (async () => {
        // Drain in-flight transcript writes before finalizing
        await Promise.allSettled([...pendingWrites]);
        // Finalize session in store
        const sessionId = await sessionIdPromise;
        if (sessionId && store) {
          const cost = costTracker.getUpdate().estimatedCostUsd;
          await store.endSession(sessionId, cost);
        }
      })();

      pendingCleanups.add(cleanup);
      void cleanup.finally(() => pendingCleanups.delete(cleanup));

      cameraWatcher?.close();
      screenWatcher?.close();
    });
  });

  return wss;
}
