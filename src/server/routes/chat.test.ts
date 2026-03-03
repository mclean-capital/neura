import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../db/conversations.js", () => ({
  findOrCreateConversation: vi.fn(),
  loadConversationMessages: vi.fn(),
  saveUserMessage: vi.fn(),
  saveAssistantMessages: vi.fn(),
}));

vi.mock("../../agent/core.js", () => ({
  runAgent: vi.fn(),
  runAgentStream: vi.fn(),
}));

import { chatRouter } from "./chat.js";
import {
  findOrCreateConversation,
  loadConversationMessages,
  saveUserMessage,
} from "../../db/conversations.js";
import { runAgent, runAgentStream } from "../../agent/core.js";

const mockFindOrCreate = vi.mocked(findOrCreateConversation);
const mockLoadMessages = vi.mocked(loadConversationMessages);
const mockSaveUser = vi.mocked(saveUserMessage);
const mockRunAgent = vi.mocked(runAgent);
const mockRunAgentStream = vi.mocked(runAgentStream);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindOrCreate.mockResolvedValue("conv-1");
  mockSaveUser.mockResolvedValue(true);
  mockLoadMessages.mockResolvedValue([{ role: "user", content: "hello" }]);
  mockRunAgent.mockResolvedValue({
    text: "Agent reply",
    response: { messages: [] },
  } as any);
});

describe("POST /chat", () => {
  it("returns JSON with response and conversationId (non-streaming)", async () => {
    const res = await request(createTestApp())
      .post("/chat")
      .send({ message: "hello", stream: false });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe("Agent reply");
    expect(res.body.conversationId).toBe("conv-1");
  });

  it("returns 400 when message is missing", async () => {
    const res = await request(createTestApp()).post("/chat").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("message is required");
  });

  it("returns 400 when message is not a string", async () => {
    const res = await request(createTestApp()).post("/chat").send({ message: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("message is required");
  });

  it("defaults to streaming (calls runAgentStream)", async () => {
    mockRunAgentStream.mockResolvedValue({
      pipeTextStreamToResponse: vi.fn((res: any) => {
        res.end();
      }),
    } as any);

    const res = await request(createTestApp()).post("/chat").send({ message: "hello" });

    // Default stream=true, so runAgentStream should be called
    expect(mockRunAgentStream).toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("uses runAgent when stream=false in body", async () => {
    const res = await request(createTestApp())
      .post("/chat")
      .send({ message: "hello", stream: false });

    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockRunAgentStream).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("query param ?stream=true overrides body stream=false", async () => {
    mockRunAgentStream.mockResolvedValue({
      pipeTextStreamToResponse: vi.fn((res: any) => {
        res.end();
      }),
    } as any);

    const res = await request(createTestApp())
      .post("/chat?stream=true")
      .send({ message: "hello", stream: false });

    expect(mockRunAgentStream).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("returns 500 when agent throws", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("LLM down"));

    const res = await request(createTestApp())
      .post("/chat")
      .send({ message: "hello", stream: false });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed to process message");
  });
});
