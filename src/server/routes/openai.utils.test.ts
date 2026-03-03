import { describe, it, expect } from "vitest";
import {
  UUID_RE,
  firstHeader,
  toModelMessages,
  toOpenAIFinishReason,
  generateChatId,
} from "./openai.utils.js";

describe("UUID_RE", () => {
  it("matches a valid lowercase UUID", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("matches an uppercase UUID", () => {
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects a too-short string", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716")).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-44665544gggg")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(UUID_RE.test("")).toBe(false);
  });
});

describe("firstHeader", () => {
  it("returns the string when given a string", () => {
    expect(firstHeader("value")).toBe("value");
  });

  it("returns the first element when given an array", () => {
    expect(firstHeader(["first", "second"])).toBe("first");
  });

  it("returns undefined when given undefined", () => {
    expect(firstHeader(undefined)).toBeUndefined();
  });
});

describe("toModelMessages", () => {
  it("filters out system messages", () => {
    const msgs = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ];
    const result = toModelMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("preserves user and assistant messages", () => {
    const msgs = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const result = toModelMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("returns empty array for empty input", () => {
    expect(toModelMessages([])).toEqual([]);
  });
});

describe("toOpenAIFinishReason", () => {
  it("returns 'stop' for 'stop'", () => {
    expect(toOpenAIFinishReason("stop")).toBe("stop");
  });

  it("returns 'length' for 'length'", () => {
    expect(toOpenAIFinishReason("length")).toBe("length");
  });

  it("returns 'tool_calls' for 'tool-calls'", () => {
    expect(toOpenAIFinishReason("tool-calls")).toBe("tool_calls");
  });

  it("returns 'stop' for undefined", () => {
    expect(toOpenAIFinishReason(undefined)).toBe("stop");
  });

  it("returns 'stop' for unknown reason", () => {
    expect(toOpenAIFinishReason("something-else")).toBe("stop");
  });
});

describe("generateChatId", () => {
  it("starts with chatcmpl- prefix", () => {
    expect(generateChatId()).toMatch(/^chatcmpl-/);
  });

  it("contains a UUID after the prefix", () => {
    const id = generateChatId();
    const uuid = id.replace("chatcmpl-", "");
    expect(UUID_RE.test(uuid)).toBe(true);
  });

  it("generates unique IDs", () => {
    const a = generateChatId();
    const b = generateChatId();
    expect(a).not.toBe(b);
  });
});
