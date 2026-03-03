import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./connection.js", () => ({
  query: vi.fn(),
  pool: { on: vi.fn() },
}));

import {
  findOrCreateConversation,
  saveUserMessage,
  loadConversationMessages,
  syncMessages,
  saveAssistantMessages,
} from "./conversations.js";
import { query } from "./connection.js";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findOrCreateConversation", () => {
  it("returns existing conversation id when found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "existing-id" }] } as any);
    const id = await findOrCreateConversation({ conversationId: "existing-id" });
    expect(id).toBe("existing-id");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("creates a new conversation when id not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any); // SELECT returns nothing
    mockQuery.mockResolvedValueOnce({ rows: [] } as any); // INSERT
    const id = await findOrCreateConversation({ conversationId: "new-id" });
    expect(id).toBe("new-id");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("generates a UUID when no conversationId provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const id = await findOrCreateConversation();
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    // Should not call SELECT (no incoming id to check), just INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns id gracefully on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB down"));
    const id = await findOrCreateConversation({ conversationId: "fail-id" });
    expect(id).toBe("fail-id");
  });
});

describe("saveUserMessage", () => {
  it("returns true on success", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const result = await saveUserMessage("conv-1", "hello");
    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"), [
      "conv-1",
      "hello",
    ]);
  });

  it("returns false on error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("write fail"));
    const result = await saveUserMessage("conv-1", "hello");
    expect(result).toBe(false);
  });
});

describe("loadConversationMessages", () => {
  it("loads user and assistant messages in order", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ],
    } as any);
    const msgs = await loadConversationMessages("conv-1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "Hi" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "Hello!" });
  });

  it("returns empty array on error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("read fail"));
    const msgs = await loadConversationMessages("conv-1");
    expect(msgs).toEqual([]);
  });
});

describe("syncMessages", () => {
  it("skips when no user messages", async () => {
    await syncMessages("conv-1", [{ role: "assistant", content: "hi" }]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("inserts only new messages based on count", async () => {
    // Already synced 1 user message
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] } as any);
    // INSERT for the new message
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    await syncMessages("conv-1", [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);

    // 1 COUNT query + 1 INSERT (only "second" is new)
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenLastCalledWith(expect.stringContaining("INSERT"), [
      "conv-1",
      "user",
      "second",
    ]);
  });

  it("inserts all user messages when none previously synced", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    await syncMessages("conv-1", [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);

    // 1 COUNT + 2 INSERTs
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("inserts nothing when fully synced", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "2" }] } as any);

    await syncMessages("conv-1", [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);

    // Only the COUNT query, no INSERTs
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("saveAssistantMessages", () => {
  it("saves text parts from assistant message", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);

    await saveAssistantMessages("conv-1", [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    ]);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"), [
      "conv-1",
      "Hello world",
      null,
    ]);
  });

  it("saves tool calls from assistant message", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);

    await saveAssistantMessages("conv-1", [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "shell", input: { cmd: "ls" } },
        ],
      },
    ]);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"), [
      "conv-1",
      null,
      expect.stringContaining('"toolName":"shell"'),
    ]);
  });

  it("saves string content directly", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);

    await saveAssistantMessages("conv-1", [{ role: "assistant", content: "Plain text" }]);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"), [
      "conv-1",
      "Plain text",
      null,
    ]);
  });

  it("saves tool messages for audit", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any);

    await saveAssistantMessages("conv-1", [
      { role: "tool", content: [{ type: "tool-result", result: "ok" }] },
    ]);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO messages"), [
      "conv-1",
      expect.stringContaining("tool-result"),
    ]);
  });
});
