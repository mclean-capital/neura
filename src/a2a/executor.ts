import { type ModelMessage } from "ai";
import { runAgent } from "../agent/core.js";
// runAgent uses generateText (non-streaming) — returns full result after all tool steps
import {
  findOrCreateConversation,
  loadConversationMessages,
  saveUserMessage,
  saveAssistantMessages,
} from "../db/conversations.js";
import { logger } from "../lib/logger.js";

export interface A2AMessage {
  role: string;
  parts: { type: string; text?: string }[];
}

export interface A2ATask {
  id: string;
  messages: A2AMessage[];
  status?: string;
}

/**
 * Execute an A2A task by bridging it to the agent core.
 * Converts A2A messages to CoreMessages, runs the agent, and returns the result.
 * Uses the A2A task ID as the conversation ID for persistence.
 */
export async function executeTask(task: A2ATask): Promise<{
  text: string;
  status: "completed" | "failed";
}> {
  try {
    const conversationId = await findOrCreateConversation({
      conversationId: task.id,
      metadata: { source: "a2a" },
    });

    // Extract text from A2A message parts and save as user messages
    const incomingMessages: ModelMessage[] = task.messages.map((m) => ({
      role: m.role === "agent" ? ("assistant" as const) : ("user" as const),
      content:
        m.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!)
          .join("\n") || "",
    }));

    // Save new user messages
    for (const msg of incomingMessages) {
      if (msg.role === "user") {
        await saveUserMessage(conversationId, msg.content as string);
      }
    }

    // Load full history for multi-turn context
    const history = await loadConversationMessages(conversationId);
    const messages = history.length > 0 ? history : incomingMessages;

    const result = await runAgent({ messages });
    await saveAssistantMessages(conversationId, result.response.messages);
    const text = result.text;

    return { text, status: "completed" };
  } catch (err) {
    logger.error(err, "A2A task execution failed");
    return { text: "Task execution failed", status: "failed" };
  }
}
