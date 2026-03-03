import { Router } from "express";
import { checkConnection } from "../../db/connection.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  const dbHealthy = await checkConnection();
  const status = dbHealthy ? "healthy" : "degraded";
  res.status(dbHealthy ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy ? "connected" : "disconnected",
    },
  });
});
