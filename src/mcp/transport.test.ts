import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the MCP SDK transport
const mockHandleRequest = vi.fn();
const mockClose = vi.fn();
const mockSessionId = "test-session-id";

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = mockHandleRequest;
    close = mockClose;
    sessionId = mockSessionId;
  },
}));

vi.mock("./server.js", () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(),
  })),
}));

// Must import after mocks
import { mcpRouter } from "./transport.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(mcpRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleRequest.mockImplementation((_req: any, res: any) => {
    res.json({ jsonrpc: "2.0", result: {} });
  });
  mockClose.mockResolvedValue(undefined);
});

describe("MCP transport", () => {
  it("POST creates a new session", async () => {
    const res = await request(createTestApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    expect(res.status).toBe(200);
    expect(mockHandleRequest).toHaveBeenCalled();
  });

  it("POST reuses existing session by header", async () => {
    const app = createTestApp();

    // First request creates session
    await request(app).post("/mcp").send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    // Second request reuses session
    await request(app)
      .post("/mcp")
      .set("mcp-session-id", mockSessionId)
      .send({ jsonrpc: "2.0", method: "tools/list", id: 2 });

    expect(mockHandleRequest).toHaveBeenCalledTimes(2);
  });

  // [REGRESSION] DELETE → 204, transport closed, session removed
  it("DELETE closes session and returns 204", async () => {
    const app = createTestApp();

    // Create session first
    await request(app).post("/mcp").send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    // Delete session
    const res = await request(app).delete("/mcp").set("mcp-session-id", mockSessionId);

    expect(res.status).toBe(204);
    expect(mockClose).toHaveBeenCalled();
  });

  it("DELETE unknown session returns 204", async () => {
    const res = await request(createTestApp())
      .delete("/mcp")
      .set("mcp-session-id", "unknown-session");

    expect(res.status).toBe(204);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("GET unknown session returns 404", async () => {
    const res = await request(createTestApp()).get("/mcp").set("mcp-session-id", "unknown-session");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("session not found");
  });
});
