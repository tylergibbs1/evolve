#!/usr/bin/env bun
/**
 * Real-world scenario: Data Extraction from unstructured text.
 *
 * The agent must extract structured fields (name, email, company, role)
 * from messy, varied input text. This is a task where:
 * - The naive single-LLM-call agent gets ~60-70% right
 * - Better prompting, field validation, and extraction strategies help
 * - The meta agent can discover improvements like regex post-processing,
 *   multi-pass extraction, and structured output formats
 *
 * Runs 3 iterations with k=2 (6 total modification attempts).
 */

import { join, resolve } from "node:path";
import { mkdir, cp, rm } from "node:fs/promises";
import {
  AnthropicProvider,
  Archive,
  BudgetTracker,
  runEvolutionLoop,
  getAverageScore,
  scoreProgression,
  type DomainConfig,
  type EvalConfig,
  type EvalFeedback,
  type EvolveEvent,
  type RunConfig,
  type StagedEvalConfig,
} from "@evolve/core";

// ---------------------------------------------------------------------------
// Evaluation data: extract structured info from messy text
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
    input: "Priya Patel here, CTO at Initech (priya@initech.co). Happy to chat about our infrastructure needs.",
    expected: { name: "Priya Patel", email: "priya@initech.co", company: "Initech", role: "CTO" },
  },
  {
    id: "t4",
    input: "Sent from my iPhone\n\nBest regards,\nMike Thompson\nSenior Product Manager\nWidgetWorks Inc.\nmike.t@widgetworks.com",
    expected: { name: "Mike Thompson", email: "mike.t@widgetworks.com", company: "WidgetWorks Inc.", role: "Senior Product Manager" },
  },
  {
    id: "t5",
    input: "Contact: Dr. Lisa Wang (lwang@biohealth.org), she's the research director over at BioHealth Labs",
    expected: { name: "Lisa Wang", email: "lwang@biohealth.org", company: "BioHealth Labs", role: "research director" },
  },
  {
    id: "t6",
    input: "Hey! Tom Baker from CloudNine Software. I do DevOps stuff. tom@cloudnine.dev if you need me",
    expected: { name: "Tom Baker", email: "tom@cloudnine.dev", company: "CloudNine Software", role: "DevOps" },
  },
  {
    id: "t7",
    input: "RE: Partnership inquiry\n\nThanks for reaching out. I'm Anna Kowalski, heading up BD at FreshFoods Co.\nEmail: anna.k@freshfoods.com",
    expected: { name: "Anna Kowalski", email: "anna.k@freshfoods.com", company: "FreshFoods Co.", role: "BD" },
  },
  {
    id: "t8",
    input: "Marcus Johnson | Lead Software Engineer | DataStream Analytics | m.johnson@datastream.io",
    expected: { name: "Marcus Johnson", email: "m.johnson@datastream.io", company: "DataStream Analytics", role: "Lead Software Engineer" },
  },
  {
    id: "t9",
    input: "FYI this is from our CEO Yuki Tanaka (yuki@nexgen.jp) at NexGen Robotics",
    expected: { name: "Yuki Tanaka", email: "yuki@nexgen.jp", company: "NexGen Robotics", role: "CEO" },
  },
  {
    id: "t10",
    input: "rachel.green@fashionfw.com — Rachel Green, Creative Director, Fashion Forward Inc",
    expected: { name: "Rachel Green", email: "rachel.green@fashionfw.com", company: "Fashion Forward Inc", role: "Creative Director" },
  },
  {
    id: "t11",
    input: "Hi there, David Kim speaking. I'm with Quantum Computing Labs as a principal researcher. My work email is dkim@quantumlabs.edu",
    expected: { name: "David Kim", email: "dkim@quantumlabs.edu", company: "Quantum Computing Labs", role: "principal researcher" },
  },
  {
    id: "t12",
    input: "-- \nEmma Wilson\nHead of Marketing, SustainableTech\nemma@sustainabletech.green\n+1 (555) 123-4567",
    expected: { name: "Emma Wilson", email: "emma@sustainabletech.green", company: "SustainableTech", role: "Head of Marketing" },
  },
  {
    id: "t13",
    input: "I'm the intern who emailed you last week. Alex Rivera, alex.rivera@bigcorp.com. I work at BigCorp International in the sales department.",
    expected: { name: "Alex Rivera", email: "alex.rivera@bigcorp.com", company: "BigCorp International", role: "sales" },
  },
  {
    id: "t14",
    input: "Forwarded message from: Omar Hassan <omar@cyberdefend.net>\nOmar is our CISO at CyberDefend Systems",
    expected: { name: "Omar Hassan", email: "omar@cyberdefend.net", company: "CyberDefend Systems", role: "CISO" },
  },
  {
    id: "t15",
    input: "Nina Petrova\nFounder & CEO\nArtisanAI (www.artisanai.com)\nnina.p@artisanai.com",
    expected: { name: "Nina Petrova", email: "nina.p@artisanai.com", company: "ArtisanAI", role: "Founder & CEO" },
  },
  {
    id: "t16",
    input: "Just spoke to Carlos Mendez who runs ops at LogiFlow. His email is carlos@logiflow.com",
    expected: { name: "Carlos Mendez", email: "carlos@logiflow.com", company: "LogiFlow", role: "ops" },
  },
  {
    id: "t17",
    input: "linkedin.com/in/sophieturner | Sophie Turner | VP Sales @ TechVentures Group | sophie.t@techventures.com",
    expected: { name: "Sophie Turner", email: "sophie.t@techventures.com", company: "TechVentures Group", role: "VP Sales" },
  },
  {
    id: "t18",
    input: "Per our call, here are my details:\nRaj Krishnamurthy, Staff Engineer\nInfraCloud (raj.k@infracloud.io)",
    expected: { name: "Raj Krishnamurthy", email: "raj.k@infracloud.io", company: "InfraCloud", role: "Staff Engineer" },
  },
];

