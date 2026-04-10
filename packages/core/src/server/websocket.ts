import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { URL } from 'url';
import type { ClientMessage, ServerMessage, VoiceProvider } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { createVoiceSession } from '../providers/voice-session.js';
import { createVisionWatcher } from '../providers/vision-watcher.js';
import { CostTracker } from '../cost/index.js';
import type { MemoryToolHandler, TaskToolHandler } from '../tools/index.js';
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
  const { store, memoryManager, config, connectedClients, pendingCleanups } = services;
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
    const sessionIdPromise: Promise<string | null> = store
      ? store.createSession('grok', 'gemini').catch((err) => {
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

      const watcher = createVisionWatcher({ label: source });
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

    // Build task tools handler (closes over store)
    const taskTools: TaskToolHandler | undefined = store
      ? {
          createTask: (title, priority, opts) =>
            store.createWorkItem(title, priority as 'low' | 'medium' | 'high', opts),
          listTasks: async (status) => {
            if (!status) return store.getOpenWorkItems(100);
            return store.getWorkItems({ status, limit: 100 });
          },
          getTask: async (idOrTitle) => {
            const byId = await store.getWorkItem(idOrTitle);
            if (byId) return byId;
            // Fall back to title substring match across all items
            const all = await store.getWorkItems({ limit: 200 });
            const lower = idOrTitle.toLowerCase();
            return all.find((t) => t.title.toLowerCase().includes(lower)) ?? null;
          },
          updateTask: async (idOrTitle, updates) => {
            let id = idOrTitle;
            const byId = await store.getWorkItem(idOrTitle);
            if (!byId) {
              const all = await store.getWorkItems({ limit: 200 });
              const lower = idOrTitle.toLowerCase();
              const match = all.find((t) => t.title.toLowerCase().includes(lower));
              if (!match) return false;
              id = match.id;
            }
            await store.updateWorkItem(
              id,
              updates as Partial<
                Pick<
                  import('@neura/types').WorkItemEntry,
                  'status' | 'priority' | 'title' | 'description' | 'dueAt'
                >
              >
            );
            return true;
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
        // Grok session is configured — seed the wake transcript if available
        if (pendingWakeAudio) {
          const chunks = pendingWakeAudio;
          pendingWakeAudio = null;
          // Replay buffered audio so Grok hears the original wake speech
          for (const chunk of chunks) {
            session?.sendAudio(chunk);
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

    async function activateVoiceSession(wakeTranscript: string) {
      if (connectionClosed || session) return;
      log.info('activating voice session', { wakeTranscript });

      // Reset extraction flag so this active session gets its own extraction
      extractionTriggered = false;

      // Stop wake detector while active
      wakeDetector?.close();
      wakeDetector = null;

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

      // Re-check state after async gap — may have gone passive/idle during await
      if (connectionClosed || presence.state !== 'active') return;

      session = createVoiceSession(voiceCallbacks, {
        systemPromptPrefix,
        memoryTools,
        enterMode: (mode) => presence.enterMode(mode),
        taskTools,
      });
      costTracker.startInterval(send, COST_UPDATE_INTERVAL_MS);
      session.connect();
      resetIdleTimer();
    }

    function deactivateVoiceSession() {
      log.info('deactivating voice session');
      pendingWakeAudio = null;
      costTracker.stopInterval();
      triggerExtraction();

      session?.close();
      session = null;

      // Resume wake word detection
      void startWakeDetector();
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
      onStateChange: (state) => send({ type: 'presenceState', state }),
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
            if (presence.state === 'active' && session) {
              // Active: forward audio to Grok
              resetIdleTimer();
              presence.resetIdleTimer();
              extractionTriggered = false;
              session.sendAudio(msg.data);
            } else if (presence.state === 'passive') {
              if (wakeDetector) {
                wakeDetector.feedAudio(msg.data);
              } else {
                log.debug('audio received but no wake detector');
              }
            }
            break;
          case 'text':
            if (presence.state === 'active' && session) {
              resetIdleTimer();
              extractionTriggered = false;
              session.sendText(msg.text);
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
