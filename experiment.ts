#!/usr/bin/env bun
/**
 * Quick experiment: Run the data-extraction evolution with real Anthropic API.
 * 1 iteration, k=1 (1 modification attempt), 6 train cases for speed.
 */

import { join, resolve } from "node:path";
import { mkdir, cp, rm } from "node:fs/promises";
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
// Evaluation data: extract structured info from messy text (subset for speed)
// ---------------------------------------------------------------------------

interface ExtractedData {
  name: string;
  email: string;
  company: string;
  role: string;
}

const TRAIN_CASES = [
  {
    id: "t1",
    input: "Hi, I'm Sarah Chen from Acme Corp. I'm the VP of Engineering. You can reach me at schen@acme.com",
    expected: { name: "Sarah Chen", email: "schen@acme.com", company: "Acme Corp", role: "VP of Engineering" },
  },
  {
    id: "t2",
    input: "My name is James Rodriguez, james.r@globex.io — I lead the data science team at Globex Industries",
    expected: { name: "James Rodriguez", email: "james.r@globex.io", company: "Globex Industries", role: "data science team lead" },
  },
  {
    id: "t3",
    input: "Sent from my iPhone\n\nBest regards,\nMike Thompson\nSenior Product Manager\nWidgetWorks Inc.\nmike.t@widgetworks.com",
    expected: { name: "Mike Thompson", email: "mike.t@widgetworks.com", company: "WidgetWorks Inc.", role: "Senior Product Manager" },
  },
  {
    id: "t4",
    input: "Marcus Johnson | Lead Software Engineer | DataStream Analytics | m.johnson@datastream.io",
    expected: { name: "Marcus Johnson", email: "m.johnson@datastream.io", company: "DataStream Analytics", role: "Lead Software Engineer" },
  },
  {
    id: "t5",
    input: "rachel.green@fashionfw.com — Rachel Green, Creative Director, Fashion Forward Inc",
    expected: { name: "Rachel Green", email: "rachel.green@fashionfw.com", company: "Fashion Forward Inc", role: "Creative Director" },
  },
  {
    id: "t6",
    input: "Per our call, here are my details:\nRaj Krishnamurthy, Staff Engineer\nInfraCloud (raj.k@infracloud.io)",
    expected: { name: "Raj Krishnamurthy", email: "raj.k@infracloud.io", company: "InfraCloud", role: "Staff Engineer" },
  },
];

const TEST_CASES = [
  {
    id: "test1",
    input: "Message from: Chen Wei <chenwei@startuphub.cn>, Founder of StartupHub Asia",
    expected: { name: "Chen Wei", email: "chenwei@startuphub.cn", company: "StartupHub Asia", role: "Founder" },
  },
  {
    id: "test2",
    input: "Hey it's Ben from SkyNet AI (not the evil one lol). I do ML engineering. ben.zhao@skynetai.dev",
    expected: { name: "Ben", email: "ben.zhao@skynetai.dev", company: "SkyNet AI", role: "ML engineering" },
  },
];

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

function normalizeStr(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9@.]/g, " ").replace(/\s+/g, " ");
}

function fieldScore(actual: string | undefined, expected: string): number {
  if (!actual) return 0;
  const a = normalizeStr(actual);
  const e = normalizeStr(expected);
  if (a === e) return 1;
  if (a.includes(e) || e.includes(a)) return 0.6;
  return 0;
}

async function scorer(output: unknown, evalCase: { expected: unknown }): Promise<number> {
  const expected = evalCase.expected as ExtractedData;
  let extracted: ExtractedData;

  try {
    if (typeof output === "string") {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      } else {
        extracted = { name: "", email: "", company: "", role: "" };
      }
    } else if (typeof output === "object" && output !== null) {
      extracted = output as ExtractedData;
    } else {
      return 0;
    }
  } catch {
    return 0;
  }

  const scores = [
    fieldScore(extracted.name, expected.name) * 0.25,
    fieldScore(extracted.email, expected.email) * 0.35,
    fieldScore(extracted.company, expected.company) * 0.2,
    fieldScore(extracted.role, expected.role) * 0.2,
  ];

  return scores.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-opus-4-6",
  temperature: 0,
};

const extractionDomain: DomainConfig = {
  name: "data-extraction",
  trainCases: TRAIN_CASES,
  testCases: TEST_CASES,
  scorer,
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      email: { type: "string" },
      company: { type: "string" },
      role: { type: "string" },
    },
    required: ["name", "email", "company", "role"],
    additionalProperties: false,
  },
};

const stagedEval: StagedEvalConfig = {
  stages: [
    { taskCount: 6, passThreshold: 0, passCondition: "any" },
  ],
  defaultScore: 0,
};

const evalConfig: EvalConfig = {
  domains: [extractionDomain],
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
    maxTotalTokens: 2_000_000,
    maxCostUSD: 5,
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
  console.log("=== Evolve Experiment: Data Extraction ===\n");
  console.log(`  Iterations: ${config.iterations}, k: ${config.k}`);
  console.log(`  Train cases: ${TRAIN_CASES.length}, Test cases: ${TEST_CASES.length}`);
  console.log(`  Model: ${ROLE_CONFIG.model}`);
  console.log(`  Budget: $${config.budget.maxCostUSD}\n`);

  // Clean previous output
  await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(AGENT_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(AGENT_DIR, { recursive: true });

  // Write initial agent (intentionally vague to leave room for evolution)
  await Bun.write(
    join(AGENT_DIR, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`You are an agent. Process this input and respond with relevant information.

Input: \${JSON.stringify(inputs)}\`;
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
  return \`You are a meta-agent that improves task-solving agents.

## Current Performance
\${scores}
Best archive score: \${input.archiveSummary.bestScore.toFixed(3)}
Remaining iterations: \${input.remainingIterations}

## Task Description
The agent extracts structured data from unstructured text. It must return a JSON object
with these exact fields: { name, email, company, role }

The scorer uses partial credit with fuzzy matching:
- email (35% weight): exact match or substring
- name (25% weight): exact or fuzzy word match
- company (20% weight): exact or fuzzy word match
- role (20% weight): exact or fuzzy word match

## What to Modify
Edit task.ts at '\${input.repoPath}' to improve the buildTaskPrompt function.
The function receives the raw input text as JSON and must return a prompt string.

CRITICAL: The LLM response MUST be a flat JSON object with keys: name, email, company, role.
Do NOT change the output format. The scorer expects these exact keys.

Focus on:
- Better extraction instructions for each field type
- Handling varied input formats (email signatures, LinkedIn, pipe-delimited, etc.)
- Email regex patterns
- Role normalization\`;
}`,
  );

  const provider = new AnthropicProvider();
  const startTime = Date.now();

  const emit = (event: EvolveEvent) => {
    switch (event.type) {
      case "eval_complete": {
        const scoreStr = event.scores
          .map((s) => `${s.domain}=${s.trainScore.toFixed(3)}`)
          .join(", ");
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

  // Show results
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

    // Show best agent's evolved task.ts
    const best = archive.topK(1)[0];
    if (best) {
      const bestTaskPath = join(best.repoSnapshot, "task.ts");
      if (await Bun.file(bestTaskPath).exists()) {
        const taskCode = await Bun.file(bestTaskPath).text();
        console.log("\nBest Agent's task.ts:");
        console.log("─".repeat(60));
        console.log(taskCode);
        console.log("─".repeat(60));
      }
    }

    console.log(`\nElapsed: ${elapsed}s | Agents: ${entries.length} | Best: ${result.bestScore.toFixed(4)}`);
  } finally {
    archive.close();
  }
}

main().catch(console.error);
