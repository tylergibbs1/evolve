import { test, expect, describe } from "bun:test";
import { runToolLoop } from "./provider.ts";
import type { LLMProvider } from "./provider.ts";
import type { LLMRoleConfig, LLMResponse, Message, ToolDefinition } from "../types.ts";

const mockConfig: LLMRoleConfig = {
  provider: "anthropic",
  model: "test-model",
  temperature: 0,
};

function mockProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    chat: async () => {
      const response = responses[callIndex];
      if (!response) throw new Error("No more mock responses");
      callIndex++;
      return response;
    },
  };
}

const testTools: ToolDefinition[] = [
  {
    name: "test_tool",
    description: "A test tool",
    inputSchema: {
      type: "object",
      properties: { arg: { type: "string" } },
      required: ["arg"],
    },
  },
];

describe("runToolLoop", () => {
  test("returns immediately when LLM makes no tool calls", async () => {
    const provider = mockProvider([
      {
        content: "Final answer",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]);

    const result = await runToolLoop(
      provider,
      mockConfig,
      "System prompt",
      [{ role: "user", content: "Question" }],
      testTools,
      async () => "tool result",
    );

    expect(result.finalResponse).toBe("Final answer");
    expect(result.totalUsage.inputTokens).toBe(100);
    expect(result.totalUsage.outputTokens).toBe(50);
  });

  test("executes tool calls and loops", async () => {
    const provider = mockProvider([
      {
        content: "Let me use a tool",
        toolCalls: [{ id: "tc1", name: "test_tool", input: { arg: "hello" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        content: "Got the result, here's my answer",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 80 },
      },
    ]);

    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executeTool = async (name: string, input: Record<string, unknown>) => {
      toolCalls.push({ name, input });
      return "tool output";
    };

    const result = await runToolLoop(
      provider,
      mockConfig,
      "System prompt",
      [{ role: "user", content: "Question" }],
      testTools,
      executeTool,
    );

    expect(result.finalResponse).toBe("Got the result, here's my answer");
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]!.name).toBe("test_tool");
    expect(toolCalls[0]!.input).toEqual({ arg: "hello" });
    expect(result.totalUsage.inputTokens).toBe(300);
    expect(result.totalUsage.outputTokens).toBe(130);
  });

  test("handles multiple tool calls in one response", async () => {
    const provider = mockProvider([
      {
        content: "Using two tools",
        toolCalls: [
          { id: "tc1", name: "test_tool", input: { arg: "first" } },
          { id: "tc2", name: "test_tool", input: { arg: "second" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        content: "Done",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 30 },
      },
    ]);

    const toolCalls: string[] = [];
    const result = await runToolLoop(
      provider,
      mockConfig,
      "System prompt",
      [{ role: "user", content: "Question" }],
      testTools,
      async (_name, input) => {
        toolCalls.push(input["arg"] as string);
        return "ok";
      },
    );

    expect(toolCalls).toEqual(["first", "second"]);
    expect(result.finalResponse).toBe("Done");
  });

  test("respects maxIterations limit", async () => {
    // Provider always returns tool calls — should stop at maxIterations
    let callCount = 0;
    const provider: LLMProvider = {
      chat: async () => {
        callCount++;
        return {
          content: `Call ${callCount}`,
          toolCalls: [{ id: `tc${callCount}`, name: "test_tool", input: { arg: "loop" } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const result = await runToolLoop(
      provider,
      mockConfig,
      "System",
      [{ role: "user", content: "Go" }],
      testTools,
      async () => "ok",
      3, // maxIterations = 3
    );

    expect(callCount).toBe(3);
  });

  test("maxIterations = 0 returns immediately without calling LLM", async () => {
    let called = false;
    const provider: LLMProvider = {
      chat: async () => {
        called = true;
        return { content: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const result = await runToolLoop(
      provider,
      mockConfig,
      "System",
      [{ role: "user", content: "Go" }],
      testTools,
      async () => "ok",
      0,
    );

    expect(called).toBe(false);
    expect(result.totalUsage.inputTokens).toBe(0);
  });

  test("system prompt is included in messages", async () => {
    let receivedMessages: Message[] = [];
    const provider: LLMProvider = {
      chat: async (messages) => {
        receivedMessages = messages;
        return { content: "done", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    await runToolLoop(
      provider,
      mockConfig,
      "You are a helpful agent",
      [{ role: "user", content: "Hi" }],
      testTools,
      async () => "ok",
    );

    expect(receivedMessages[0]!.role).toBe("system");
    expect(receivedMessages[0]!.content).toBe("You are a helpful agent");
    expect(receivedMessages[1]!.role).toBe("user");
  });

  test("accumulates usage across iterations", async () => {
    const provider = mockProvider([
      {
        content: "step 1",
        toolCalls: [{ id: "t1", name: "test_tool", input: { arg: "a" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        content: "step 2",
        toolCalls: [{ id: "t2", name: "test_tool", input: { arg: "b" } }],
        usage: { inputTokens: 200, outputTokens: 80 },
      },
      {
        content: "final",
        toolCalls: [],
        usage: { inputTokens: 150, outputTokens: 60 },
      },
    ]);

    const result = await runToolLoop(
      provider,
      mockConfig,
      "System",
      [{ role: "user", content: "Go" }],
      testTools,
      async () => "ok",
    );

    expect(result.totalUsage.inputTokens).toBe(450);
    expect(result.totalUsage.outputTokens).toBe(190);
  });

  test("empty initial messages", async () => {
    const provider = mockProvider([
      { content: "answer", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    const result = await runToolLoop(
      provider,
      mockConfig,
      "System",
      [],
      testTools,
      async () => "ok",
    );

    expect(result.finalResponse).toBe("answer");
  });
});
