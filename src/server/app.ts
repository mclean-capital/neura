import express from "express";
import type { Request, Response, NextFunction } from "express";
import { healthRouter } from "./routes/health.js";
import { chatRouter } from "./routes/chat.js";
import { a2aRouter } from "../a2a/handler.js";
import { mcpRouter } from "../mcp/transport.js";
import { logger } from "../lib/logger.js";

export function createApp() {
  const app = express();

  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(chatRouter);
  app.use(a2aRouter);
  app.use(mcpRouter);

  // Error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, message: err?.message, stack: err?.stack }, "Unhandled error");
    res.status(500).json({ error: "Internal server error", detail: err?.message });
  });

  return app;
}
