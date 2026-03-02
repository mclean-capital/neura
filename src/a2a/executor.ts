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

    // Extract the latest user turn from A2A message parts.
    // A2A is turn-based: each tasks/send contributes one new user message
    // (the last user entry). Prior turns are already persisted from earlier requests,
    // so we only save the current turn — this works for both full-history and
    // incremental clients without the count-based dedup issues of syncMessages.
    const lastUserParts = [...task.messages].reverse().find((m) => m.role === "user");
    const lastUserContent =
      lastUserParts?.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n") ?? "";

    if (!lastUserContent) {
      return { text: "No user message provided", status: "failed" };
    }

    // Save the current turn and use the saved flag to guarantee it reaches the agent
    const saved = await saveUserMessage(conversationId, lastUserContent);
    const history = await loadConversationMessages(conversationId);
    const messages = saved
      ? history.length > 0
        ? history
        : [{ role: "user" as const, content: lastUserContent }]
      : [...history, { role: "user" as const, content: lastUserContent }];

    const result = await runAgent({ messages });
    await saveAssistantMessages(conversationId, result.response.messages);
    const text = result.text;

    return { text, status: "completed" };
  } catch (err) {
    logger.error(err, "A2A task execution failed");
    return { text: "Task execution failed", status: "failed" };
  }
}
