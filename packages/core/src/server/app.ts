import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { Logger } from '@neura/utils/logger';
import type { CoreServices } from './lifecycle.js';

const log = new Logger('server');

export function createApp(services: CoreServices, getPort: () => number): express.Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      port: getPort(),
      version: services.version,
    });
  });

  // Serve web UI from ~/.neura/ui/ if it exists (optional static mount)
  const uiDir = join(services.config.neuraHome, 'ui');
  const uiAvailable = existsSync(join(uiDir, 'index.html'));
  if (uiAvailable) {
    app.use(express.static(uiDir));
    log.info('web UI mounted', { path: uiDir });
  }

  app.post('/backup', (_req, res) => {
    if (!services.backupService) {
      res.status(503).json({ error: 'backup not available (no store)' });
      return;
    }
    void services.backupService
      .backup()
      .then(() => res.json({ status: 'ok', path: services.backupService!.backupPath }))
      .catch((err) => res.status(500).json({ error: String(err) }));
  });

  app.post('/restore', (_req, res) => {
    if (!services.backupService) {
      res.status(503).json({ error: 'backup not available (no store)' });
      return;
    }
    void services.backupService
      .restore()
      .then((result) => res.json({ status: 'ok', ...result }))
      .catch((err) => res.status(500).json({ error: String(err) }));
  });

  // IMPORTANT: This catch-all MUST be the last route registered.
  // Any GET route added after this will be shadowed.
  app.get('*', (_req, res) => {
    if (uiAvailable) {
      res.sendFile(join(uiDir, 'index.html'));
    } else {
      res.json({
        name: 'Neura Core',
        status: 'running',
        ws: `ws://localhost:${getPort()}/ws`,
        health: '/health',
        ui: 'not installed — run `neura update` then `neura restart`',
      });
    }
  });

  return app;
}
