import { mkdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * `evolve init` — Scaffold a new evolution project.
 *
 * Creates:
 * - agent/ directory with initial task.ts and meta.ts
 * - eval/ directory with example eval config
 * - evolve.config.ts with default configuration
 */
export async function init(targetDir: string): Promise<void> {
  const dir = resolve(targetDir);
  console.log(`Initializing Evolve project in ${dir}`);

  await mkdir(join(dir, "agent"), { recursive: true });
  await mkdir(join(dir, "eval"), { recursive: true });

  // Copy initial agent
  const initialAgentDir = resolve(
    import.meta.dir,
    "../../initial-agent",
  );
  try {
    await cp(join(initialAgentDir, "task.ts"), join(dir, "agent", "task.ts"));
    await cp(join(initialAgentDir, "meta.ts"), join(dir, "agent", "meta.ts"));
  } catch {
    // Write inline if copy fails (e.g., initial-agent not found)
    await Bun.write(
      join(dir, "agent", "task.ts"),
      INITIAL_TASK_TS,
    );
    await Bun.write(
      join(dir, "agent", "meta.ts"),
      INITIAL_META_TS,
    );
  }

  // Write example eval config
  await Bun.write(join(dir, "eval", "config.ts"), EVAL_CONFIG_TS);

  // Write evolve.config.ts
  await Bun.write(join(dir, "evolve.config.ts"), EVOLVE_CONFIG_TS);

  console.log(`\nCreated:`);
  console.log(`  agent/task.ts   — Initial task agent (minimal single LLM call)`);
  console.log(`  agent/meta.ts   — Initial meta agent ("modify the codebase")`);
  console.log(`  eval/config.ts  — Evaluation configuration (customize this)`);
  console.log(`  evolve.config.ts — Run configuration`);
  console.log(`\nNext steps:`);
  console.log(`  1. Add your evaluation cases to eval/config.ts`);
  console.log(`  2. Set ANTHROPIC_API_KEY in your environment`);
  console.log(`  3. Run: evolve run`);
}

const INITIAL_TASK_TS = `/**
 * Initial task agent — deliberately minimal (Appendix A.1).
 * The meta agent will evolve this over generations.
 */

export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`You are an agent.

Task input:
'''
\${JSON.stringify(inputs)}
'''

Respond in JSON format with the following schema:
<json>
{
  "response": ...
}
</json>\`;
}

export function parseTaskResponse(response: string): { prediction: unknown } {
  try {
    const jsonMatch = response.match(/<json>\\s*([\\s\\S]*?)\\s*<\\/json>/);
    if (jsonMatch?.[1]) {
      const parsed = JSON.parse(jsonMatch[1]);
      return { prediction: parsed.response ?? parsed };
    }
    return { prediction: JSON.parse(response) };
  } catch {
    return { prediction: "None" };
  }
}
`;

const INITIAL_META_TS = `/**
 * Initial meta agent — deliberately minimal (Appendix A.1).
 * "Modify any part of the codebase."
 */

export function buildMetaPrompt(input: {
  repoPath: string;
  evalHistory: Array<{ domain: string; score: number; feedback?: string }>;
  remainingIterations: number;
  archiveSummary: { totalAgents: number; bestScore: number; averageScore: number };
}): string {
  return \`Modify any part of the codebase at '\${input.repoPath}'.\`;
}
`;

const EVAL_CONFIG_TS = `import type { DomainConfig, StagedEvalConfig, EvalConfig } from "@evolve/core";

/**
 * Define your evaluation domains here.
 *
 * Each domain has:
 * - trainCases: cases used during evolution (agent sees scores)
 * - validationCases: optional, used for parent selection
 * - testCases: held out, only used for final evaluation
 * - scorer: function that scores agent output against expected
 */

const exampleDomain: DomainConfig = {
  name: "example",
  trainCases: [
    { id: "1", input: { question: "What is 2+2?" }, expected: { answer: "4" } },
    { id: "2", input: { question: "What is the capital of France?" }, expected: { answer: "Paris" } },
  ],
  testCases: [
    { id: "t1", input: { question: "What is 3+3?" }, expected: { answer: "6" } },
  ],
  scorer: async (output: unknown, expected) => {
    const expectedAnswer = (expected.expected as { answer: string }).answer;
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    return outputStr.toLowerCase().includes(expectedAnswer.toLowerCase()) ? 1 : 0;
  },
};

const stagedEval: StagedEvalConfig = {
  stages: [
    { taskCount: 2, passThreshold: 0, passCondition: "any" },
  ],
  defaultScore: 0,
};

export const evalConfig: EvalConfig = {
  domains: [exampleDomain],
  stagedEval,
  parentSelectionScore: "training",
};
`;

const EVOLVE_CONFIG_TS = `import type { RunConfig } from "@evolve/core";

export const config: Partial<RunConfig> = {
  iterations: 10,
  k: 2,
  topM: 3,
  lambda: 10,
  llm: {
    diagnosis: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0,
    },
    modification: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0,
    },
    evaluation: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0,
    },
  },
  budget: {
    maxTokensPerIteration: 1_000_000,
    maxTotalTokens: 100_000_000,
    maxCostUSD: 500,
    pauseOnBudgetExhausted: true,
    warnAtPercentage: 80,
  },
  sandbox: {
    limits: {
      maxWallTimeSeconds: 300,
      maxMemoryMB: 512,
      maxLLMCalls: 50,
      networkAccess: "llm-only",
    },
  },
};
`;
