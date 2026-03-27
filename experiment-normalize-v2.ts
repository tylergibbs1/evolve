#!/usr/bin/env bun
/**
 * Evolution experiment: Messy Data Normalization
 * The meta agent must discover exact target formats from scoring feedback alone.
 * 3 iterations, k=2, budget $8.
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
// Types
// ---------------------------------------------------------------------------

interface NormalizedRecord {
  date_iso: string;
  phone_e164: string;
  amount_normalized: string;
  name_normalized: string;
}

interface RawRecord {
  raw_date: string;
  raw_phone: string;
  raw_amount: string;
  raw_name: string;
}

// ---------------------------------------------------------------------------
// Evaluation data
// ---------------------------------------------------------------------------

// Split into per-record eval cases so the meta agent gets granular per-record scores
const TRAIN_CASES = [
  {
    id: "t1",
    input: [{ raw_date: "03/04/2024", raw_phone: "(212) 555-1234", raw_amount: "$1,500", raw_name: "Dr. John Smith" }],
    expected: { records: [{ date_iso: "2024-03-04", phone_e164: "+12125551234", amount_normalized: "1500.00 USD", name_normalized: "Smith, John" }] },
  },
  {
    id: "t2",
    input: [{ raw_date: "12/11/2023", raw_phone: "1-800-555-6789", raw_amount: "€2.500,50", raw_name: "MARIA GARCIA-LOPEZ" }],
    expected: { records: [{ date_iso: "2023-12-11", phone_e164: "+18005556789", amount_normalized: "2500.50 EUR", name_normalized: "Garcia-Lopez, Maria" }] },
  },
  {
    id: "t3",
    input: [{ raw_date: "6/7/24", raw_phone: "5551234567", raw_amount: "45.5 kg", raw_name: "mr. james o'brien jr." }],
    expected: { records: [{ date_iso: "2024-06-07", phone_e164: "+15551234567", amount_normalized: "45.50 kg", name_normalized: "O'Brien, James" }] },
  },
  {
    id: "t4",
    input: [{ raw_date: "11-01-2025", raw_phone: "+1 (415) 555.0199", raw_amount: "£3,200.00", raw_name: "Sarah J. Connor" }],
    expected: { records: [{ date_iso: "2025-11-01", phone_e164: "+14155550199", amount_normalized: "3200.00 GBP", name_normalized: "Connor, Sarah J." }] },
  },
  {
    id: "t5",
    input: [{ raw_date: "07/08/2024", raw_phone: "212.555.8877", raw_amount: "0.75 miles", raw_name: "Kim, Soo-yeon" }],
    expected: { records: [{ date_iso: "2024-07-08", phone_e164: "+12125558877", amount_normalized: "0.75 miles", name_normalized: "Kim, Soo-Yeon" }] },
  },
  {
    id: "t6",
    input: [{ raw_date: "1/15/2025", raw_phone: "(800)5553000", raw_amount: "¥150,000", raw_name: "ROBERT CHEN III" }],
    expected: { records: [{ date_iso: "2025-01-15", phone_e164: "+18005553000", amount_normalized: "150000.00 JPY", name_normalized: "Chen, Robert" }] },
  },
];

const TEST_CASES = [
  {
    id: "test1",
    input: [{ raw_date: "02/03/2025", raw_phone: "1 (646) 555-2211", raw_amount: "CHF 4'500.00", raw_name: "Dr. Anna-Maria ROSSI" }],
    expected: { records: [{ date_iso: "2025-02-03", phone_e164: "+16465552211", amount_normalized: "4500.00 CHF", name_normalized: "Rossi, Anna-Maria" }] },
  },
  {
    id: "test2",
    input: [{ raw_date: "9/10/24", raw_phone: "555-0101", raw_amount: "2.5 liters", raw_name: "lee, min-jun" }],
    expected: { records: [{ date_iso: "2024-09-10", phone_e164: "+15550101", amount_normalized: "2.50 liters", name_normalized: "Lee, Min-Jun" }] },
  },
];

// ---------------------------------------------------------------------------
// Scorer — exact string match per field, averaged across records
// ---------------------------------------------------------------------------

async function scorer(
  output: unknown,
  evalCase: { expected: unknown },
): Promise<number> {
  const expected = evalCase.expected as { records: NormalizedRecord[] };

  let parsed: { records: NormalizedRecord[] };
  try {
    if (typeof output === "string") {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return 0;
      }
    } else if (typeof output === "object" && output !== null) {
      parsed = output as { records: NormalizedRecord[] };
    } else {
      return 0;
    }
  } catch {
    return 0;
  }

  if (!Array.isArray(parsed.records)) return 0;

  const expectedRecords = expected.records;
  const actualRecords = parsed.records;

  // Score based on the number of expected records (don't reward extra)
  const recordCount = expectedRecords.length;
  if (recordCount === 0) return 0;

  let totalScore = 0;
  for (let i = 0; i < recordCount; i++) {
    const exp = expectedRecords[i];
    const act = actualRecords[i];
    if (!act) continue;

    const fields: (keyof NormalizedRecord)[] = [
      "date_iso",
      "phone_e164",
      "amount_normalized",
      "name_normalized",
    ];

    let matched = 0;
    for (const field of fields) {
      if (act[field] === exp[field]) {
        matched++;
      }
    }
    totalScore += matched / fields.length;
  }

  return totalScore / recordCount;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-normalize-v2-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-normalize-v2-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-opus-4-6",
  temperature: 0,
};

const normalizationDomain: DomainConfig = {
  name: "data-normalization",
  trainCases: TRAIN_CASES,
  testCases: TEST_CASES,
  scorer,
  outputSchema: {
    type: "object",
    properties: {
      records: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date_iso: { type: "string" },
            phone_e164: { type: "string" },
            amount_normalized: { type: "string" },
            name_normalized: { type: "string" },
          },
          required: ["date_iso", "phone_e164", "amount_normalized", "name_normalized"],
          additionalProperties: false,
        },
      },
    },
    required: ["records"],
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
  domains: [normalizationDomain],
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
  console.log("=== Evolve Experiment: Messy Data Normalization ===\n");
  console.log(`  Iterations: ${config.iterations}, k: ${config.k}`);
  console.log(`  Train cases: ${TRAIN_CASES.length}, Test cases: ${TEST_CASES.length}`);
  console.log(`  Model: ${ROLE_CONFIG.model}`);
  console.log(`  Budget: $${config.budget.maxCostUSD}\n`);

  // Clean previous output
  await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(AGENT_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(AGENT_DIR, { recursive: true });

  // Write initial agent — intentionally vague to leave room for evolution
  await Bun.write(
    join(AGENT_DIR, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`You are an agent. Clean up this data.

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
  return \`You are a meta-agent that improves data normalization agents.

## Current Performance
\${scores}
Best archive score: \${input.archiveSummary.bestScore.toFixed(3)}
Remaining iterations: \${input.remainingIterations}

## Task Description
The agent normalizes messy data records. Each input is an array of raw records with fields:
raw_date, raw_phone, raw_amount, raw_name.

The output must be a JSON object with a "records" array where each record has:
{ date_iso, phone_e164, amount_normalized, name_normalized }

Scoring is EXACT STRING MATCH on each field — no partial credit. Each record scores
(fields_matched / 4) and the final score is the average across all records.

Here is ONE example of a correct transformation to help you discover the target formats:

Input:  { raw_date: "03/04/2024", raw_phone: "(212) 555-1234", raw_amount: "$1,500", raw_name: "Dr. John Smith" }
Output: { date_iso: "2024-03-04", phone_e164: "+12125551234", amount_normalized: "1500.00 USD", name_normalized: "Smith, John" }

Study this example carefully to infer the normalization rules for each field.
Each eval case is a single record — you get per-record scores to see which records pass or fail.

## Strategy
- Analyze the example to determine: date format, phone format, amount format, name format.
- Encode ALL the rules you discover into the task prompt with explicit instructions.
- Edge cases: European number formats, 2-digit years, missing country codes, currency
  symbol mapping ($→USD, €→EUR, £→GBP, ¥→JPY), non-currency units (kg, miles, liters),
  name titles (Dr., Mr.) and suffixes (Jr., III) to strip, hyphenated names, apostrophes.

## What to Modify
Edit task.ts at '\${input.repoPath}' to improve the buildTaskPrompt function.
The function receives the raw records array as JSON and must return a prompt string
that instructs the LLM to produce the correctly formatted output.

CRITICAL: The output MUST be a JSON object with a "records" array containing objects
with exactly these keys: date_iso, phone_e164, amount_normalized, name_normalized.
Do NOT change the output structure.\`;
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
