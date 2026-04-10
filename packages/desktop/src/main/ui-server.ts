import express from 'express';
import { createServer, type Server } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { app } from 'electron';

interface UIServerOptions {
  corePort: number;
  authToken?: string;
}

function getRendererDistPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'renderer');
  }
  return path.join(__dirname, '..', 'dist-renderer');
}

export class UIServer {
  private server: Server | null = null;
  private readonly corePort: number;

  private readonly authToken: string | undefined;

  constructor(opts: UIServerOptions) {
    this.corePort = opts.corePort;
    this.authToken = opts.authToken;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const ex = express();

      // Security headers
      ex.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        next();
      });

      // Proxy /ws to core WebSocket server (forward auth token)
      const tokenQuery = this.authToken ? `?token=${encodeURIComponent(this.authToken)}` : '';
      const wsProxy = createProxyMiddleware({
        target: `http://127.0.0.1:${this.corePort}`,
        ws: true,
        changeOrigin: true,
        pathRewrite: { '^/ws': `/ws${tokenQuery}` },
      });
      ex.use('/ws', wsProxy);

      // Serve UI static files
      const distPath = getRendererDistPath();
      ex.use(express.static(distPath));

      // SPA fallback
      ex.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });

      this.server = createServer(ex);
      // Explicit upgrade handler required for WebSocket proxying in http-proxy-middleware v3
      this.server.on('upgrade', wsProxy.upgrade);
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        console.log(`[ui-server] serving on port ${port}`);
        resolve(port);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
