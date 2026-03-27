#!/usr/bin/env bun
/**
 * Experiment: Code generation with deterministic test-case scoring.
 *
 * The agent must generate JavaScript functions that pass test cases.
 * Scored by actually executing the generated code. No LLM judge — pure pass/fail.
 *
 * Starting from a minimal prompt, let evolution discover better code-gen strategies.
 */

import { join, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  AnthropicProvider,
  Archive,
  runEvolutionLoop,
  getAverageScore,
  scoreProgression,
  type DomainConfig,
  type EvalConfig,
  type EvolveEvent,
  type RunConfig,
  type StagedEvalConfig,
} from "@evolve/core";

// ---------------------------------------------------------------------------
// Evaluation data: generate JS functions that pass tests
// ---------------------------------------------------------------------------

const TRAIN_CASES = [
  {
    id: "c1",
    input: {
      task: "Write a function called `flatten` that deeply flattens a nested array.",
      tests: [
        { input: "[[1, [2, [3]]], 4]", expected: "[1, 2, 3, 4]" },
        { input: "[[1], [[2], [3, [4]]]]", expected: "[1, 2, 3, 4]" },
        { input: "[]", expected: "[]" },
        { input: "[1, 2, 3]", expected: "[1, 2, 3]" },
      ],
    },
    expected: { function_name: "flatten", test_count: 4 },
  },
  {
    id: "c2",
    input: {
      task: "Write a function called `isPalindrome` that checks if a string is a palindrome (ignoring case and non-alphanumeric characters).",
      tests: [
        { input: '"racecar"', expected: "true" },
        { input: '"A man, a plan, a canal: Panama"', expected: "true" },
        { input: '"hello"', expected: "false" },
        { input: '""', expected: "true" },
      ],
    },
    expected: { function_name: "isPalindrome", test_count: 4 },
  },
  {
    id: "c3",
    input: {
      task: "Write a function called `groupBy` that groups an array of objects by a given key.",
      tests: [
        {
          input: '[{name: "Alice", age: 25}, {name: "Bob", age: 25}, {name: "Carol", age: 30}], "age"',
          expected: '{"25": [{name: "Alice", age: 25}, {name: "Bob", age: 25}], "30": [{name: "Carol", age: 30}]}',
        },
        { input: '[], "key"', expected: '{}' },
      ],
    },
    expected: { function_name: "groupBy", test_count: 2 },
  },
  {
    id: "c4",
    input: {
      task: "Write a function called `debounce` that returns a debounced version of a function. The debounced function delays invoking func until after `wait` milliseconds have elapsed since the last time the debounced function was invoked.",
      tests: [
        { input: "manual_test", expected: "function" },
      ],
    },
    expected: { function_name: "debounce", test_count: 1 },
  },
  {
    id: "c5",
    input: {
      task: "Write a function called `memoize` that takes a function and returns a memoized version that caches results based on the first argument.",
      tests: [
        { input: "manual_test", expected: "function" },
      ],
    },
    expected: { function_name: "memoize", test_count: 1 },
  },
  {
    id: "c6",
    input: {
      task: "Write a function called `chunk` that splits an array into groups of the given size.",
      tests: [
        { input: "[1, 2, 3, 4, 5], 2", expected: "[[1, 2], [3, 4], [5]]" },
        { input: "[1, 2, 3], 1", expected: "[[1], [2], [3]]" },
        { input: "[], 3", expected: "[]" },
      ],
    },
    expected: { function_name: "chunk", test_count: 3 },
  },
];

const TEST_CASES = [
  {
    id: "test1",
    input: {
      task: "Write a function called `intersection` that returns the intersection of two arrays (unique values present in both).",
      tests: [
        { input: "[1, 2, 3, 4], [3, 4, 5, 6]", expected: "[3, 4]" },
        { input: "[1, 2], [3, 4]", expected: "[]" },
      ],
    },
    expected: { function_name: "intersection", test_count: 2 },
  },
];

