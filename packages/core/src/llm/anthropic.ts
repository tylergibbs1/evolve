import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMResponse,
  LLMRoleConfig,
  Message,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../types.ts";
import type { LLMProvider } from "./provider.ts";

/**
 * Anthropic LLM provider using the official SDK.
 *
 * @example
 * ```ts
 * const provider = new AnthropicProvider("sk-ant-...");
 * const response = await provider.chat(messages, config);
 * ```
 */
export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    messages: Message[],
    config: LLMRoleConfig,
    tools?: ToolDefinition[],
    toolChoice?: ToolChoice,
  ): Promise<LLMResponse> {
    // Separate system message from conversation messages
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");

    const systemText = systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");

    const anthropicMessages = conversationMessages.map((m) =>
      toAnthropicMessage(m),
    );

    const anthropicTools = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }));

    // Map our ToolChoice to Anthropic's tool_choice format
    let anthropicToolChoice: Anthropic.MessageCreateParams["tool_choice"];
    if (toolChoice) {
      if (toolChoice === "auto") {
        anthropicToolChoice = { type: "auto" };
      } else if (toolChoice === "any") {
        anthropicToolChoice = { type: "any" };
      } else {
        anthropicToolChoice = { type: "tool", name: toolChoice.tool };
      }
    }

    const response = await this.client.messages.create({
      model: config.model,
      max_tokens: 8192,
      temperature: config.temperature,
      system: systemText || undefined,
      messages: anthropicMessages,
      tools: anthropicTools,
      tool_choice: anthropicToolChoice,
    });

    return fromAnthropicResponse(response);
  }
}

function toAnthropicMessage(
  msg: Message,
): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role as "user" | "assistant", content: msg.content };
  }

  const blocks = msg.content.map((c) => {
    switch (c.type) {
      case "text":
        return { type: "text" as const, text: c.text };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: c.id,
          name: c.name,
          input: c.input as Record<string, unknown>,
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: c.tool_use_id,
          content: c.content,
        };
    }
  });

  return { role: msg.role as "user" | "assistant", content: blocks };
}

function fromAnthropicResponse(
  response: Anthropic.Message,
): LLMResponse {
  let textContent = "";
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content: textContent,
    toolCalls,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
