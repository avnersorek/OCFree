import { describe, expect, it } from "vitest";
import {
  buildRunArgs,
  isFreeModel,
  normalizeModel,
  parseEvents,
} from "./opencode.js";

describe("free model filter", () => {
  it("accepts -free ids and big-pickle", () => {
    expect(isFreeModel("deepseek-v4.1-flash-free")).toBe(true);
    expect(isFreeModel("opencode/deepseek-v4.1-flash-free")).toBe(true);
    expect(isFreeModel("big-pickle")).toBe(true);
    expect(isFreeModel("opencode/big-pickle")).toBe(true);
  });

  it("rejects paid and other-provider models", () => {
    expect(isFreeModel("opencode-go/deepseek-v4.1-flash-free")).toBe(false);
    expect(isFreeModel("opencode/gpt-5")).toBe(false);
    expect(isFreeModel("anthropic/claude-sonnet")).toBe(false);
    expect(isFreeModel("")).toBe(false);
  });

  it("normalizes the opencode prefix only", () => {
    expect(normalizeModel("opencode/big-pickle")).toBe("big-pickle");
    expect(normalizeModel("opencode-go/big-pickle")).toBe(
      "opencode-go/big-pickle",
    );
    expect(normalizeModel("  big-pickle  ")).toBe("big-pickle");
  });
});

describe("event parsing", () => {
  it("sums tool calls, cost, and tokens and ignores malformed lines", () => {
    const stdout = [
      '{"type":"tool_use","part":{"tool":"bash"}}',
      '{"type":"step_finish","part":{"cost":0,"tokens":{"input":10,"output":4,"reasoning":2}}}',
      "not json",
      '{"type":"step_finish","part":{"cost":0,"tokens":{"input":3,"output":1}}}',
    ].join("\n");

    expect(parseEvents(stdout)).toEqual({
      toolCalls: 1,
      cost: 0,
      tokens: { input: 13, output: 5, reasoning: 2 },
      ttfoMs: null,
    });
  });
});

describe("run arguments", () => {
  it("uses --dir on v1 and omits it on v2", () => {
    const base = {
      model: "beam-free",
      dir: "/tmp/repo",
      prompt: "do work",
    };
    expect(buildRunArgs({ ...base, major: 1 })).toContain("--dir");
    expect(buildRunArgs({ ...base, major: 2 })).not.toContain("--dir");
  });

  it("adds --session when resuming", () => {
    const args = buildRunArgs({
      major: 1,
      model: "beam-free",
      dir: "/tmp/repo",
      prompt: "continue",
      sessionId: "ses_123",
    });
    expect(args.slice(-3)).toEqual([
      "--session",
      "ses_123",
      "continue",
    ]);
  });
});
