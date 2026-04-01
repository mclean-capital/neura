import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, DataStore } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { createVoiceSession } from './voice-session.js';
import { createVisionWatcher } from './vision-watcher.js';
import { createCostTracker } from './cost-tracker.js';

const log = new Logger('server');

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const COST_UPDATE_INTERVAL_MS = 30_000;

// Initialize data store if DB_PATH is set (optional — skip persistence if not configured)
let store: DataStore | null = null;
const dbPath = process.env.DB_PATH;
if (dbPath) {
  try {
    const { SqliteStore } = await import('./stores/index.js');
    store = await SqliteStore.create(dbPath);
    log.info('database initialized', { path: dbPath });
  } catch (err) {
    log.warn('database unavailable, persistence disabled', { err: String(err) });
  }
}

const app = express();
const server = createServer(app);
let wss: WebSocketServer | null = null;

function attachWebSocket() {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    log.info('client connected');

    const sessionId = store?.createSession('grok', 'gemini') ?? null;

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

    const session = createVoiceSession({
      onAudio(data) {
        send({ type: 'audio', data });
      },
      onInputTranscript(text) {
        send({ type: 'inputTranscript', text });
        if (sessionId && store) store.appendTranscript(sessionId, 'user', text);
      },
      onOutputTranscript(text) {
        send({ type: 'outputTranscript', text });
      },
      onOutputTranscriptComplete(text) {
        if (sessionId && store) store.appendTranscript(sessionId, 'assistant', text);
      },
      onInterrupted() {
        send({ type: 'interrupted' });
      },
      onTurnComplete() {
        send({ type: 'turnComplete' });
      },
      onToolCall(name, args) {
        send({ type: 'toolCall', name, args });
      },
      onToolResult(name, result) {
        send({ type: 'toolResult', name, result });
      },
      onError(error) {
        send({ type: 'error', error });
      },
      onClose() {
        send({ type: 'sessionClosed' });
      },
      onReconnected() {
        // Re-send active source state so the new Grok session knows what's available
        if (cameraWatcher?.isConnected()) {
          session.sendSystemEvent(
            'The user is currently sharing their camera. You can use the describe_camera tool to see it.'
          );
        }
        if (screenWatcher?.isConnected()) {
          session.sendSystemEvent(
            'The user is currently sharing their screen. You can use the describe_screen tool to see it.'
          );
        }
      },
      queryWatcher(prompt, source) {
        const watcher = source === 'camera' ? cameraWatcher : screenWatcher;
        if (!watcher) {
          return Promise.resolve(`${source} not active — user hasn't shared their ${source}.`);
        }
        return watcher.query(prompt);
      },
    });

    function send(msg: ServerMessage) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    ws.on('message', (raw: Buffer) => {
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
              // Close existing watcher first (fresh session = no stale frames)
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
      costTracker.stopInterval();

      // Finalize session in store
      if (sessionId && store) {
        const cost = costTracker.getUpdate().estimatedCostUsd;
        store.endSession(sessionId, cost);
      }

      session.close();
      cameraWatcher?.close();
      screenWatcher?.close();
    });

    costTracker.startInterval(send, COST_UPDATE_INTERVAL_MS);
    session.connect();
  });
}

function startServer(port: number, maxRetries = 10) {
  server.listen(port, () => {
    // Attach WebSocket server only after HTTP server is listening
    attachWebSocket();
    // Structured marker for core-manager to parse the actual port
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
}

startServer(PORT);

function shutdown() {
  log.info('shutting down');
  // Close WSS first — triggers ws 'close' handlers which finalize sessions in store
  if (wss) {
    wss.close(() => {
      store?.close();
      server.close(() => process.exit(0));
    });
  } else {
    store?.close();
    server.close(() => process.exit(0));
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
