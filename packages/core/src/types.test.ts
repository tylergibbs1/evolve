import { test, expect, describe } from "bun:test";
import { agentId, runId, EvolveException } from "./types.ts";
import type { EvolveError } from "./types.ts";

describe("Branded IDs", () => {
  test("agentId creates branded string", () => {
    const id = agentId("test-123");
    // At runtime it's just a string
    expect(id).toBe(agentId("test-123"));
    expect(typeof id).toBe("string");
    // String comparison works
    expect(String(id)).toBe("test-123");
  });

  test("runId creates branded string", () => {
    const id = runId("run-abc");
    expect(id).toBe(runId("run-abc"));
    expect(typeof id).toBe("string");
    expect(String(id)).toBe("run-abc");
  });

  test("branded IDs with empty strings", () => {
    expect(agentId("")).toBe(agentId(""));
    expect(runId("")).toBe(runId(""));
  });

  test("branded IDs with special characters", () => {
    const id = agentId("agent-0-initial/with:special");
    expect(id).toBe(agentId("agent-0-initial/with:special"));
  });

  test("branded IDs are string-like at runtime", () => {
    const id = agentId("test");
    expect(`${id}`).toBe("test");
    expect(id.length).toBe(4);
    expect(id.startsWith("te")).toBe(true);
  });
});

describe("EvolveException", () => {
  test("formats budget_exhausted error", () => {
    const error: EvolveError = { kind: "budget_exhausted", spent: 42.5, limit: 100 };
    const ex = new EvolveException(error);
    expect(ex.message).toContain("Budget exhausted");
    expect(ex.message).toContain("42.50");
    expect(ex.message).toContain("100.00");
    expect(ex.name).toBe("EvolveException");
    expect(ex.error).toBe(error);
  });

  test("formats sandbox_timeout error", () => {
    const error: EvolveError = {
      kind: "sandbox_timeout",
      agentId: agentId("agent-1"),
      wallTimeSeconds: 300,
    };
    const ex = new EvolveException(error);
    expect(ex.message).toContain("Sandbox timeout");
    expect(ex.message).toContain("agent-1");
    expect(ex.message).toContain("300");
  });

  test("formats sandbox_crash error", () => {
    const error: EvolveError = {
      kind: "sandbox_crash",
      agentId: agentId("agent-2"),
      stderr: "segfault at 0x0",
    };
    const ex = new EvolveException(error);
    expect(ex.message).toContain("Sandbox crash");
    expect(ex.message).toContain("segfault");
  });

  test("formats eval_failed error", () => {
    const error: EvolveError = {
      kind: "eval_failed",
      agentId: agentId("agent-3"),
      domain: "coding",
      reason: "scorer threw",
    };
    const ex = new EvolveException(error);
    expect(ex.message).toContain("Evaluation failed");
    expect(ex.message).toContain("coding");
    expect(ex.message).toContain("scorer threw");
  });

  test("formats llm_error", () => {
    const error: EvolveError = {
      kind: "llm_error",
      provider: "anthropic",
      status: 429,
      message: "rate limited",
    };
    const ex = new EvolveException(error);
    expect(ex.message).toContain("LLM error");
    expect(ex.message).toContain("429");
    expect(ex.message).toContain("rate limited");
  });

  test("formats compile_error", () => {
    const error: EvolveError = {
      kind: "compile_error",
      agentId: agentId("agent-4"),
      stderr: "TS2304: Cannot find name 'foo'",
    };
    const ex = new EvolveException(error);
    expect(ex.message).toContain("Compile error");
    expect(ex.message).toContain("TS2304");
  });

  test("is an instance of Error", () => {
    const error: EvolveError = { kind: "budget_exhausted", spent: 0, limit: 0 };
    const ex = new EvolveException(error);
    expect(ex instanceof Error).toBe(true);
    expect(ex instanceof EvolveException).toBe(true);
  });
});
