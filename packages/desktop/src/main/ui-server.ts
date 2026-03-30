import express from 'express';
import { createServer, type Server } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { app } from 'electron';

interface UIServerOptions {
  corePort: number;
}

function getRendererDistPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'renderer');
  }
  return path.join(__dirname, '..', 'dist-renderer');
}

export function createUIServer(opts: UIServerOptions) {
  let server: Server | null = null;

  function start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const ex = express();

      // Security headers
      ex.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        next();
      });

      // Proxy /ws to core WebSocket server
      const wsProxy = createProxyMiddleware({
        target: `http://127.0.0.1:${opts.corePort}`,
        ws: true,
        changeOrigin: true,
      });
      ex.use('/ws', wsProxy);

      // Serve UI static files
      const distPath = getRendererDistPath();
      ex.use(express.static(distPath));

      // SPA fallback
      ex.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });

      server = createServer(ex);
      // Explicit upgrade handler required for WebSocket proxying in http-proxy-middleware v3
      server.on('upgrade', wsProxy.upgrade);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        console.log(`[ui-server] serving on port ${port}`);
        resolve(port);
      });
    });
  }

  function stop() {
    server?.close();
    server = null;
  }

  return { start, stop };
}
