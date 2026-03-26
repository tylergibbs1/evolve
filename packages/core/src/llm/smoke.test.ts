import { test, expect, describe } from "bun:test";
import { AnthropicProvider } from "./anthropic.ts";

describe("AnthropicProvider smoke test", () => {
  test("can make a real API call", async () => {
    const provider = new AnthropicProvider();
    const response = await provider.chat(
      [{ role: "user", content: "Reply with exactly: PONG" }],
      { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0 },
    );

    expect(response.content).toContain("PONG");
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.toolCalls).toEqual([]);
  });
});
