import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider } from "./llm/anthropic.ts";
import { runToolLoop } from "./llm/provider.ts";
import { ALL_TOOL_DEFINITIONS } from "./tools/interface.ts";
import { ScopedBashTool } from "./tools/bash.ts";
import { ScopedEditorTool, executeEditorCommand } from "./tools/editor.ts";
import { Archive } from "./archive.ts";
import { evaluateAgent } from "./evaluate.ts";
import { selectParents, getAverageScore } from "./selection.ts";
import { runEvolutionLoop } from "./loop.ts";
import { agentId } from "./types.ts";
import type {
  DomainConfig,
  EvalConfig,
  LLMRoleConfig,
  RunConfig,
  StagedEvalConfig,
} from "./types.ts";

const MODEL = "claude-sonnet-4-20250514";
const ROLE_CONFIG: LLMRoleConfig = {
  provider: "anthropic",
  model: MODEL,
  temperature: 0,
};

let testDir: string;

async function makeTestDir(): Promise<string> {
  testDir = await mkdtemp(join(tmpdir(), "evolve-integration-"));
  return testDir;
}

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Integration: Tool-use loop with real LLM", () => {
  test("agent uses bash tool to answer a question", async () => {
    const dir = await makeTestDir();
    await mkdir(join(dir, ".tmp"), { recursive: true });

    const provider = new AnthropicProvider();
    const bash = new ScopedBashTool(dir);
    const editor = new ScopedEditorTool(dir);

    const executeTool = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<string> => {
      if (name === "bash") {
        const result = await bash.run(input["command"] as string);
        return result.exitCode === 0
          ? result.stdout
          : `Exit code ${result.exitCode}\n${result.stderr}`;
      }
      if (name === "editor") {
        return await executeEditorCommand(editor, input);
      }
      return `Unknown tool: ${name}`;
    };

    const result = await runToolLoop(
      provider,
      ROLE_CONFIG,
      "You are an agent. Use the bash tool to solve the task. After solving, give a final text answer.",
      [
        {
          role: "user",
          content:
            "Use the bash tool to compute: echo $((17 * 23)). Then tell me the result.",
        },
      ],
      ALL_TOOL_DEFINITIONS,
      executeTool,
      5,
    );

    // The LLM should have called bash and gotten 391
    expect(result.finalResponse).toContain("391");
    expect(result.totalUsage.inputTokens).toBeGreaterThan(0);
  }, 30_000);

  test("agent uses editor tool to create and read a file", async () => {
    const dir = await makeTestDir();

    const provider = new AnthropicProvider();
    const bash = new ScopedBashTool(dir);
    const editor = new ScopedEditorTool(dir);

    const executeTool = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<string> => {
      if (name === "bash") {
        const result = await bash.run(input["command"] as string);
        return result.exitCode === 0
          ? result.stdout
          : `Exit code ${result.exitCode}\n${result.stderr}`;
      }
      if (name === "editor") {
        return await executeEditorCommand(editor, input);
      }
      return `Unknown tool: ${name}`;
    };

    const result = await runToolLoop(
      provider,
      ROLE_CONFIG,
      "You are an agent with bash and editor tools. Use the editor to complete the task.",
      [
        {
          role: "user",
          content: `Create a file at ${join(dir, "hello.txt")} with the content "Hello from Evolve!" using the editor tool. Then view the file to confirm it was created. Report what the file contains.`,
        },
      ],
      ALL_TOOL_DEFINITIONS,
      executeTool,
      10,
    );

    // Verify the file was actually created
    const fileContent = await Bun.file(join(dir, "hello.txt")).text();
    expect(fileContent).toContain("Hello from Evolve!");
    expect(result.finalResponse.toLowerCase()).toContain("hello");
  }, 30_000);
});

describe("Integration: Evaluation with real LLM", () => {
  test("evaluates a simple QA domain using real LLM as task agent", async () => {
    const provider = new AnthropicProvider();

    const domain: DomainConfig = {
      name: "qa",
      trainCases: [
        {
          id: "capitals-1",
          input: { question: "What is the capital of France?" },
          expected: { answer: "Paris" },
        },
        {
          id: "math-1",
          input: { question: "What is 15 + 27?" },
          expected: { answer: "42" },
        },
      ],
      testCases: [],
      scorer: async (output: unknown, expected) => {
        const exp = (expected.expected as { answer: string }).answer.toLowerCase();
        const out = String(output).toLowerCase();
        return out.includes(exp) ? 1 : 0;
      },
    };

    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    // Use real LLM to solve tasks
    const runTask = async (evalCase: { id: string; input: unknown }) => {
      const question = (evalCase.input as { question: string }).question;
      const response = await provider.chat(
        [
          {
            role: "user",
            content: `Answer this question concisely: ${question}\n\nRespond with just the answer, nothing else.`,
          },
        ],
        ROLE_CONFIG,
      );
      return response.content;
    };

    const result = await evaluateAgent(
      agentId("real-llm-agent"),
      runTask,
      [domain],
      staged,
      [],
    );

    // Claude should get both right
    expect(result.scores[0]!.trainScore).toBe(1);
    expect(result.feedback[0]!.domain).toBe("qa");
  }, 30_000);
});

