import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("./executor.js", () => ({
  executeTask: vi.fn(),
}));

vi.mock("./agent-card.js", () => ({
  getAgentCard: vi.fn(),
}));

import { a2aRouter } from "./handler.js";
import { executeTask } from "./executor.js";
import { getAgentCard } from "./agent-card.js";

const mockExecuteTask = vi.mocked(executeTask);
const mockGetAgentCard = vi.mocked(getAgentCard);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(a2aRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentCard.mockReturnValue({
    name: "Neura",
    description: "Test",
    url: "http://localhost:3000/a2a",
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false },
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  });
});

describe("A2A handler", () => {
  it("tasks/send returns completed with agent message appended", async () => {
    mockExecuteTask.mockResolvedValue({ text: "Hello!", status: "completed" });

    const res = await request(createTestApp())
      .post("/a2a")
      .send({
        method: "tasks/send",
        params: {
          id: "t1",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        },
        id: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.result.status.state).toBe("completed");
    expect(res.body.result.messages).toHaveLength(2); // user + agent
    expect(res.body.result.messages[1].role).toBe("agent");
    expect(res.body.result.messages[1].parts[0].text).toBe("Hello!");
    expect(res.body.id).toBe(1);
  });

  it("missing method returns 400 with code -32600", async () => {
    const res = await request(createTestApp()).post("/a2a").send({ id: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
  });

  it("unknown method returns code -32601", async () => {
    const res = await request(createTestApp())
      .post("/a2a")
      .send({ method: "tasks/unknown", id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });

  it("tasks/get returns -32601 (not implemented)", async () => {
    const res = await request(createTestApp())
      .post("/a2a")
      .send({ method: "tasks/get", params: { id: "t1" }, id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });

  it("tasks/cancel returns -32601 (not implemented)", async () => {
    const res = await request(createTestApp())
      .post("/a2a")
      .send({ method: "tasks/cancel", params: { id: "t1" }, id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });

  it("GET /.well-known/agent-card.json returns agent card structure", async () => {
    const res = await request(createTestApp()).get("/.well-known/agent-card.json");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Neura");
    expect(res.body.version).toBe("1.0.0");
    expect(res.body.capabilities).toBeDefined();
  });
});
