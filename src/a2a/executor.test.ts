import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/conversations.js", () => ({
  findOrCreateConversation: vi.fn(),
  loadConversationMessages: vi.fn(),
  saveUserMessage: vi.fn(),
  saveAssistantMessages: vi.fn(),
}));

vi.mock("../agent/core.js", () => ({
  runAgent: vi.fn(),
}));

import { executeTask } from "./executor.js";
import {
  findOrCreateConversation,
  loadConversationMessages,
  saveUserMessage,
  saveAssistantMessages,
} from "../db/conversations.js";
import { runAgent } from "../agent/core.js";

const mockFindOrCreate = vi.mocked(findOrCreateConversation);
const mockLoadMessages = vi.mocked(loadConversationMessages);
const mockSaveUser = vi.mocked(saveUserMessage);
const mockSaveAssistant = vi.mocked(saveAssistantMessages);
const mockRunAgent = vi.mocked(runAgent);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindOrCreate.mockResolvedValue("task-1");
  mockSaveUser.mockResolvedValue(true);
  mockLoadMessages.mockResolvedValue([{ role: "user", content: "hello" }]);
  mockSaveAssistant.mockResolvedValue(undefined);
  mockRunAgent.mockResolvedValue({
    text: "Agent response",
    response: { messages: [] },
  } as any);
});

describe("executeTask", () => {
  it("completes a basic task with correct DB calls", async () => {
    const result = await executeTask({
      id: "task-1",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Agent response");
    expect(mockFindOrCreate).toHaveBeenCalledWith({
      conversationId: "task-1",
      metadata: { source: "a2a" },
    });
    expect(mockSaveUser).toHaveBeenCalledWith("task-1", "hello");
    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockSaveAssistant).toHaveBeenCalled();
  });

  // [REGRESSION] Full-history client sends 2 user messages — only last one saved
  it("saves only the last user message from full-history client", async () => {
    await executeTask({
      id: "task-1",
      messages: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
      ],
    });

    expect(mockSaveUser).toHaveBeenCalledTimes(1);
    expect(mockSaveUser).toHaveBeenCalledWith("task-1", "second");
  });

  // [REGRESSION] Incremental client — runAgent gets full DB history
  it("passes full DB history to runAgent for incremental client", async () => {
    mockLoadMessages.mockResolvedValue([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);

    await executeTask({
      id: "task-1",
      messages: [{ role: "user", parts: [{ type: "text", text: "second" }] }],
    });

    expect(mockRunAgent).toHaveBeenCalledWith({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });
  });

  // [REGRESSION] Empty messages → failed
  it("fails with 'No user message provided' when messages are empty", async () => {
    const result = await executeTask({
      id: "task-1",
      messages: [],
    });

    expect(result.status).toBe("failed");
    expect(result.text).toBe("No user message provided");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("fails when only non-user roles are present", async () => {
    const result = await executeTask({
      id: "task-1",
      messages: [{ role: "agent", parts: [{ type: "text", text: "hi" }] }],
    });

    expect(result.status).toBe("failed");
    expect(result.text).toBe("No user message provided");
  });

  it("fails gracefully when agent throws", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("LLM error"));

    const result = await executeTask({
      id: "task-1",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });

    expect(result.status).toBe("failed");
    expect(result.text).toBe("Task execution failed");
  });

  it("joins multi-part text with newline", async () => {
    await executeTask({
      id: "task-1",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      ],
    });

    expect(mockSaveUser).toHaveBeenCalledWith("task-1", "line one\nline two");
  });
});
