import type {
  LLMResponse,
  LLMRoleConfig,
  Message,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../types.ts";

/**
 * Unified LLM provider interface. Implementations adapt vendor SDKs
 * (Anthropic, OpenAI) to this common shape.
 */
export interface LLMProvider {
  chat(
    messages: Message[],
    config: LLMRoleConfig,
    tools?: ToolDefinition[],
    toolChoice?: ToolChoice,
  ): Promise<LLMResponse>;
}

/**
 * Runs an agentic tool-use loop: sends messages to the LLM, executes any
 * tool calls the LLM makes, feeds results back, and repeats until the LLM
 * stops calling tools.
 *
 * This is the core loop that both the task agent and meta agent use.
 */
export async function runToolLoop(
  provider: LLMProvider,
  config: LLMRoleConfig,
  systemPrompt: string,
  initialMessages: Message[],
  tools: ToolDefinition[],
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  maxIterations: number = 50,
): Promise<{ finalResponse: string; messages: Message[]; totalUsage: { inputTokens: number; outputTokens: number } }> {
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...initialMessages,
  ];
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;

  while (iterations < maxIterations) {
    const response = await provider.chat(messages, config, tools);
    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;

    if (response.toolCalls.length === 0) {
      return { finalResponse: response.content, messages, totalUsage };
    }

    // Build assistant message with text + tool_use content blocks
    const assistantContent: import("../types.ts").MessageContent[] = [];
    if (response.content) {
      assistantContent.push({ type: "text", text: response.content });
    }
    assistantContent.push(...response.toolCalls.map(tc => ({
      type: "tool_use" as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })));
    messages.push({ role: "assistant", content: assistantContent });

    // Execute all tool calls, collect results into a single user message
    const toolResults: import("../types.ts").MessageContent[] = [];
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(toolCall.name, toolCall.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result,
      });
    }
    messages.push({ role: "user", content: toolResults });

    iterations++;
  }

  return {
    finalResponse: messages.at(-1)?.content as string ?? "",
    messages,
    totalUsage,
  };
}
