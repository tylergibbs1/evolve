#!/usr/bin/env bun
/**
 * Evolution experiment: Ambiguous Entity Resolution
 * Given business emails mentioning 3-5 people, extract the PRIMARY DECISION-MAKER
 * (not the sender, not the highest title, not the most mentioned).
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
// Evaluation data: business emails with ambiguous decision authority
// ---------------------------------------------------------------------------

interface EntityResolution {
  decision_maker_name: string;
  action_item: string;
}

const TRAIN_CASES = [
  {
    id: "t1",
    input: `From: Sarah Chen <schen@acmecorp.com>
To: vendor-team@acmecorp.com
Subject: Re: Q3 Vendor Platform Evaluation

Hi team,

Following up on last week's demo — David Park did a great job presenting the analytics module, and I think we're all impressed with the capabilities.

I've looped in Maria Santos from procurement since she's the one who signs off on all vendor contracts and has final budget authority for tools in this category. Maria, can you review the pricing proposal David sent over and let us know if we can move forward?

David, please send Maria the SOW and licensing terms directly.

Thanks,
Sarah Chen
VP Sales`,
    expected: {
      decision_maker_name: "Maria Santos",
      action_item: "Review pricing proposal and sign off on vendor contract",
    },
  },
  {
    id: "t2",
    input: `From: Tom Bell <tbell@infraworks.io>
To: platform-leads@infraworks.io
Subject: Kubernetes Migration — Go/No-Go Decision

Team,

Quick update on the K8s migration timeline. I've put together the effort estimates CTO James Wright asked for — looks like 6-8 weeks for full cutover.

James has delegated the go/no-go decision to Anika Rao (Platform Lead) since she owns the runtime infrastructure and understands the blast radius best. Lisa Huang from the board expects an answer by Friday.

Anika — you have full authority here. Let us know whether we proceed with the migration or hold for Q2.

— Tom Bell, Staff Engineer`,
    expected: {
      decision_maker_name: "Anika Rao",
      action_item: "Make go/no-go decision on Kubernetes migration",
    },
  },
  {
    id: "t3",
    input: `From: Derek Owens <dowens@stellargroup.com>
To: exec-team@stellargroup.com
Subject: Office Relocation — Site Selection Update

Hi everyone,

As you know, CEO Pat Morgan kicked off the office relocation project last month. I've been coordinating logistics — touring sites, getting lease quotes, working with the movers.

Pat has asked Nina Volkov (Director of Operations) to make the final site selection since she best understands our operational footprint and team distribution needs. Pat trusts Nina's judgment here completely.

Nina, we have three finalists. Can you visit them this week and make the call?

Thanks,
Derek Owens
Facilities Manager`,
    expected: {
      decision_maker_name: "Nina Volkov",
      action_item: "Visit finalist sites and make final site selection for office relocation",
    },
  },
  {
    id: "t4",
    input: `From: Yuki Tanaka <ytanaka@healthplus.org>
To: benefits-committee@healthplus.org
Subject: 2025 Benefits Package — Final Recommendation Needed

Committee members,

I've compiled all the survey results and vendor comparisons as committee chair. VP Carlos Ruiz narrowed our options down to three plans based on budget constraints.

After much discussion, the committee has agreed to defer to Priya Mehta's recommendation. As our Benefits Analyst, Priya has the deepest expertise in plan structures, actuarial impact, and employee utilization patterns. Whatever Priya recommends, we'll go with.

Priya — please send your final recommendation by Thursday so we can announce next week.

Best,
Yuki Tanaka
Benefits Committee Chair`,
    expected: {
      decision_maker_name: "Priya Mehta",
      action_item: "Send final recommendation on 2025 benefits package",
    },
  },
  {
    id: "t5",
    input: `From: Margaret Byrne <mbyrne@securetech.com>
To: incident-response@securetech.com
Subject: URGENT: Security Incident — Incident Commander Assigned

All,

Security lead Hassan Ali detected unauthorized access to our staging environment at 02:14 UTC. I've escalated per our incident response protocol.

I am designating Koji Watanabe as Incident Commander for this event. Koji has full authority over all remediation decisions and approvals — patching, access revocation, forensics prioritization, vendor engagement. All remediation requests go through Koji until the incident is closed.

Hassan, please brief Koji on your findings immediately.

Margaret Byrne, CISO`,
    expected: {
      decision_maker_name: "Koji Watanabe",
      action_item: "Lead incident response with full remediation approval authority",
    },
  },
  {
    id: "t6",
    input: `From: Sam Torres <storres@launchpad.dev>
To: release-team@launchpad.dev
Subject: v4.2 Release Readiness — QA Certification Required

Hey team,

PM Rachel Kim owns the roadmap and set the release date for next Tuesday. I wanted to flag that we're behind on integration testing — two critical test suites are still red.

Bottom line: the release happens only when QA Director Beth Nguyen certifies that we've met the quality bar. Beth has final say on whether v4.2 ships or gets pushed. No certification, no release — that's the process Rachel agreed to.

Beth — what do you need from us to get to green?

— Sam Torres, Engineering Lead`,
    expected: {
      decision_maker_name: "Beth Nguyen",
      action_item: "Certify v4.2 release meets quality bar before shipping",
    },
  },
];

const TEST_CASES = [
  {
    id: "test1",
    input: `From: Diane Cho <dcho@millerfirm.com>
To: zoning-review@cityplanning.gov
Subject: Re: Parcel 2041-B Zoning Variance Application

Good afternoon,

I'm handling the legal filing for the zoning variance on Parcel 2041-B. Regional Director Alex Foster has been coordinating between our office and the planning department.

Please note that the determination on this zoning application rests with council member Rita Patel, who chairs the land use subcommittee. The subcommittee meets next Thursday to review our application, and Rita will make the ruling.

Alex, please ensure all supplementary materials reach Rita's office by Wednesday.

Best regards,
Diane Cho, Esq.
Miller & Associates`,
    expected: {
      decision_maker_name: "Rita Patel",
      action_item: "Make determination on zoning variance application at subcommittee meeting",
    },
  },
  {
    id: "test2",
    input: `From: Dr. Victor Reyes <vreyes@compscience-conf.org>
To: program-committee@compscience-conf.org
Subject: ICCS 2026 Speaker Selection — Committee Consensus

Dear colleagues,

The conference committee, chaired by Dr. Amara Osei, has completed its review of all 847 speaker submissions for ICCS 2026.

As general chair I technically hold veto power over the final program, but I want to be transparent: I have never exercised that veto in six years, and I don't intend to start now. The committee reached unanimous consensus under Amara's leadership, and their selections reflect excellent judgment.

Dr. Osei — please finalize the speaker notifications and send them out by month's end.

Warm regards,
Dr. Victor Reyes
General Chair, ICCS 2026`,
    expected: {
      decision_maker_name: "Dr. Amara Osei",
      action_item: "Finalize and send speaker notifications for ICCS 2026",
    },
  },
];

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function nameMatch(actual: string | undefined, expected: string): number {
  if (!actual) return 0;
  const a = normalizeName(actual);
  const e = normalizeName(expected);
  if (a === e) return 1;
  // Allow partial matches (e.g., "Amara Osei" matches "Dr. Amara Osei")
  if (a.includes(e) || e.includes(a)) return 0.8;
  return 0;
}

function actionItemScore(actual: string | undefined, expected: string): number {
  if (!actual) return 0;
  const a = actual.toLowerCase();
  // Extract key terms from expected (words 4+ chars, skip stop words)
  const stopWords = new Set(["the", "and", "for", "with", "from", "that", "this", "will", "have", "been", "before"]);
  const keyTerms = expected
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4 && !stopWords.has(w));
  if (keyTerms.length === 0) return 0;
  const matched = keyTerms.filter((term) => a.includes(term)).length;
  return matched / keyTerms.length;
}

async function scorer(
  output: unknown,
  evalCase: { expected: unknown },
): Promise<number> {
  const expected = evalCase.expected as EntityResolution;
  let extracted: EntityResolution;

  try {
    if (typeof output === "string") {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      } else {
        extracted = { decision_maker_name: "", action_item: "" };
      }
    } else if (typeof output === "object" && output !== null) {
      extracted = output as EntityResolution;
    } else {
      return 0;
    }
  } catch {
    return 0;
  }

  const name = nameMatch(extracted.decision_maker_name, expected.decision_maker_name) * 0.7;
  const action = actionItemScore(extracted.action_item, expected.action_item) * 0.3;

  return name + action;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-entity-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-entity-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-opus-4-6",
  temperature: 0,
};

const entityDomain: DomainConfig = {
  name: "entity-resolution",
  trainCases: TRAIN_CASES,
  testCases: TEST_CASES,
  scorer,
  outputSchema: {
    type: "object",
    properties: {
      decision_maker_name: { type: "string" },
      action_item: { type: "string" },
    },
    required: ["decision_maker_name", "action_item"],
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
  domains: [entityDomain],
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
  console.log("=== Evolve Experiment: Ambiguous Entity Resolution ===\n");
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
  return \`You are an agent. Extract the main contact from this message.

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
The agent must identify the PRIMARY DECISION-MAKER from business emails that mention 3-5 people.
It must return a JSON object with exactly these fields: { decision_maker_name, action_item }

CRITICAL INSIGHT: Naive heuristics all fail on this task:
- The sender is almost never the decision-maker
- The person with the highest title is often NOT the decision-maker
- The most-mentioned person is often NOT the decision-maker

The decision-maker is the person with ACTUAL AUTHORITY over the specific decision at hand.
Look for delegation language ("delegated to", "designated", "defers to", "has final say",
"signs off on", "won't proceed without"), authority signals ("full authority", "final decision",
"makes the call"), and conditional gates ("release happens only when X certifies").

## Scoring
- 70% weight: exact match on decision_maker_name (case-insensitive)
- 30% weight: action_item contains key terms from the expected action

## What to Modify
Edit task.ts at '\${input.repoPath}' to improve the buildTaskPrompt function.
The function receives the raw email text as JSON and must return a prompt string.

CRITICAL: The LLM response MUST be a flat JSON object with keys: decision_maker_name, action_item.
Do NOT change the output format. The scorer expects these exact keys.

Focus on:
- Instructions to ignore sender, title, and mention-frequency heuristics
- Recognizing delegation and authority-transfer language patterns
- Identifying conditional gates (X happens only when Y approves)
- Extracting the specific action the decision-maker controls\`;
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
