import { randomUUID } from "node:crypto";
import { type ModelMessage } from "ai";

export function generateChatId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export function toModelMessages(messages: { role: string; content: string }[]): ModelMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

export function toOpenAIFinishReason(reason: string | undefined): string {
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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize Express header value (string | string[] | undefined) to a single string. */
export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