describe("Integration: Mini evolution loop", () => {
  test("runs 1 iteration with k=1 on a trivial domain", async () => {
    const dir = await makeTestDir();
    const agentDir = join(dir, "agent");
    await mkdir(agentDir, { recursive: true });

    // Write a minimal initial agent
    await Bun.write(
      join(agentDir, "task.ts"),
      `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`Answer this question concisely: \${JSON.stringify(inputs)}\\n\\nRespond in JSON: <json>{"response": "your answer"}</json>\`;
}

export function parseTaskResponse(response: string): { prediction: unknown } {
  try {
    const match = response.match(/<json>\\s*([\\s\\S]*?)\\s*<\\/json>/);
    if (match?.[1]) {
      const parsed = JSON.parse(match[1]);
      return { prediction: parsed.response ?? parsed };
    }
    return { prediction: response };
  } catch {
    return { prediction: "None" };
  }
}`,
    );

    await Bun.write(
      join(agentDir, "meta.ts"),
      `export function buildMetaPrompt(input: { repoPath: string }): string {
  return \`Modify any part of the codebase at '\${input.repoPath}'.\`;
}`,
    );

    const domain: DomainConfig = {
      name: "trivia",
      trainCases: [
        {
          id: "t1",
          input: { question: "What color is the sky on a clear day?" },
          expected: { answer: "blue" },
        },
        {
          id: "t2",
          input: { question: "What is 2+2?" },
          expected: { answer: "4" },
        },
      ],
      testCases: [],
      scorer: async (output: unknown, expected) => {
        const exp = (expected.expected as { answer: string }).answer.toLowerCase();
        const out = String(output).toLowerCase();
        return out.includes(exp) ? 1 : 0;
      },
    };

    const evalConfig: EvalConfig = {
      domains: [domain],
      stagedEval: {
        stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
        defaultScore: 0,
      },
      parentSelectionScore: "training",
    };

    const config: RunConfig = {
      iterations: 1,
      k: 1,
      topM: 3,
      lambda: 10,
      initialAgentPath: agentDir,
      outputDir: join(dir, "output"),
      llm: {
        diagnosis: ROLE_CONFIG,
        modification: ROLE_CONFIG,
        evaluation: ROLE_CONFIG,
      },
      budget: {
        maxTokensPerIteration: 500_000,
        maxTotalTokens: 2_000_000,
        maxCostUSD: 5,
        pauseOnBudgetExhausted: true,
        warnAtPercentage: 80,
      },
      sandbox: {
        limits: {
          maxWallTimeSeconds: 120,
          maxMemoryMB: 512,
          maxLLMCalls: 10,
          networkAccess: "llm-only",
        },
      },
      eval: evalConfig,
      protectedPaths: [],
      editableSelection: false,
    };

    const events: string[] = [];
    const provider = new AnthropicProvider();

    const result = await runEvolutionLoop(provider, config, (event) => {
      events.push(event.type);
    });

    // Should have completed
    expect(result.totalIterations).toBe(1);
    expect(result.bestScore).toBeGreaterThanOrEqual(0);

    // Should have emitted expected events
    expect(events).toContain("eval_complete"); // Initial agent evaluated
    expect(events).toContain("iteration_start");
    expect(events).toContain("iteration_end");
    expect(events).toContain("run_complete");

    // Archive should exist
    const archive = new Archive(join(dir, "output"));
    try {
      expect(archive.size()).toBeGreaterThanOrEqual(1); // At least initial agent
      const best = archive.topK(1)[0];
      expect(best).toBeDefined();
      console.log(`  Best agent: ${best!.id}, score: ${getAverageScore(best!)}`);
    } finally {
      archive.close();
    }

    console.log(`  Events: ${events.join(" -> ")}`);
    console.log(`  Best score: ${result.bestScore}`);
  }, 120_000); // 2 minute timeout for full loop
});
