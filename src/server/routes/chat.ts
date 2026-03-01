import { Router } from "express";
import { type ModelMessage } from "ai";
import { runAgent, runAgentStream } from "../../agent/core.js";
import { logger } from "../../lib/logger.js";

export const chatRouter = Router();

chatRouter.post("/chat", async (req, res) => {
  const { message } = req.body;
  const streamQuery = req.query.stream;
  const streamBody = req.body.stream;
  const stream = streamQuery !== undefined ? streamQuery === "true" : (streamBody ?? true);

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required and must be a string" });
    return;
  }

  const messages: ModelMessage[] = [{ role: "user", content: message }];

  try {
    if (stream) {
      const result = await runAgentStream({ messages });
      result.pipeTextStreamToResponse(res);
    } else {
      const result = await runAgent({ messages });
      res.json({ response: result.text });
    }
  } catch (err: any) {
    logger.error({ err, message: err?.message, stack: err?.stack }, "Chat error");
    res.status(500).json({
      error: "Failed to process message",
      detail: err?.message,
    });
  }
});
