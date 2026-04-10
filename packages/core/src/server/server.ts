import 'dotenv/config';
import { createServer } from 'http';
import type { WebSocketServer } from 'ws';
import { Logger } from '@neura/utils/logger';
import { initServices, shutdown } from './lifecycle.js';
import { createApp } from './app.js';
import { attachWebSocket } from './websocket.js';

const log = new Logger('server');

const services = await initServices();
let actualPort = services.config.port;
const app = createApp(services, () => actualPort);
const httpServer = createServer(app);
let wss: WebSocketServer | null = null;

function startServer(port: number, maxRetries = 10) {
  // Remove stale listeners from previous retry — server.listen() registers
  // a once('listening') handler each call, and they all fire when one succeeds
  httpServer.removeAllListeners('listening');
  httpServer.removeAllListeners('error');

  httpServer.once('listening', () => {
    actualPort = port;
    wss = attachWebSocket(httpServer, services);
    process.stdout.write(`NEURA_PORT=${port}\n`);
    log.info(`Neura core server at http://localhost:${port}`);
  });

  httpServer.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && maxRetries > 0) {
      log.warn(`port ${port} in use, trying ${port + 1}`);
      startServer(port + 1, maxRetries - 1);
    } else {
      log.error('server failed to start', { err: err.message });
      process.exit(1);
    }
  });

  httpServer.listen(port, 'localhost');
}

startServer(services.config.port);

// Shutdown handlers
const doShutdown = () => void shutdown(services, httpServer, wss);
process.on('SIGTERM', doShutdown);
process.on('SIGINT', doShutdown);
process.on('uncaughtException', (err) => {
  log.error('uncaught exception, shutting down', { err: err.message });
  doShutdown();
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection, shutting down', { err: String(reason) });
  doShutdown();
});
