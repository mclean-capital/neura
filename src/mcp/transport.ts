import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";

export const mcpRouter = Router();

// Store active MCP sessions and their last activity timestamps
const sessions = new Map<string, StreamableHTTPServerTransport>();
const lastActivity = new Map<string, number>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Evict idle sessions every 60 seconds
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of lastActivity) {
    if (now - ts > SESSION_TTL_MS) {
      const transport = sessions.get(sid);
      if (transport) {
        transport.close().catch((err) => {
          logger.warn({ err, sessionId: sid }, "Error closing idle MCP session");
        });
      }
      sessions.delete(sid);
      lastActivity.delete(sid);
      logger.debug({ sessionId: sid }, "MCP session evicted (idle timeout)");
    }
  }
}, 60_000);
cleanupInterval.unref();

// POST /mcp — handle MCP JSON-RPC requests
mcpRouter.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
    lastActivity.set(sessionId, Date.now());
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMcpServer();
  await server.connect(transport);

  // Track session
  const sid = transport.sessionId;
  if (sid) {
    sessions.set(sid, transport);
    lastActivity.set(sid, Date.now());
    logger.debug({ sessionId: sid }, "MCP session created");
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE stream for MCP notifications
mcpRouter.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "MCP session not found" });
    return;
  }

  lastActivity.set(sessionId, Date.now());
  const transport = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — close MCP session
mcpRouter.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.close();
    sessions.delete(sessionId);
    lastActivity.delete(sessionId);
    logger.debug({ sessionId }, "MCP session closed");
  }

  res.status(204).end();
});