// ---------------------------------------------------------------------------
// Scorer: extract code, run it, check test cases
// ---------------------------------------------------------------------------

async function scorer(output: unknown, evalCase: { expected: unknown; input: unknown }): Promise<number> {
  const input = evalCase.input as {
    task: string;
    tests: Array<{ input: string; expected: string }>;
  };
  const expected = evalCase.expected as { function_name: string; test_count: number };

  // Extract code from the response
  let code: string;
  if (typeof output === "object" && output !== null) {
    code = (output as Record<string, unknown>).code as string ??
           (output as Record<string, unknown>).response as string ??
           JSON.stringify(output);
  } else {
    code = String(output);
  }

  // Extract code block if wrapped in markdown
  const codeBlockMatch = code.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    code = codeBlockMatch[1]!;
  }

  // For manual tests (debounce, memoize), just check if the function is defined
  if (input.tests.length === 1 && input.tests[0]!.input === "manual_test") {
    try {
      const testCode = `${code}\nreturn typeof ${expected.function_name} === 'function';`;
      const result = new Function(testCode)();
      return result ? 1 : 0;
    } catch {
      return 0;
    }
  }

  // Run each test case
  let passed = 0;
  for (const test of input.tests) {
    try {
      const testCode = `${code}\nreturn JSON.stringify(${expected.function_name}(${test.input}));`;
      const result = new Function(testCode)();
      const expectedResult = test.expected;

      if (result === expectedResult) {
        passed++;
      } else {
        // Try parsing both as JSON for deep comparison
        try {
          const a = JSON.parse(result);
          const b = JSON.parse(expectedResult);
          if (JSON.stringify(a) === JSON.stringify(b)) passed++;
        } catch {
          // Not equal
        }
      }
    } catch {
      // Code threw an error
    }
  }

  return passed / input.tests.length;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-codegen-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-codegen-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-sonnet-4-20250514",
  temperature: 0,
};

const codegenDomain: DomainConfig = {
  name: "codegen",
  trainCases: TRAIN_CASES,
  testCases: TEST_CASES,
  scorer,
};

const stagedEval: StagedEvalConfig = {
  stages: [
    { taskCount: 6, passThreshold: 0, passCondition: "any" },
  ],
  defaultScore: 0,
};

