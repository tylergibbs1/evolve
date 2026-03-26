/**
 * Initial task agent — deliberately minimal (Appendix A.1).
 *
 * Receives task inputs and returns the response from a single LLM call.
 * The meta agent will evolve this into something more sophisticated.
 */

export interface TaskInput {
  [key: string]: unknown;
}

export interface TaskOutput {
  prediction: unknown;
}

/**
 * Solve a task by prompting the LLM with the raw input.
 * This is the starting point — the meta agent will improve it over generations.
 */
export function buildTaskPrompt(inputs: TaskInput): string {
  return `You are an agent.

Task input:
'''
${JSON.stringify(inputs)}
'''

Respond in JSON format with the following schema:
<json>
{
  "response": ...
}
</json>`;
}

export function parseTaskResponse(response: string): TaskOutput {
  try {
    const jsonMatch = response.match(/<json>\s*([\s\S]*?)\s*<\/json>/);
    if (jsonMatch?.[1]) {
      const parsed = JSON.parse(jsonMatch[1]);
      return { prediction: parsed.response ?? parsed };
    }
    return { prediction: JSON.parse(response) };
  } catch {
    return { prediction: "None" };
  }
}