// Held-out test cases (not used during evolution, only for final eval)
const TEST_CASES = [
  {
    id: "test1",
    input: "Message from: Chen Wei <chenwei@startuphub.cn>, Founder of StartupHub Asia",
    expected: { name: "Chen Wei", email: "chenwei@startuphub.cn", company: "StartupHub Asia", role: "Founder" },
  },
  {
    id: "test2",
    input: "This is Maria Santos, the compliance officer at FinanceFirst (maria.santos@financefirst.com)",
    expected: { name: "Maria Santos", email: "maria.santos@financefirst.com", company: "FinanceFirst", role: "compliance officer" },
  },
  {
    id: "test3",
    input: "Aisha Johnson — aisha@greenearth.org — Program Director — GreenEarth Foundation",
    expected: { name: "Aisha Johnson", email: "aisha@greenearth.org", company: "GreenEarth Foundation", role: "Program Director" },
  },
  {
    id: "test4",
    input: "Hey it's Ben from SkyNet AI (not the evil one lol). I do ML engineering. ben.zhao@skynetai.dev",
    expected: { name: "Ben", email: "ben.zhao@skynetai.dev", company: "SkyNet AI", role: "ML engineering" },
  },
];

// ---------------------------------------------------------------------------
// Scorer: partial credit per field with fuzzy matching
// ---------------------------------------------------------------------------

function normalizeStr(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9@.]/g, " ").replace(/\s+/g, " ");
}

function fieldScore(actual: string | undefined, expected: string): number {
  if (!actual) return 0;
  const a = normalizeStr(actual);
  const e = normalizeStr(expected);
  if (a === e) return 1;
  if (a.includes(e) || e.includes(a)) return 0.8;
  // Check if all words of expected appear in actual
  const expectedWords = e.split(" ").filter(Boolean);
  const matchedWords = expectedWords.filter((w) => a.includes(w));
  if (matchedWords.length === expectedWords.length) return 0.7;
  if (matchedWords.length > 0) return 0.3 * (matchedWords.length / expectedWords.length);
  return 0;
}

