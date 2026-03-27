#!/usr/bin/env bun
/**
 * Evolution experiment: Constraint Satisfaction Scheduling
 * Given small scheduling puzzles, produce valid assignments.
 * 3 iterations, k=2, budget $8, model claude-opus-4-6.
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

interface Assignment {
  person: string;
  slot: string;
}

interface SchedulingCase {
  id: string;
  input: string;
  expected: Record<string, string>;
  constraints: Array<(mapping: Record<string, string>) => boolean>;
  constraintCount: number;
}

// ---------------------------------------------------------------------------
// Train cases
// ---------------------------------------------------------------------------

const TRAIN_CASES: SchedulingCase[] = [
  {
    id: "train1",
    input: `People: Alice, Bob, Carol, Dan.
Slots: 9am, 10am, 11am, 1pm.
Constraints:
1. Alice must be scheduled before Bob.
2. Carol cannot be at 9am.
3. Dan must be immediately after Alice.
4. Bob cannot be at 1pm.
Assign each person to exactly one unique slot.`,
    expected: { Alice: "9am", Dan: "10am", Bob: "11am", Carol: "1pm" },
    constraintCount: 4,
    constraints: [
      (m) => {
        const order = ["9am", "10am", "11am", "1pm"];
        return order.indexOf(m.Alice) < order.indexOf(m.Bob);
      },
      (m) => m.Carol !== "9am",
      (m) => {
        const order = ["9am", "10am", "11am", "1pm"];
        return order.indexOf(m.Dan) === order.indexOf(m.Alice) + 1;
      },
      (m) => m.Bob !== "1pm",
    ],
  },
  {
    id: "train2",
    input: `People: Eve, Frank, Grace, Henry.
Slots: Room-A-morning, Room-A-afternoon, Room-B-morning, Room-B-afternoon.
Constraints:
1. Eve and Frank must not be in the same room (Room-A vs Room-B).
2. Grace must be in Room-A (Room-A-morning or Room-A-afternoon).
3. Henry must be in the afternoon (Room-A-afternoon or Room-B-afternoon).
4. Eve must be in the morning (Room-A-morning or Room-B-morning).
5. Frank and Henry must be in the same room.
Assign each person to exactly one unique slot.`,
    expected: { Eve: "Room-A-morning", Grace: "Room-A-afternoon", Frank: "Room-B-morning", Henry: "Room-B-afternoon" },
    constraintCount: 5,
    constraints: [
      (m) => {
        const eveRoom = m.Eve.startsWith("Room-A") ? "A" : "B";
        const frankRoom = m.Frank.startsWith("Room-A") ? "A" : "B";
        return eveRoom !== frankRoom;
      },
      (m) => m.Grace.startsWith("Room-A"),
      (m) => m.Henry.endsWith("afternoon"),
      (m) => m.Eve.endsWith("morning"),
      (m) => {
        const frankRoom = m.Frank.startsWith("Room-A") ? "A" : "B";
        const henryRoom = m.Henry.startsWith("Room-A") ? "A" : "B";
        return frankRoom === henryRoom;
      },
    ],
  },
  {
    id: "train3",
    input: `People: P, Q, R, S, T.
Slots: 1pm, 2pm, 3pm, 4pm, 5pm.
Constraints:
1. P must be scheduled before both Q and R.
2. S must be immediately before T.
3. Q must be at 3pm or later.
4. R must not be at 5pm.
5. P must not be at 2pm.
Assign each person to exactly one unique slot.`,
    expected: { P: "1pm", S: "2pm", T: "3pm", R: "4pm", Q: "5pm" },
    constraintCount: 5,
    constraints: [
      (m) => {
        const order = ["1pm", "2pm", "3pm", "4pm", "5pm"];
        return order.indexOf(m.P) < order.indexOf(m.Q) && order.indexOf(m.P) < order.indexOf(m.R);
      },
      (m) => {
        const order = ["1pm", "2pm", "3pm", "4pm", "5pm"];
        return order.indexOf(m.T) === order.indexOf(m.S) + 1;
      },
      (m) => {
        const order = ["1pm", "2pm", "3pm", "4pm", "5pm"];
        return order.indexOf(m.Q) >= 2;
      },
      (m) => m.R !== "5pm",
      (m) => m.P !== "2pm",
    ],
  },
  {
    id: "train4",
    input: `People: Amy, Ben, Cass, Drew.
Labs: Chem, Bio, Physics, CS.
Constraints:
1. Amy must not be assigned to Physics.
2. Ben must be assigned to Bio or CS.
3. Cass must be assigned to Chem or Physics.
4. Drew must be assigned to Physics or CS.
5. Amy and Drew must not be in the same category (sciences = Chem, Bio, Physics; non-science = CS).
6. Drew must not be assigned to CS.
Assign each person to exactly one unique lab.`,
    expected: { Amy: "CS", Ben: "Bio", Cass: "Chem", Drew: "Physics" },
    constraintCount: 6,
    constraints: [
      (m) => m.Amy !== "Physics",
      (m) => m.Ben === "Bio" || m.Ben === "CS",
      (m) => m.Cass === "Chem" || m.Cass === "Physics",
      (m) => m.Drew === "Physics" || m.Drew === "CS",
      (m) => {
        const sciences = ["Chem", "Bio", "Physics"];
        const amyScience = sciences.includes(m.Amy);
        const drewScience = sciences.includes(m.Drew);
        return amyScience !== drewScience;
      },
      (m) => m.Drew !== "CS",
    ],
  },
  {
    id: "train5",
    input: `People: J, K, L, M.
Shifts: Mon-morning, Mon-afternoon, Tue-morning, Tue-afternoon.
Constraints:
1. J must work a morning shift.
2. K and L must work on different days.
3. M must work on Tuesday.
4. J and M must work on different days.
5. L must work an afternoon shift.
6. K must work a morning shift.
Assign each person to exactly one unique shift.`,
    expected: { J: "Mon-morning", L: "Mon-afternoon", K: "Tue-morning", M: "Tue-afternoon" },
    constraintCount: 6,
    constraints: [
      (m) => m.J.endsWith("morning"),
      (m) => {
        const kDay = m.K.startsWith("Mon") ? "Mon" : "Tue";
        const lDay = m.L.startsWith("Mon") ? "Mon" : "Tue";
        return kDay !== lDay;
      },
      (m) => m.M.startsWith("Tue"),
      (m) => {
        const jDay = m.J.startsWith("Mon") ? "Mon" : "Tue";
        const mDay = m.M.startsWith("Mon") ? "Mon" : "Tue";
        return jDay !== mDay;
      },
      (m) => m.L.endsWith("afternoon"),
      (m) => m.K.endsWith("morning"),
    ],
  },
  {
    id: "train6",
    input: `People: W, X, Y, Z.
Tasks: Research, Writing, Review, Presentation.
Constraints:
1. W must not do Research.
2. X must do Research or Writing.
3. Y must do Review.
4. Z must not do Presentation.
5. If X does Research, then W must do Presentation.
6. Z must not do Research.
Assign each person to exactly one unique task.`,
    expected: { W: "Presentation", X: "Research", Y: "Review", Z: "Writing" },
    constraintCount: 6,
    constraints: [
      (m) => m.W !== "Research",
      (m) => m.X === "Research" || m.X === "Writing",
      (m) => m.Y === "Review",
      (m) => m.Z !== "Presentation",
      (m) => m.X !== "Research" || m.W === "Presentation",
      (m) => m.Z !== "Research",
    ],
  },
];

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const TEST_CASES: SchedulingCase[] = [
  {
    id: "test1",
    input: `People: P, Q, R, S.
Spots: A1, A2, B1, B2.
Constraints:
1. P must be in row A (A1 or A2).
2. Q and R must be in different rows (row A vs row B).
3. S must be in a '2' spot (A2 or B2).
4. P and S must be in different rows.
5. Q must be in a '1' spot (A1 or B1).
6. R must be in row B (B1 or B2).
Assign each person to exactly one unique spot.`,
    expected: { Q: "A1", P: "A2", R: "B1", S: "B2" },
    constraintCount: 6,
    constraints: [
      (m) => m.P === "A1" || m.P === "A2",
      (m) => {
        const qRow = m.Q.startsWith("A") ? "A" : "B";
        const rRow = m.R.startsWith("A") ? "A" : "B";
        return qRow !== rRow;
      },
      (m) => m.S === "A2" || m.S === "B2",
      (m) => {
        const pRow = m.P.startsWith("A") ? "A" : "B";
        const sRow = m.S.startsWith("A") ? "A" : "B";
        return pRow !== sRow;
      },
      (m) => m.Q === "A1" || m.Q === "B1",
      (m) => m.R === "B1" || m.R === "B2",
    ],
  },
  {
    id: "test2",
    input: `People: M, N, O, P, Q.
Slots: 1st, 2nd, 3rd, 4th, 5th.
Constraints:
1. M must be before N.
2. O must be 3rd.
3. P must be immediately before Q.
4. N must not be 5th.
5. M must not be 4th.
6. P must be after M.
Assign each person to exactly one unique slot.`,
    expected: { M: "1st", N: "2nd", O: "3rd", P: "4th", Q: "5th" },
    constraintCount: 6,
    constraints: [
      (m) => {
        const order = ["1st", "2nd", "3rd", "4th", "5th"];
        return order.indexOf(m.M) < order.indexOf(m.N);
      },
      (m) => m.O === "3rd",
      (m) => {
        const order = ["1st", "2nd", "3rd", "4th", "5th"];
        return order.indexOf(m.Q) === order.indexOf(m.P) + 1;
      },
      (m) => m.N !== "5th",
      (m) => m.M !== "4th",
      (m) => {
        const order = ["1st", "2nd", "3rd", "4th", "5th"];
        return order.indexOf(m.P) > order.indexOf(m.M);
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

function buildMapping(assignments: Assignment[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const a of assignments) {
    mapping[a.person] = a.slot;
  }
  return mapping;
}

async function scorer(
  output: unknown,
  evalCase: { expected: unknown; constraints: unknown; constraintCount: unknown },
): Promise<number> {
  const constraints = evalCase.constraints as Array<(m: Record<string, string>) => boolean>;
  const constraintCount = evalCase.constraintCount as number;

  let assignments: Assignment[];

  try {
    if (typeof output === "string") {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        assignments = parsed.assignments ?? [];
      } else {
        return 0;
      }
    } else if (typeof output === "object" && output !== null) {
      const obj = output as { assignments?: Assignment[] };
      assignments = obj.assignments ?? [];
    } else {
      return 0;
    }
  } catch {
    return 0;
  }

  if (!Array.isArray(assignments) || assignments.length === 0) return 0;

  const mapping = buildMapping(assignments);

  // Check all people are assigned (basic validity)
  const expectedMapping = evalCase.expected as Record<string, string>;
  const expectedPeople = Object.keys(expectedMapping);
  for (const person of expectedPeople) {
    if (!(person in mapping)) return 0;
  }

  // Check for duplicate slot assignments
  const usedSlots = new Set(Object.values(mapping));
  if (usedSlots.size !== Object.keys(mapping).length) return 0;

  // Score = fraction of constraints satisfied
  let satisfied = 0;
  for (const check of constraints) {
    try {
      if (check(mapping)) satisfied++;
    } catch {
      // Constraint check failed (missing key, etc.) — counts as not satisfied
    }
  }

  return satisfied / constraintCount;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-constraints-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-constraints-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-opus-4-6",
  temperature: 0,
};

const constraintDomain: DomainConfig = {
  name: "constraint-satisfaction",
  trainCases: TRAIN_CASES,
  testCases: TEST_CASES,
  scorer,
  outputSchema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            person: { type: "string" },
            slot: { type: "string" },
          },
          required: ["person", "slot"],
          additionalProperties: false,
        },
      },
    },
    required: ["assignments"],
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
  domains: [constraintDomain],
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
  console.log("=== Evolve Experiment: Constraint Satisfaction Scheduling ===\n");
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
  return \`You are an agent. Solve this puzzle.

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
  return \`You are a meta-agent that improves task-solving agents for constraint satisfaction problems.

## Current Performance
\${scores}
Best archive score: \${input.archiveSummary.bestScore.toFixed(3)}
Remaining iterations: \${input.remainingIterations}

## Task Description
The agent solves scheduling/assignment puzzles. Each puzzle has:
- A set of people
- A set of slots/rooms/labs/shifts
- A set of constraints (ordering, exclusion, co-location, etc.)

The agent must return a JSON object with an "assignments" array where each element
has { person: string, slot: string }.

## Domain Knowledge
This is constraint satisfaction. Systematic constraint propagation and elimination
works far better than guessing. The agent should:
1. List all constraints explicitly
2. Apply unary constraints first (e.g., "X must be in slot Y") to narrow domains
3. Then apply binary/relational constraints to eliminate further
4. Verify each constraint against the final assignment before returning
5. If stuck, backtrack systematically rather than guessing

## Scoring
Score = fraction of constraints satisfied per puzzle, averaged across all puzzles.
A perfect score requires ALL constraints satisfied for ALL puzzles.

## What to Modify
Edit task.ts at '\${input.repoPath}' to improve the buildTaskPrompt function.
The function receives the puzzle description as JSON and must return a prompt string.

CRITICAL: The LLM response MUST be a JSON object with key "assignments" containing
an array of { person, slot } objects. Do NOT change the output format.

Focus on:
- Teaching systematic constraint elimination (not trial-and-error)
- Explicit step-by-step reasoning before answering
- Constraint verification as a final check
- Handling different constraint types: ordering, exclusion, adjacency, conditionals\`;
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
