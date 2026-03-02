import { describe, it, expect } from "vitest";
import { resolveModel } from "./core.js";

describe("resolveModel", () => {
  it("resolves anthropic provider", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-20250514");
    expect(model).toBeDefined();
  });

  it("resolves openai provider", () => {
    const model = resolveModel("openai/gpt-4o");
    expect(model).toBeDefined();
  });

  it("resolves google provider", () => {
    const model = resolveModel("google/gemini-2.0-flash");
    expect(model).toBeDefined();
  });

  it("throws for unknown provider", () => {
    expect(() => resolveModel("unknown/model")).toThrow("Unknown provider: unknown");
  });

  it("handles model names with multiple slashes", () => {
    const model = resolveModel("openai/ft:gpt-4o/my-org/custom");
    expect(model).toBeDefined();
  });
});
