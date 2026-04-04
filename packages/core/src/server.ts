import 'dotenv/config';
import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, DataStore, VoiceProvider } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { createVoiceSession } from './voice-session.js';
import { createVisionWatcher } from './vision-watcher.js';
import { createCostTracker } from './cost-tracker.js';
import { loadConfig } from './config.js';
import { createMemoryManager, type MemoryManager } from './memory-manager.js';
import type { MemoryToolHandler } from './tools.js';

const log = new Logger('server');
const config = loadConfig();

const PORT = config.port;
const COST_UPDATE_INTERVAL_MS = 30_000;

// Make API keys available to providers that read process.env directly
if (config.xaiApiKey && !process.env.XAI_API_KEY) process.env.XAI_API_KEY = config.xaiApiKey;
if (config.googleApiKey && !process.env.GOOGLE_API_KEY)
  process.env.GOOGLE_API_KEY = config.googleApiKey;

// Initialize data store if DB path is available (optional — skip persistence if not configured)
let store: DataStore | null = null;
if (config.pgDataPath) {
  try {
    const { PgliteStore } = await import('./stores/index.js');
    store = await PgliteStore.create(config.pgDataPath);
    log.info('database initialized', { path: config.pgDataPath });
  } catch (err) {
    log.warn('database unavailable, persistence disabled', { err: String(err) });
  }
}

// Initialize memory manager if store and Google API key are available
let memoryManager: MemoryManager | null = null;
if (store && config.googleApiKey) {
  memoryManager = createMemoryManager({ store, googleApiKey: config.googleApiKey });
  log.info('memory manager initialized');
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const app = express();
const server = createServer(app);
let wss: WebSocketServer | null = null;
let actualPort = PORT;

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    port: actualPort,
  });
});

// Serve web UI from ~/.neura/ui/ if it exists (optional static mount)
const uiDir = join(config.neuraHome, 'ui');
const uiAvailable = existsSync(join(uiDir, 'index.html'));
if (uiAvailable) {
  app.use(express.static(uiDir));
  log.info('web UI mounted', { path: uiDir });
}

// IMPORTANT: This catch-all MUST be the last route registered.
// Any GET route added after this will be shadowed.
app.get('*', (_req, res) => {
  if (uiAvailable) {
    res.sendFile(join(uiDir, 'index.html'));
  } else {
    res.json({
      name: 'Neura Core',
      status: 'running',
      ws: `ws://localhost:${actualPort}/ws`,
      health: '/health',
      ui: 'not installed — run `neura update` then `neura restart`',
    });
  }
});

// Track in-flight session finalization promises so shutdown can await them
const pendingCleanups = new Set<Promise<void>>();

function attachWebSocket() {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    log.info('client connected');

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
    const costTracker = createCostTracker();

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
        }
      : undefined;

    // Voice session is created after the memory prompt resolves.
    // Message handlers use a guard (if !session) for the brief gap.
    let session: VoiceProvider | null = null;
    let connectionClosed = false;

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

    // Build system prompt then create voice session
    const promptPromise = memoryManager
      ? memoryManager.buildSystemPrompt().catch((err) => {
          log.warn('memory prompt build failed', { err: String(err) });
          return undefined;
        })
      : Promise.resolve(undefined);

    void promptPromise.then((systemPromptPrefix) => {
      if (connectionClosed) return; // WS closed before prompt resolved
      session = createVoiceSession(voiceCallbacks, {
        systemPromptPrefix,
        memoryTools,
      });
      costTracker.startInterval(send, COST_UPDATE_INTERVAL_MS);
      session.connect();
      resetIdleTimer();
    });

    ws.on('message', (raw: Buffer) => {
      resetIdleTimer();
      extractionTriggered = false; // Allow re-extraction if new content arrives after idle extraction
      if (!session) return; // Voice session not ready yet
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        switch (msg.type) {
          case 'audio':
            session.sendAudio(msg.data);
            break;
          case 'text':
            session.sendText(msg.text);
            break;
          case 'videoFrame': {
            const watcher = getOrCreateWatcher(msg.source);
            watcher.sendFrame(msg.data);
            break;
          }
          case 'sourceChanged':
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
        }
      } catch (err) {
        log.error('bad message', { err: String(err) });
      }
    });

    ws.on('close', () => {
      log.info('client disconnected');
      connectionClosed = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      costTracker.stopInterval();

      // Trigger extraction if not already triggered by idle timer
      triggerExtraction();

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

      session?.close();
      cameraWatcher?.close();
      screenWatcher?.close();
    });
  });
}

function startServer(port: number, maxRetries = 10) {
  // Remove stale listeners from previous retry — server.listen() registers
  // a once('listening') handler each call, and they all fire when one succeeds
  server.removeAllListeners('listening');
  server.removeAllListeners('error');

  server.once('listening', () => {
    actualPort = port;
    attachWebSocket();
    process.stdout.write(`NEURA_PORT=${port}\n`);
    log.info(`Neura core server at http://localhost:${port}`);
  });

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && maxRetries > 0) {
      log.warn(`port ${port} in use, trying ${port + 1}`);
      startServer(port + 1, maxRetries - 1);
    } else {
      log.error('server failed to start', { err: err.message });
      process.exit(1);
    }
  });

  server.listen(port);
}

startServer(PORT);

async function shutdown() {
  log.info('shutting down');
  // Force exit if graceful shutdown hangs (e.g. client doesn't disconnect)
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  // Close WSS first — triggers ws 'close' handlers which finalize sessions in store.
  // Then await all in-flight session cleanups before closing the store.
  if (wss) {
    wss.close(() => {
      void (async () => {
        await Promise.allSettled([...pendingCleanups]);
        await memoryManager?.close();
        await store?.close();
        server.close(() => process.exit(0));
      })();
    });
  } else {
    await memoryManager?.close();
    await store?.close();
    server.close(() => process.exit(0));
  }
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
