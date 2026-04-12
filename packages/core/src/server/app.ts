import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Logger } from '@neura/utils/logger';
import { verifyToken } from './auth.js';
import type { CoreServices } from './lifecycle.js';

const log = new Logger('server');

export function createApp(services: CoreServices, getPort: () => number): express.Express {
  const app = express();
  const { authToken } = services.config;

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      port: getPort(),
      version: services.version,
    });
  });

  // Auth middleware for sensitive endpoints — skipped if no token configured (dev mode)
  function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void {
    if (!authToken) {
      next();
      return;
    }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token || !verifyToken(token, authToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }

  // Serve web UI — check the bundled UI first (shipped inside the CLI npm
  // package as a sibling of core/), then fall back to ~/.neura/ui/ for dev
  // mode where the bundle doesn't exist. Bundled-first ensures upgrades
  // always serve the UI version that matches the core, rather than being
  // shadowed by stale assets left in ~/.neura/ui/ from a previous release.
  //
  // In the production bundle, import.meta.url resolves to
  //   <cli-pkg>/core/server.bundled.mjs
  // so ../ui/ resolves to <cli-pkg>/ui/ where the built React app lives.
  let uiDir = '';
  try {
    const bundleDir = dirname(fileURLToPath(import.meta.url));
    const bundledUiDir = join(bundleDir, '..', 'ui');
    if (existsSync(join(bundledUiDir, 'index.html'))) {
      uiDir = bundledUiDir;
    }
  } catch {
    // import.meta.url resolution failed (e.g. CJS context) — skip
  }
  if (!uiDir) {
    const homeUiDir = join(services.config.neuraHome, 'ui');
    if (existsSync(join(homeUiDir, 'index.html'))) {
      uiDir = homeUiDir;
    }
  }
  if (uiDir) {
    app.use(express.static(uiDir));
    log.info('web UI mounted', { path: uiDir });
  }

  app.post('/backup', requireAuth, (_req, res) => {
    if (!services.backupService) {
      res.status(503).json({ error: 'backup not available (no store)' });
      return;
    }
    void services.backupService
      .backup()
      .then(() => res.json({ status: 'ok', path: services.backupService!.backupPath }))
      .catch((err) => res.status(500).json({ error: String(err) }));
  });

  app.post('/restore', requireAuth, (_req, res) => {
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
    if (uiDir) {
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
