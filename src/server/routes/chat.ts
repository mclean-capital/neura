import { Router } from "express";
import { runAgent, runAgentStream } from "../../agent/core.js";
import {
  findOrCreateConversation,
  loadConversationMessages,
  saveUserMessage,
  saveAssistantMessages,
} from "../../db/conversations.js";
import { logger } from "../../lib/logger.js";

export const chatRouter = Router();

chatRouter.post("/chat", async (req, res) => {
  const { message, conversationId: incomingConvId } = req.body;
  const streamQuery = req.query.stream;
  const streamBody = req.body.stream;
  const stream = streamQuery !== undefined ? streamQuery === "true" : (streamBody ?? true);

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required and must be a string" });
    return;
  }

  const conversationId = await findOrCreateConversation({ conversationId: incomingConvId });
  const saved = await saveUserMessage(conversationId, message);
  const history = await loadConversationMessages(conversationId);

  // If saveUserMessage succeeded the current message is already in history.
  // If it failed, append unconditionally so the agent always sees it.
  const messages = saved
    ? history.length > 0
      ? history
      : [{ role: "user" as const, content: message }]
    : [...history, { role: "user" as const, content: message }];

  try {
    if (stream) {
      res.setHeader("X-Conversation-Id", conversationId);
      const result = await runAgentStream({
        messages,
        onFinish: (event) => {
          saveAssistantMessages(conversationId, event.response.messages).catch((err) => {
            logger.warn({ err }, "Failed to persist assistant messages after stream");
          });
        },
      });
      result.pipeTextStreamToResponse(res);
    } else {
      const result = await runAgent({ messages });
      await saveAssistantMessages(conversationId, result.response.messages);
      res.json({ response: result.text, conversationId });
    }
  } catch (err: any) {
    logger.error({ err, message: err?.message, stack: err?.stack }, "Chat error");
    res.status(500).json({
      error: "Failed to process message",
      detail: err?.message,
    });
  }
});
