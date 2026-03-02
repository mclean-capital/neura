import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { type ModelMessage } from "ai";
import { runAgent, runAgentStream } from "../../agent/core.js";
import { query } from "../../db/connection.js";
import {
  findOrCreateConversation,
  syncMessages,
  saveAssistantMessages,
} from "../../db/conversations.js";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";

export const openaiRouter = Router();

// Auth middleware — only enforced when API_KEY is set
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!env.API_KEY) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({
      error: { message: "Missing API key", type: "invalid_request_error", code: "invalid_api_key" },
    });
    return;
  }

  const token = auth.slice(7);
  if (token !== env.API_KEY) {
    res.status(401).json({
      error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" },
    });
    return;
  }

  next();
}

openaiRouter.use("/v1", requireApiKey);

// GET /v1/models
openaiRouter.get("/v1/models", async (_req, res) => {
  let models: { id: string; created: number }[] = [];

  try {
    const result = await query<{ slug: string; created_at: Date }>(
      "SELECT slug, created_at FROM agents WHERE enabled = true ORDER BY slug",
    );
    models = result.rows.map((row) => ({
      id: row.slug,
      created: Math.floor(new Date(row.created_at).getTime() / 1000),
    }));
  } catch {
    models = [{ id: "neura", created: Math.floor(Date.now() / 1000) }];
  }

  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: "neura",
    })),
  });
});

function generateChatId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function toModelMessages(messages: { role: string; content: string }[]): ModelMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

function toOpenAIFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

// POST /v1/chat/completions
openaiRouter.post("/v1/chat/completions", async (req, res) => {
  const { model, messages, stream = false } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({
      error: {
        message: "messages is required and must be an array",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
    return;
  }

  const agentSlug = model ?? undefined;
  const modelMessages = toModelMessages(messages);
  const chatId = generateChatId();
  const created = Math.floor(Date.now() / 1000);

  // Conversation persistence — derive ID from header or create new
  const incomingConvId = req.headers["x-conversation-id"] as string | undefined;
  const conversationId = await findOrCreateConversation({
    conversationId: incomingConvId,
    agentSlug: agentSlug ?? "neura",
    metadata: { source: "openai" },
  });
  res.setHeader("X-Conversation-Id", conversationId);
  await syncMessages(conversationId, messages);

  try {
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const modelName = agentSlug ?? "neura";

      // Initial chunk with role
      const initialChunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

      const result = await runAgentStream({
        messages: modelMessages,
        agentSlug,
        onFinish: (event) => {
          saveAssistantMessages(conversationId, event.response.messages).catch((err) => {
            logger.warn({ err }, "Failed to persist assistant messages after stream");
          });
        },
      });

      for await (const textPart of result.textStream) {
        const chunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: { content: textPart }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Final chunk + terminator
      const finalChunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const result = await runAgent({ messages: modelMessages, agentSlug });
      await saveAssistantMessages(conversationId, result.response.messages);

      res.json({
        id: chatId,
        object: "chat.completion",
        created,
        model: agentSlug ?? "neura",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.text ?? "" },
            finish_reason: toOpenAIFinishReason(result.finishReason),
          },
        ],
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
          total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        },
      });
    }
  } catch (err: any) {
    logger.error({ err, message: err?.message, stack: err?.stack }, "OpenAI compat error");
    res.status(500).json({
      error: {
        message: err?.message ?? "Internal server error",
        type: "server_error",
        code: "internal_error",
      },
    });
  }
});
