import { Router } from "express";
import { getAgentCard } from "./agent-card.js";
import { executeTask } from "./executor.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";

export const a2aRouter = Router();

// Agent Card discovery
a2aRouter.get("/.well-known/agent-card.json", (_req, res) => {
  res.json(getAgentCard());
});

// A2A JSON-RPC endpoint
a2aRouter.post("/a2a", async (req, res) => {
  const { method, params, id: rpcId } = req.body;

  if (!method) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid request: missing method" },
      id: rpcId ?? null,
    });
    return;
  }

  try {
    switch (method) {
      case "tasks/send": {
        const taskId = params?.id ?? randomUUID();
        const messages = params?.messages ?? [];

        const result = await executeTask({
          id: taskId,
          messages,
        });

        res.json({
          jsonrpc: "2.0",
          result: {
            id: taskId,
            status: { state: result.status },
            messages: [
              ...messages,
              {
                role: "agent",
                parts: [{ type: "text", text: result.text }],
              },
            ],
          },
          id: rpcId,
        });
        break;
      }

      case "tasks/get": {
        // Stateless for MVP — no task persistence
        res.json({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Task persistence not implemented in MVP",
          },
          id: rpcId,
        });
        break;
      }

      case "tasks/cancel": {
        res.json({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Task cancellation not implemented in MVP",
          },
          id: rpcId,
        });
        break;
      }

      default:
        res.json({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
          id: rpcId,
        });
    }
  } catch (err) {
    logger.error(err, "A2A handler error");
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: rpcId ?? null,
    });
  }
});
