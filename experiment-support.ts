#!/usr/bin/env bun
/**
 * Experiment: Customer support response quality.
 *
 * The agent must generate helpful, empathetic support responses.
 * Scored on: helpfulness, tone, accuracy, and actionability.
 *
 * Starting from a minimal prompt — let evolution discover good support patterns.
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
// Evaluation data: customer support quality
// ---------------------------------------------------------------------------

const TRAIN_CASES = [
  {
    id: "s1",
    input: {
      customer: "I've been waiting 3 weeks for my order #12345. This is ridiculous. I want a refund NOW.",
      context: "Order was shipped but tracking shows stuck in transit for 2 weeks.",
    },
    expected: {
      tone: "empathetic",
      acknowledges_frustration: true,
      offers_solution: true,
      mentions_order_number: true,
      provides_next_steps: true,
    },
  },
  {
    id: "s2",
    input: {
      customer: "How do I reset my password? The reset email never arrives.",
      context: "Customer's email is on a corporate domain that sometimes blocks automated emails.",
    },
    expected: {
      tone: "helpful",
      provides_workaround: true,
      suggests_alternative: true,
      explains_possible_cause: true,
    },
  },
  {
    id: "s3",
    input: {
      customer: "Your product broke after 2 days. This is the worst thing I've ever bought. I'm telling everyone not to buy from you.",
      context: "Product has 30-day warranty. Common issue is battery not charging — usually fixed by firmware update.",
    },
    expected: {
      tone: "empathetic",
      acknowledges_frustration: true,
      offers_troubleshooting: true,
      mentions_warranty: true,
      avoids_being_defensive: true,
    },
  },
  {
    id: "s4",
    input: {
      customer: "I was charged twice for subscription. Please fix immediately.",
      context: "System shows duplicate charge. Refund process takes 3-5 business days.",
    },
    expected: {
      tone: "apologetic",
      confirms_issue: true,
      explains_resolution: true,
      provides_timeline: true,
    },
  },
  {
    id: "s5",
    input: {
      customer: "Can I upgrade my plan mid-cycle? Will I lose my data?",
      context: "Upgrades are prorated. No data loss occurs during upgrade.",
    },
    expected: {
      tone: "helpful",
      answers_both_questions: true,
      explains_prorating: true,
      reassures_about_data: true,
    },
  },
  {
    id: "s6",
    input: {
      customer: "I accidentally deleted my project. Is there any way to recover it?",
      context: "Soft-delete: projects recoverable within 30 days from trash. After that, backups kept for 90 days but require support ticket.",
    },
    expected: {
      tone: "reassuring",
      provides_recovery_steps: true,
      mentions_trash: true,
      mentions_backup_option: true,
      provides_timeline: true,
    },
  },
];

const TEST_CASES = [
  {
    id: "test1",
    input: {
      customer: "I need to cancel but I'm locked into an annual plan. This feels like a scam.",
      context: "Annual plans have a 14-day cancellation window. Customer is on day 45. Partial refund possible at manager discretion.",
    },
    expected: {
      tone: "empathetic",
      explains_policy: true,
      offers_alternative: true,
      avoids_being_defensive: true,
    },
  },
];

// ---------------------------------------------------------------------------
// Scorer: LLM-as-judge for support quality
// ---------------------------------------------------------------------------

let judgeProvider: AnthropicProvider | null = null;

async function scorer(output: unknown, evalCase: { expected: unknown }): Promise<number> {
  if (!judgeProvider) judgeProvider = new AnthropicProvider();

  const expected = evalCase.expected as Record<string, unknown>;
  const response = typeof output === "object" && output !== null
    ? JSON.stringify(output)
    : String(output);

  const criteria = Object.entries(expected)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const judgeResponse = await judgeProvider.chat(
    [
      {
        role: "user",
        content: `Rate this customer support response on a scale of 0.0 to 1.0.

CRITERIA:
${criteria}

RESPONSE TO EVALUATE:
"""
${response}
"""

Score each criterion as met (1) or not met (0), then average them.
Return ONLY a JSON object: {"score": <number between 0 and 1>}`,
      },
    ],
    {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0,
    },
  );

  try {
    const parsed = JSON.parse(
      judgeResponse.content.match(/\{[\s\S]*\}/)?.[0] ?? "{}",
    );
    return Math.max(0, Math.min(1, parsed.score ?? 0));
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-support-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-support-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-sonnet-4-20250514",
  temperature: 0,
};

const supportDomain: DomainConfig = {
  name: "customer-support",
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

const evalConfig: EvalConfig = {
  domains: [supportDomain],
  stagedEval,
  parentSelectionScore: "training",
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
  eval: evalConfig,
  protectedPaths: [],
  editableSelection: false,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Evolve Experiment: Customer Support Quality ===\n");
  console.log(`  Iterations: ${config.iterations}, k: ${config.k}`);
  console.log(`  Train cases: ${TRAIN_CASES.length}`);
  console.log(`  Scorer: LLM-as-judge (Claude Sonnet)`);
  console.log(`  Model: ${ROLE_CONFIG.model}`);
  console.log(`  Budget: $${config.budget.maxCostUSD}\n`);

  await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(AGENT_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(AGENT_DIR, { recursive: true });

  // Minimal initial agent
  await Bun.write(
    join(AGENT_DIR, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`You are a support agent. Respond to the customer.

\${JSON.stringify(inputs)}\`;
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
  return \`You are a meta-agent improving a customer support chatbot.

## Current Performance
\${scores}
Best archive score: \${input.archiveSummary.bestScore.toFixed(3)}
Remaining iterations: \${input.remainingIterations}

## Task
The agent receives customer messages with context and must generate high-quality support responses.
Scored by an LLM judge on: tone, empathy, helpfulness, accuracy, actionability, and whether it
addresses the customer's specific concerns.

## What to Modify
Edit task.ts at '\${input.repoPath}' to improve the buildTaskPrompt function.
The function receives { customer: string, context: string } and returns a prompt string.

Focus on:
- Empathetic opening that acknowledges the customer's feelings
- Using the context to provide accurate, specific solutions
- Clear next steps and timelines
- Professional but warm tone
- Avoiding defensive or dismissive language\`;
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
      case "budget_warning":
        console.log(`  ⚠ Budget: ${event.percentUsed.toFixed(0)}% ($${event.estimatedCostUSD.toFixed(2)})`);
        break;
      case "run_complete":
        console.log(`\n=== COMPLETE ===`);
        console.log(`  Best: ${event.bestAgentId} (score: ${event.bestScore.toFixed(4)})`);
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
    console.log("  Gen  | Best     | Avg      | Agents");
    console.log("  -----|----------|----------|-------");
    for (const p of progression) {
      console.log(
        `  ${String(p.generation).padStart(4)} | ${p.bestScore.toFixed(4).padStart(8)} | ${p.avgScore.toFixed(4).padStart(8)} | ${p.agentCount}`,
      );
    }

    console.log("\nAll Agents:");
    for (const e of entries) {
      const score = getAverageScore(e);
      console.log(`  ${e.id} (gen ${e.generation}) — score: ${score.toFixed(4)}, parent: ${e.parentId ?? "none"}`);
    }

    const best = archive.topK(1)[0];
    if (best) {
      const bestTaskPath = join(best.repoSnapshot, "task.ts");
      if (await Bun.file(bestTaskPath).exists()) {
        const taskCode = await Bun.file(bestTaskPath).text();
        const initialCode = await Bun.file(join(AGENT_DIR, "task.ts")).text();
        if (taskCode !== initialCode) {
          console.log("\nBest Agent's task.ts (evolved):");
          console.log("─".repeat(60));
          console.log(taskCode.slice(0, 3000));
          console.log("─".repeat(60));
        }
      }
    }

    const initial = entries.find((e) => e.generation === 0);
    if (initial && best) {
      const imp = getAverageScore(best) - getAverageScore(initial);
      console.log(`\nImprovement: ${getAverageScore(initial).toFixed(4)} → ${getAverageScore(best).toFixed(4)} (+${imp.toFixed(4)})`);
    }
    console.log(`Elapsed: ${elapsed}s | Agents: ${entries.length}`);
  } finally {
    archive.close();
  }
}

main().catch(console.error);
