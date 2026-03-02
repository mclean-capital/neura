import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../db/conversations.js", () => ({
  findOrCreateConversation: vi.fn(),
  syncMessages: vi.fn(),
  saveAssistantMessages: vi.fn(),
}));

vi.mock("../../db/connection.js", () => ({
  query: vi.fn(),
  pool: { on: vi.fn() },
}));

vi.mock("../../agent/core.js", () => ({
  runAgent: vi.fn(),
  runAgentStream: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: {
    API_KEY: undefined,
    PORT: 3000,
    DATABASE_URL: "postgresql://test:test@localhost:5432/neura_test",
    LOG_LEVEL: "fatal",
    NODE_ENV: "test",
  },
}));

import { openaiRouter } from "./openai.js";
import { findOrCreateConversation, syncMessages } from "../../db/conversations.js";
import { runAgent } from "../../agent/core.js";
import { env } from "../../env.js";

const mockFindOrCreate = vi.mocked(findOrCreateConversation);
const mockSyncMessages = vi.mocked(syncMessages);
const mockRunAgent = vi.mocked(runAgent);
const mockEnv = env as any;

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(openaiRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.API_KEY = undefined;
  mockFindOrCreate.mockResolvedValue("conv-1");
  mockSyncMessages.mockResolvedValue(undefined);
  mockRunAgent.mockResolvedValue({
    text: "Hello!",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 20 },
    response: { messages: [] },
  } as any);
});

describe("POST /v1/chat/completions — Conversation ID", () => {
  // [REGRESSION] X-Conversation-Id header used and returned
  it("uses X-Conversation-Id header as conversation ID", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .set("X-Conversation-Id", uuid)
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: uuid }),
    );
    expect(res.headers["x-conversation-id"]).toBe("conv-1");
  });

  // [REGRESSION] X-OpenWebUI-Chat-Id used when no X-Conversation-Id
  it("falls back to X-OpenWebUI-Chat-Id when no X-Conversation-Id", async () => {
    const uuid = "660e8400-e29b-41d4-a716-446655440000";
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .set("X-OpenWebUI-Chat-Id", uuid)
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: uuid }),
    );
  });

  // [REGRESSION] X-Conversation-Id takes precedence over X-OpenWebUI-Chat-Id
  it("X-Conversation-Id takes precedence over X-OpenWebUI-Chat-Id", async () => {
    const convId = "550e8400-e29b-41d4-a716-446655440000";
    const webUiId = "660e8400-e29b-41d4-a716-446655440000";

    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .set("X-Conversation-Id", convId)
      .set("X-OpenWebUI-Chat-Id", webUiId)
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: convId }),
    );
  });

  // [REGRESSION] Invalid UUID → ignored, new UUID generated
  it("ignores invalid UUID and generates new conversation", async () => {
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .set("X-Conversation-Id", "not-a-uuid")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: undefined }),
    );
  });

  // [REGRESSION] No headers → new UUID fallback
  it("creates new conversation when no ID headers present", async () => {
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: undefined }),
    );
  });
});

describe("POST /v1/chat/completions — Auth", () => {
  it("returns 401 when API_KEY is set and no auth header", async () => {
    mockEnv.API_KEY = "secret-key";

    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("returns 401 when API_KEY is set and wrong key provided", async () => {
    mockEnv.API_KEY = "secret-key";

    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer wrong-key")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
  });

  it("passes when correct API_KEY is provided", async () => {
    mockEnv.API_KEY = "secret-key";

    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer secret-key")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
  });

  it("passes when API_KEY is not set", async () => {
    mockEnv.API_KEY = undefined;

    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions — Validation", () => {
  it("returns 400 when messages is missing", async () => {
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .send({ model: "neura" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("messages is required");
  });

  it("returns 400 when messages is not an array", async () => {
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .send({ messages: "not-an-array" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("messages is required");
  });
});

describe("POST /v1/chat/completions — Non-streaming response", () => {
  it("returns well-formed OpenAI chat completion shape", async () => {
    const res = await request(createTestApp())
      .post("/v1/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.choices).toHaveLength(1);
    expect(res.body.choices[0].message.role).toBe("assistant");
    expect(res.body.choices[0].message.content).toBe("Hello!");
    expect(res.body.choices[0].finish_reason).toBe("stop");
    expect(res.body.usage.prompt_tokens).toBe(10);
    expect(res.body.usage.completion_tokens).toBe(20);
    expect(res.body.usage.total_tokens).toBe(30);
    expect(res.body.id).toMatch(/^chatcmpl-/);
  });
});