const config: RunConfig = {
  iterations: 3,
  k: 2,
  topM: 3,
  lambda: 10,
  initialAgentPath: AGENT_DIR,
  outputDir: OUTPUT_DIR,
  llm: {
    diagnosis: ROLE_CONFIG,
    modification: ROLE_CONFIG,
    evaluation: ROLE_CONFIG,
  },
  budget: {
    maxTokensPerIteration: 500_000,
    maxTotalTokens: 3_000_000,
    maxCostUSD: 8,
    pauseOnBudgetExhausted: true,
    warnAtPercentage: 80,
  },
  sandbox: {
    limits: {
      maxWallTimeSeconds: 60,
      maxMemoryMB: 512,
      maxLLMCalls: 10,
      networkAccess: "llm-only",
    },
  },
  eval: {
    domains: [codegenDomain],
    stagedEval,
    parentSelectionScore: "training",
  },
  protectedPaths: [],
  editableSelection: false,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Evolve Experiment: Code Generation ===\n");
  console.log(`  Iterations: ${config.iterations}, k: ${config.k}`);
  console.log(`  Train cases: ${TRAIN_CASES.length} (${TRAIN_CASES.reduce((n, c) => n + (c.input as any).tests.length, 0)} test assertions)`);
  console.log(`  Scorer: deterministic (execute code + check output)`);
  console.log(`  Model: ${ROLE_CONFIG.model}\n`);

  await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(AGENT_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(AGENT_DIR, { recursive: true });

  // Minimal initial agent
  await Bun.write(
    join(AGENT_DIR, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`Write the requested JavaScript function.

\${JSON.stringify(inputs)}

Return your code.\`;
}`,
  );

  await Bun.write(
    join(AGENT_DIR, "meta.ts"),
    `export function buildMetaPrompt(input: {
  repoPath: string;
  evalHistory: Array<{ domain: string; score: number; feedback?: string }>;
  remainingIterations: number;
  archiveSummary: { totalAgents: number; bestScore: number; averageScore: number };
}): string {
  const scores = input.evalHistory.map(e => \`  \${e.domain}: \${e.score.toFixed(3)}\`).join("\\n");
  return \`You are a meta-agent improving a code generation agent.

## Current Performance
\${scores}
Best archive score: \${input.archiveSummary.bestScore.toFixed(3)}

## Task
The agent receives coding tasks with test cases and must generate JavaScript functions.
The code is extracted from the response, then executed against test cases.
Score = fraction of test cases that pass.

## Scoring Details
- Code is extracted from markdown code blocks (if present) or raw text
- Each test case runs: functionName(input) and compares JSON.stringify of result to expected
- Functions must be standalone (no imports, no module syntax)

## What to Modify
Edit task.ts at '\${input.repoPath}'. The buildTaskPrompt function receives:
{ task: string, tests: Array<{input: string, expected: string}> }

Improve the prompt to:
- Instruct the LLM to write clean standalone JS functions
- Tell it to use the exact function name specified in the task
- Show it the test cases so it knows the expected behavior
- Tell it to return ONLY the function code, no explanation
- Handle edge cases (empty arrays, etc.)\`;
}`,
  );

  const provider = new AnthropicProvider();
  const startTime = Date.now();

  const emit = (event: EvolveEvent) => {
    switch (event.type) {
      case "eval_complete": {
        const scoreStr = event.scores.map((s) => `${s.domain}=${s.trainScore.toFixed(3)}`).join(", ");
        console.log(`  [eval] ${event.agentId}: ${scoreStr}`);
        break;
      }
      case "iteration_start":
        console.log(`\n--- Iteration ${event.iteration}/${config.iterations} ---`);
        console.log(`  Parents: ${event.parentIds.join(", ")}`);
        break;
      case "iteration_end":
        console.log(`  Created ${event.newAgentIds.length} new agent(s)`);
        break;
      case "agent_created":
        console.log(`  [new] ${event.agentId} (parent: ${event.parentId}, gen ${event.generation})`);
        break;
      case "run_complete":
        console.log(`\n=== COMPLETE: Best ${event.bestAgentId} (${event.bestScore.toFixed(4)}) ===`);
        break;
    }
  };

  console.log("Starting evolution...\n");
  const result = await runEvolutionLoop(provider, config, emit);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const archive = new Archive(OUTPUT_DIR);
  try {
    const entries = archive.entries();
    const progression = scoreProgression(entries);

    console.log("\nScore Progression:");
    for (const p of progression) {
      console.log(`  Gen ${p.generation}: best=${p.bestScore.toFixed(4)}, avg=${p.avgScore.toFixed(4)}, agents=${p.agentCount}`);
    }

    console.log("\nAll Agents:");
    for (const e of entries) {
      console.log(`  ${e.id} (gen ${e.generation}) — ${getAverageScore(e).toFixed(4)}, parent: ${e.parentId ?? "none"}`);
    }

    const best = archive.topK(1)[0];
    if (best) {
      const bestTaskPath = join(best.repoSnapshot, "task.ts");
      if (await Bun.file(bestTaskPath).exists()) {
        const taskCode = await Bun.file(bestTaskPath).text();
        console.log("\nBest Agent's task.ts:");
        console.log("─".repeat(60));
        console.log(taskCode.slice(0, 3000));
        console.log("─".repeat(60));
      }
    }

    const initial = entries.find((e) => e.generation === 0);
    if (initial && best) {
      const imp = getAverageScore(best) - getAverageScore(initial);
      console.log(`\nImprovement: ${getAverageScore(initial).toFixed(4)} → ${getAverageScore(best).toFixed(4)} (+${imp.toFixed(4)})`);
    }
    console.log(`Elapsed: ${elapsed}s`);
  } finally {
    archive.close();
  }
}

main().catch(console.error);
