import { existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { WebSocket } from 'ws';
import type { ServerMessage, DataStore, VoiceProvider } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import { loadConfig } from '../config/index.js';
import { MemoryManager } from '../memory/index.js';
import { BackupService } from '../memory/index.js';
import type { PresenceManager } from '../presence/index.js';
import { DiscoveryLoop } from '../discovery/index.js';
import type { Server } from 'http';
import type { WebSocketServer } from 'ws';

const log = new Logger('server');

export interface CoreServices {
  config: ReturnType<typeof loadConfig>;
  store: DataStore | null;
  memoryManager: MemoryManager | null;
  backupService: BackupService | null;
  discoveryLoop: DiscoveryLoop | null;
  connectedClients: Map<
    WebSocket,
    {
      send: (msg: ServerMessage) => void;
      presence: PresenceManager;
      getSession: () => VoiceProvider | null;
    }
  >;
  version: string;
  pendingCleanups: Set<Promise<void>>;
}

function resolveVersion(neuraHome: string): string {
  if (process.env.NEURA_VERSION) return process.env.NEURA_VERSION;
  try {
    const versionPath = join(neuraHome, 'core', 'version.txt');
    return readFileSync(versionPath, 'utf-8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

export async function initServices(): Promise<CoreServices> {
  const config = loadConfig();
  const version = resolveVersion(config.neuraHome);

  // Make API keys available to providers that read process.env directly
  if (config.xaiApiKey && !process.env.XAI_API_KEY) process.env.XAI_API_KEY = config.xaiApiKey;
  if (config.googleApiKey && !process.env.GOOGLE_API_KEY)
    process.env.GOOGLE_API_KEY = config.googleApiKey;

  // Initialize data store if DB path is available (optional — skip persistence if not configured).
  // PGlite (WASM Postgres) can corrupt on dirty shutdown (force kill, crash). If the database
  // fails to open, delete the data directory and retry with a fresh database, then restore
  // memories from the periodic backup file.
  let store: DataStore | null = null;
  const backupPath = join(config.neuraHome, 'memory-backup.json');

  if (config.pgDataPath) {
    // Clean stale postmaster.pid from a previous dirty shutdown
    const pidPath = join(config.pgDataPath, 'postmaster.pid');
    if (existsSync(pidPath)) {
      log.warn('removing stale postmaster.pid');
      unlinkSync(pidPath);
    }

    try {
      const { PgliteStore } = await import('../stores/index.js');
      store = await PgliteStore.create(config.pgDataPath);
      log.info('database initialized', { path: config.pgDataPath });
    } catch (err) {
      log.warn('database corrupt or failed to open, resetting', { err: String(err) });
      try {
        rmSync(config.pgDataPath, { recursive: true, force: true });
        const { PgliteStore } = await import('../stores/index.js');
        store = await PgliteStore.create(config.pgDataPath);
        log.info('database recreated after reset', { path: config.pgDataPath });

        // Auto-restore memories from backup after corruption recovery
        if (existsSync(backupPath)) {
          const bs = new BackupService({ store, backupPath });
          const result = await bs.restore();
          if (result) {
            log.info('memories restored from backup after corruption', result);
          }
        }
      } catch (retryErr) {
        log.warn('database unavailable after reset, persistence disabled', {
          err: String(retryErr),
        });
      }
    }
  }

  // Initialize memory manager if store and Google API key are available
  let memoryManager: MemoryManager | null = null;
  let backupService: BackupService | null = null;

  if (store && config.googleApiKey) {
    memoryManager = new MemoryManager({
      store,
      googleApiKey: config.googleApiKey,
      onExtractionComplete: () => backupService?.backup() ?? Promise.resolve(),
      retrievalStrategy: config.retrievalStrategy,
    });
    log.info('memory manager initialized');
  }

  // Start periodic memory backup
  if (store) {
    backupService = new BackupService({ store, backupPath });
    backupService.checkStaleness();
    backupService.start();
  }

  // Connected clients registry — discovery loop uses this to deliver notifications
  const connectedClients = new Map<
    WebSocket,
    {
      send: (msg: ServerMessage) => void;
      presence: PresenceManager;
      getSession: () => VoiceProvider | null;
    }
  >();

  // Discovery loop — reviews open tasks, checks deadlines, notifies clients
  let discoveryLoop: DiscoveryLoop | null = null;
  if (store && config.googleApiKey) {
    discoveryLoop = new DiscoveryLoop({
      store,
      googleApiKey: config.googleApiKey,
      onNotifications: (summary, items) => {
        for (const [, client] of connectedClients) {
          if (client.presence.state === 'active') {
            const session = client.getSession();
            if (session) {
              session.sendText(`Task reminder: ${summary}`);
            }
          } else if (client.presence.state === 'passive') {
            client.send({ type: 'discoveryNotification', summary, items });
          }
        }
      },
    });
    discoveryLoop.start();
  }

  const pendingCleanups = new Set<Promise<void>>();

  return {
    config,
    store,
    memoryManager,
    backupService,
    discoveryLoop,
    connectedClients,
    version,
    pendingCleanups,
  };
}

export async function shutdown(
  services: CoreServices,
  httpServer: Server,
  wss: WebSocketServer | null
): Promise<void> {
  log.info('shutting down');
  // Force exit if graceful shutdown hangs (e.g. client doesn't disconnect)
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();

  services.discoveryLoop?.stop();
  services.backupService?.stop();

  // Close WSS first — triggers ws 'close' handlers which finalize sessions in store.
  // Then await all in-flight session cleanups before closing the store.
  if (wss) {
    wss.close(() => {
      void (async () => {
        await Promise.allSettled([...services.pendingCleanups]);
        await services.memoryManager?.close();
        await services.backupService
          ?.backup()
          .catch((err) => log.warn('final backup failed', { err: String(err) }));
        await services.store?.close();
        httpServer.close(() => process.exit(0));
      })();
    });
  } else {
    await services.memoryManager?.close();
    await services.backupService
      ?.backup()
      .catch((err) => log.warn('final backup failed', { err: String(err) }));
    await services.store?.close();
    httpServer.close(() => process.exit(0));
  }
}
