import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";

export const mcpRouter = Router();

// Store active MCP sessions
const sessions = new Map<string, StreamableHTTPServerTransport>();

// POST /mcp — handle MCP JSON-RPC requests
mcpRouter.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
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
    logger.debug({ sessionId }, "MCP session closed");
  }

  res.status(204).end();
});
