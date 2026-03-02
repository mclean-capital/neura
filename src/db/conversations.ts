import { randomUUID } from "node:crypto";
import { type ModelMessage } from "ai";
import { query } from "./connection.js";
import { logger } from "../lib/logger.js";

/** Matches AI SDK ResponseMessage shape — the type isn't exported directly. */
interface ResponseMessage {
  role: string;
  content: unknown;
}

/**
 * Find an existing conversation or create a new one.
 * Returns the conversation ID (existing or newly generated).
 */
export async function findOrCreateConversation(opts?: {
  conversationId?: string;
  agentSlug?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = opts?.conversationId ?? randomUUID();

  try {
    // Check if conversation already exists
    if (opts?.conversationId) {
      const existing = await query<{ id: string }>("SELECT id FROM conversations WHERE id = $1", [
        opts.conversationId,
      ]);
      if (existing.rows.length > 0) {
        return existing.rows[0].id;
      }
    }

    // Create new conversation — resolve agent slug to ID via subquery
    await query(
      `INSERT INTO conversations (id, agent_id, title, metadata)
       VALUES ($1, (SELECT id FROM agents WHERE slug = $2 LIMIT 1), $3, $4)`,
      [id, opts?.agentSlug ?? "neura", opts?.title ?? null, JSON.stringify(opts?.metadata ?? {})],
    );

    return id;
  } catch (err) {
    logger.warn({ err }, "Failed to find/create conversation — continuing without persistence");
    return id;
  }
}

/**
 * Load conversation messages from the DB, returning only user and assistant
 * roles as ModelMessage[]. Tool messages are stored for audit but skipped here
 * to avoid confusing the agent on replay.
 */
export async function loadConversationMessages(conversationId: string): Promise<ModelMessage[]> {
  try {
    const result = await query<{ role: string; content: string }>(
      `SELECT role, content FROM messages
       WHERE conversation_id = $1 AND role IN ('user', 'assistant')
       ORDER BY created_at ASC`,
      [conversationId],
    );

    return result.rows.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content ?? "",
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to load conversation messages — starting fresh");
    return [];
  }
}

/**
 * Persist a single user message. Returns true if the write succeeded.
 */
export async function saveUserMessage(conversationId: string, content: string): Promise<boolean> {
  try {
    await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, [
      conversationId,
      content,
    ]);
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to save user message");
    return false;
  }
}

/**
 * Persist assistant response messages from AI SDK's ResponseMessage[].
 * Extracts text content and tool call data from the structured message parts.
 */
export async function saveAssistantMessages(
  conversationId: string,
  responseMessages: ResponseMessage[],
): Promise<void> {
  try {
    for (const msg of responseMessages) {
      if (msg.role === "assistant") {
        // Extract text content from parts
        const textParts: string[] = [];
        const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];

        if (typeof msg.content === "string") {
          textParts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if ("type" in part && part.type === "text" && "text" in part) {
              textParts.push(part.text as string);
            } else if ("type" in part && part.type === "tool-call") {
              const tc = part as { toolCallId: string; toolName: string; input: unknown };
              toolCalls.push({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              });
            }
          }
        }

        await query(
          `INSERT INTO messages (conversation_id, role, content, tool_calls)
           VALUES ($1, 'assistant', $2, $3)`,
          [
            conversationId,
            textParts.join("") || null,
            toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
          ],
        );
      } else if (msg.role === "tool") {
        // Store tool results for audit
        const toolContent = Array.isArray(msg.content)
          ? JSON.stringify(msg.content)
          : String(msg.content);

        await query(
          `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'tool', $2)`,
          [conversationId, toolContent],
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to save assistant messages");
  }
}

/**
 * Sync client-authored messages for endpoints that send full history
 * (e.g., OpenAI-compatible). Only persists user messages — assistant messages
 * are already persisted server-side by saveAssistantMessages at response time.
 * Tags synced rows with metadata {"source":"sync"} and uses positional
 * (index-based) dedup so duplicate message text across turns is safe.
 */
export async function syncMessages(
  conversationId: string,
  messages: { role: string; content: string }[],
): Promise<void> {
  try {
    // Only sync user messages — assistant turns are persisted by saveAssistantMessages
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) return;

    // Count only user rows we previously synced (tagged with source=sync)
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM messages
       WHERE conversation_id = $1 AND role = 'user' AND metadata @> '{"source":"sync"}'`,
      [conversationId],
    );
    const syncedCount = parseInt(countResult.rows[0].count, 10);

    const newMessages = userMessages.slice(syncedCount);
    for (const msg of newMessages) {
      await query(
        `INSERT INTO messages (conversation_id, role, content, metadata)
         VALUES ($1, $2, $3, '{"source":"sync"}')`,
        [conversationId, msg.role, msg.content],
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to sync messages");
  }
}