async function scorer(output: unknown, evalCase: { expected: unknown }): Promise<number> {
  const expected = evalCase.expected as ExtractedData;
  let extracted: ExtractedData;

  try {
    if (typeof output === "string") {
      // Try to parse JSON from the output
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
    fieldScore(extracted.email, expected.email) * 0.35, // Email is most important
    fieldScore(extracted.company, expected.company) * 0.2,
    fieldScore(extracted.role, expected.role) * 0.2,
  ];

  return scores.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Domain configuration
// ---------------------------------------------------------------------------

const extractionDomain: DomainConfig = {
  name: "data-extraction",
  trainCases: TRAIN_CASES,
  testCases: TEST_CASES,
  scorer,
};

const stagedEval: StagedEvalConfig = {
  stages: [
    { taskCount: 6, passThreshold: 0, passCondition: "any" },    // Quick screen: 6 cases
    { taskCount: 18, passThreshold: 0.1, passCondition: "rate" }, // Full train: 18 cases
  ],
  defaultScore: 0,
};

const evalConfig: EvalConfig = {
  domains: [extractionDomain],
  stagedEval,
  parentSelectionScore: "training",
};

// ---------------------------------------------------------------------------
// Run configuration
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "output");
const AGENT_DIR = join(PROJECT_DIR, "agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-sonnet-4-20250514",
  temperature: 0,
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
    maxTokensPerIteration: 1_000_000,
    maxTotalTokens: 5_000_000,
    maxCostUSD: 10,
    pauseOnBudgetExhausted: true,
    warnAtPercentage: 80,
  },
  sandbox: {
    limits: {
      maxWallTimeSeconds: 120,
      maxMemoryMB: 512,
      maxLLMCalls: 15,
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
  console.log("=== Evolve: Data Extraction Real-World Scenario ===\n");

  // Clean previous output
  await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});

  // Set up the initial agent
  await mkdir(AGENT_DIR, { recursive: true });
  await Bun.write(
    join(AGENT_DIR, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
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
  return \`Modify any part of the codebase at '\${input.repoPath}'.\`;
}`,
  );

  // Cost estimate
  const estimate = BudgetTracker.estimateRunCost(
    config.iterations,
    config.k,
    config.llm.modification.model,
    config.eval.domains.length,
  );

  console.log("Configuration:");
  console.log(`  Iterations:       ${config.iterations}`);
  console.log(`  Parents/iter (k): ${config.k}`);
  console.log(`  Total attempts:   ${config.iterations * config.k}`);
  console.log(`  Train cases:      ${TRAIN_CASES.length}`);
  console.log(`  Test cases:       ${TEST_CASES.length}`);
  console.log(`  Model:            ${config.llm.modification.model}`);
  console.log(`  Est. cost:        ~$${estimate.estimatedCostUSD.toFixed(2)}`);
  console.log(`  Budget cap:       $${config.budget.maxCostUSD}`);
  console.log("");

  const provider = new AnthropicProvider();
  const startTime = Date.now();

  // Track events for display
  let currentIteration = 0;
  const iterationScores: Array<{ iteration: number; scores: string[] }> = [];

  const emit = (event: EvolveEvent) => {
    switch (event.type) {
      case "eval_complete": {
        const scoreStr = event.scores
          .map((s) => `${s.domain}=${s.trainScore.toFixed(3)}`)
          .join(", ");
        if (currentIteration === 0) {
          console.log(`  [initial] ${event.agentId}: ${scoreStr}`);
        } else {
          console.log(`  [eval]    ${event.agentId}: ${scoreStr}`);
        }
        break;
      }
      case "iteration_start":
        currentIteration = event.iteration;
        console.log(
          `\n--- Iteration ${event.iteration}/${config.iterations} ---`,
        );
        console.log(`  Parents: ${event.parentIds.join(", ")}`);
        break;
      case "iteration_end":
        console.log(
          `  Created ${event.newAgentIds.length} new agent(s)`,
        );
        break;
      case "budget_warning":
        console.log(
          `  ⚠ Budget: ${event.percentUsed.toFixed(0)}% ($${event.estimatedCostUSD.toFixed(2)})`,
        );
        break;
      case "agent_created":
        break;
      case "eval_staged_skip":
        console.log(`  [skip] ${event.agentId}: ${event.reason}`);
        break;
      case "run_complete":
        break;
    }
  };

  console.log("Starting evolution...\n");
  console.log("--- Initial Agent Evaluation ---");

  const result = await runEvolutionLoop(provider, config, emit);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Show final results
  console.log("\n\n========================================");
  console.log("           EVOLUTION COMPLETE");
  console.log("========================================\n");

  const archive = new Archive(OUTPUT_DIR);
  try {
    const entries = archive.entries();
    const progression = scoreProgression(entries);

    console.log("Score Progression:");
    console.log("  Gen  | Best Score | Avg Score  | Agents");
    console.log("  -----|-----------|------------|-------");
    for (const p of progression) {
      console.log(
        `  ${String(p.generation).padStart(4)} | ${p.bestScore.toFixed(4).padStart(9)} | ${p.avgScore.toFixed(4).padStart(10)} | ${p.agentCount}`,
      );
    }

    console.log("\nTop 5 Agents:");
    const top = archive.topK(5);
    for (let i = 0; i < top.length; i++) {
      const e = top[i]!;
      const score = getAverageScore(e);
      const parent = e.parentId ?? "none";
      console.log(
        `  ${i + 1}. ${e.id} (gen ${e.generation}) — score: ${score.toFixed(4)}, parent: ${parent}`,
      );
    }

    // Show improvement
    const initial = entries.find((e) => e.generation === 0);
    const best = top[0];
    if (initial && best) {
      const initialScore = getAverageScore(initial);
      const bestScore = getAverageScore(best);
      const improvement = bestScore - initialScore;
      console.log(
        `\nImprovement: ${initialScore.toFixed(4)} → ${bestScore.toFixed(4)} (+${improvement.toFixed(4)})`,
      );
      if (improvement > 0) {
        console.log(`  ${((improvement / initialScore) * 100).toFixed(1)}% relative improvement`);
      }
    }

    // Show what the best agent's diff looks like
    if (best && best.metadata.diffFromParent) {
      console.log("\nBest Agent Changes (diff summary):");
      const diffLines = best.metadata.diffFromParent.split("\n").slice(0, 20);
      for (const line of diffLines) {
        console.log(`  ${line}`);
      }
      if (best.metadata.diffFromParent.split("\n").length > 20) {
        console.log("  ...(truncated)");
      }
    }

    // Show the best agent's task.ts if it changed
    const bestTaskPath = join(best!.repoSnapshot, "task.ts");
    if (await Bun.file(bestTaskPath).exists()) {
      const taskCode = await Bun.file(bestTaskPath).text();
      const initialTaskPath = join(AGENT_DIR, "task.ts");
      const initialCode = await Bun.file(initialTaskPath).text();
      if (taskCode !== initialCode) {
        console.log("\nBest Agent's task.ts (evolved):");
        console.log("─".repeat(60));
        console.log(taskCode.slice(0, 2000));
        if (taskCode.length > 2000) console.log("...(truncated)");
        console.log("─".repeat(60));
      }
    }

    console.log(`\nStats:`);
    console.log(`  Total agents:   ${entries.length}`);
    console.log(`  Elapsed:        ${elapsed}s`);
    console.log(`  Best agent:     ${result.bestAgentId}`);
    console.log(`  Best score:     ${result.bestScore.toFixed(4)}`);
    console.log(`  Output dir:     ${OUTPUT_DIR}`);
  } finally {
    archive.close();
  }
}

main().catch(console.error);
