#!/usr/bin/env bun
/**
 * Realistic experiment: customer support triage + draft response generation.
 *
 * This is closer to a practical workflow than the toy experiments:
 * - classify the ticket into an operational queue
 * - assign a priority
 * - decide whether human escalation is needed
 * - decide whether a refund is supported by policy
 * - draft a customer-facing response
 *
 * Scoring mixes objective fields with an LLM judge for the response text.
 */

import { join, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  AnthropicProvider,
  Archive,
  runEvolutionLoop,
  getAverageScore,
  type DomainConfig,
  type EvalCase,
  type EvalConfig,
  type EvolveEvent,
  type RunConfig,
  type StagedEvalConfig,
} from "@evolve/core";

type Queue =
  | "billing"
  | "technical"
  | "shipping"
  | "account_access"
  | "cancellation";

type Priority = "low" | "medium" | "high" | "urgent";

interface TicketExpectation {
  queue: Queue;
  priority: Priority;
  needs_human: boolean;
  refund_supported: boolean;
  response_requirements: string[];
  response_must_avoid?: string[];
}

interface TicketOutput {
  queue: Queue;
  priority: Priority;
  needs_human: boolean;
  refund_supported: boolean;
  draft_response: string;
}

const TRAIN_CASES: EvalCase[] = [
  {
    id: "train-1",
    input: {
      customer_message:
        "I've been double charged for my Pro subscription and my bank shows two pending charges. Fix this today.",
      context:
        "Duplicate billing incident confirmed. Refund takes 3-5 business days. Human approval is not required.",
    },
    expected: {
      queue: "billing",
      priority: "high",
      needs_human: false,
      refund_supported: true,
      response_requirements: [
        "acknowledge duplicate charge",
        "confirm refund or reversal is being processed",
        "provide timeline of 3-5 business days",
      ],
      response_must_avoid: ["blaming the bank", "asking customer to wait without action"],
    } satisfies TicketExpectation,
  },
  {
    id: "train-2",
    input: {
      customer_message:
        "I reset my password three times and still can't get into the admin console. We have a launch in two hours.",
      context:
        "SSO sync is failing for some enterprise tenants. Requires human support to manually resync access.",
    },
    expected: {
      queue: "account_access",
      priority: "urgent",
      needs_human: true,
      refund_supported: false,
      response_requirements: [
        "acknowledge urgency",
        "state that support is escalating immediately",
        "mention manual access resync",
      ],
      response_must_avoid: ["generic password reset instructions only"],
    } satisfies TicketExpectation,
  },
  {
    id: "train-3",
    input: {
      customer_message:
        "My order has shown 'label created' for nine days. If this isn't shipped by tomorrow I want my money back.",
      context:
        "Carrier pickup delay confirmed. Replacement shipment can be sent immediately; refund is allowed if customer prefers.",
    },
    expected: {
      queue: "shipping",
      priority: "high",
      needs_human: false,
      refund_supported: true,
      response_requirements: [
        "acknowledge shipment delay",
        "offer replacement or refund path",
        "explain that delay is on shipment pickup",
      ],
      response_must_avoid: ["pretending package is already in transit"],
    } satisfies TicketExpectation,
  },
  {
    id: "train-4",
    input: {
      customer_message:
        "Your app crashes every time I export a report to CSV after the latest update.",
      context:
        "Known bug in version 4.2.1. Workaround: export to XLSX first or downgrade to 4.2.0. Engineering fix in progress.",
    },
    expected: {
      queue: "technical",
      priority: "high",
      needs_human: false,
      refund_supported: false,
      response_requirements: [
        "acknowledge bug",
        "provide workaround",
        "mention engineering is working on a fix",
      ],
      response_must_avoid: ["claiming the issue cannot be reproduced"],
    } satisfies TicketExpectation,
  },
  {
    id: "train-5",
    input: {
      customer_message:
        "Can I cancel my annual plan now? I signed up last month and this isn't working for our team.",
      context:
        "Annual plans are refundable only within 14 days. Customer is on day 31. Downgrade to monthly at renewal is available.",
    },
    expected: {
      queue: "cancellation",
      priority: "medium",
      needs_human: false,
      refund_supported: false,
      response_requirements: [
        "state policy clearly",
        "decline refund politely",
        "offer downgrade or cancellation at renewal",
      ],
      response_must_avoid: ["saying refund is available now"],
    } satisfies TicketExpectation,
  },
  {
    id: "train-6",
    input: {
      customer_message:
        "Our finance team needs a VAT invoice for last quarter and your portal only shows receipts.",
      context:
        "VAT invoices are available on request from billing operations. Human billing specialist must issue them.",
    },
    expected: {
      queue: "billing",
      priority: "medium",
      needs_human: true,
      refund_supported: false,
      response_requirements: [
        "confirm request can be handled",
        "state that billing operations will provide the VAT invoice",
        "set expectation for follow-up",
      ],
      response_must_avoid: ["telling customer to use the receipt as an invoice"],
    } satisfies TicketExpectation,
  },
  {
    id: "train-7",
    input: {
      customer_message:
        "I deleted the wrong workspace and lost client files. Please tell me there is a way to restore it.",
      context:
        "Soft-deleted workspaces can be restored within 30 days from trash. Self-serve restore is available.",
    },
    expected: {
      queue: "technical",
      priority: "high",
      needs_human: false,
      refund_supported: false,
      response_requirements: [
        "reassure customer",
        "give restore path from trash",
        "mention 30-day recovery window",
      ],
    } satisfies TicketExpectation,
  },
  {
    id: "train-8",
    input: {
      customer_message:
        "I changed my email and now 2FA codes are going to my old address. I’m locked out.",
      context:
        "2FA email destination can be updated only after identity verification by human support.",
    },
    expected: {
      queue: "account_access",
      priority: "urgent",
      needs_human: true,
      refund_supported: false,
      response_requirements: [
        "acknowledge lockout",
        "say support will verify identity and update destination",
        "avoid promising immediate self-serve fix",
      ],
    } satisfies TicketExpectation,
  },
];

const VALIDATION_CASES: EvalCase[] = [
  {
    id: "val-1",
    input: {
      customer_message:
        "The courier says delivered but nothing was left at my building. This was a birthday gift.",
      context:
        "Carrier marked delivered. Replacement or refund is allowed after address verification. No human approval needed.",
    },
    expected: {
      queue: "shipping",
      priority: "high",
      needs_human: false,
      refund_supported: true,
      response_requirements: [
        "acknowledge missing delivery",
        "request address verification",
        "offer replacement or refund after verification",
      ],
    } satisfies TicketExpectation,
  },
  {
    id: "val-2",
    input: {
      customer_message:
        "The dashboard is loading blank for everyone on our team and we can't file payroll.",
      context:
        "Major outage impacting reporting dashboard. Status page incident is open. Human incident team already engaged.",
    },
    expected: {
      queue: "technical",
      priority: "urgent",
      needs_human: true,
      refund_supported: false,
      response_requirements: [
        "acknowledge outage",
        "state incident is active",
        "avoid giving fake workaround",
      ],
    } satisfies TicketExpectation,
  },
  {
    id: "val-3",
    input: {
      customer_message:
        "Can I switch from annual to monthly before renewal? We want fewer seats too.",
      context:
        "Plan changes can be scheduled for renewal from the billing settings page. No refund due.",
    },
    expected: {
      queue: "cancellation",
      priority: "low",
      needs_human: false,
      refund_supported: false,
      response_requirements: [
        "explain renewal-based change",
        "mention billing settings",
        "answer both cadence and seat questions",
      ],
    } satisfies TicketExpectation,
  },
];

const TEST_CASES: EvalCase[] = [
  {
    id: "test-1",
    input: {
      customer_message:
        "Your checkout charged us, then failed, and now the order is gone. My CEO is furious.",
      context:
        "Authorization captured without order completion. Billing can refund immediately. Order must be recreated by customer.",
    },
    expected: {
      queue: "billing",
      priority: "urgent",
      needs_human: false,
      refund_supported: true,
      response_requirements: [
        "acknowledge failed checkout and charge",
        "state refund is being processed",
        "explain order must be recreated",
      ],
    } satisfies TicketExpectation,
  },
  {
    id: "test-2",
    input: {
      customer_message:
        "I was told my package would arrive Friday and it's Tuesday with no update. I don't trust these promises anymore.",
      context:
        "Shipment is delayed at regional hub. Refund is allowed. Replacement available on request.",
    },
    expected: {
      queue: "shipping",
      priority: "high",
      needs_human: false,
      refund_supported: true,
      response_requirements: [
        "acknowledge broken expectation",
        "offer refund or replacement",
        "avoid overpromising a new delivery date",
      ],
    } satisfies TicketExpectation,
  },
  {
    id: "test-3",
    input: {
      customer_message:
        "Every CSV export replaces accented characters with garbage text. We send these files to auditors.",
      context:
        "Encoding bug affects UTF-8 exports. Workaround: use XLSX export. Fix scheduled next patch.",
    },
    expected: {
      queue: "technical",
      priority: "medium",
      needs_human: false,
      refund_supported: false,
      response_requirements: [
        "identify encoding/export issue",
        "provide XLSX workaround",
        "mention upcoming fix",
      ],
    } satisfies TicketExpectation,
  },
  {
    id: "test-4",
    input: {
      customer_message:
        "We lost access to our MFA device and the backup codes are gone. We need payroll access before market open.",
      context:
        "MFA reset requires human identity verification. Security team handles this queue.",
    },
    expected: {
      queue: "account_access",
      priority: "urgent",
      needs_human: true,
      refund_supported: false,
      response_requirements: [
        "acknowledge urgency and security constraint",
        "state identity verification is required",
        "say security team is being engaged",
      ],
    } satisfies TicketExpectation,
  },
];

let judgeProvider: AnthropicProvider | null = null;

function priorityScore(actual: unknown, expected: Priority): number {
  const levels: Priority[] = ["low", "medium", "high", "urgent"];
  if (!levels.includes(actual as Priority)) return 0;
  const delta = Math.abs(levels.indexOf(actual as Priority) - levels.indexOf(expected));
  if (delta === 0) return 1;
  if (delta === 1) return 0.5;
  return 0;
}

async function responseQualityScore(
  response: string,
  input: Record<string, unknown>,
  expected: TicketExpectation,
): Promise<number> {
  if (!judgeProvider) judgeProvider = new AnthropicProvider();

  const judge = await judgeProvider.chat(
    [
      {
        role: "user",
        content: `You are grading a support agent draft for operational quality.

Customer message:
${input["customer_message"]}

Internal context:
${input["context"]}

Required qualities:
${expected.response_requirements.map((item) => `- ${item}`).join("\n")}

Avoid these mistakes:
${(expected.response_must_avoid ?? ["none"]).map((item) => `- ${item}`).join("\n")}

Draft response:
"""
${response}
"""

Score from 0.0 to 1.0 based on whether the draft is accurate, appropriately empathetic, and action-oriented for the provided context. Return only JSON:
{"score": number, "reason": string}`,
      },
    ],
    {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0,
    },
  );

  try {
    const parsed = JSON.parse(judge.content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const score = Number(parsed.score ?? 0);
    return Math.max(0, Math.min(1, score));
  } catch {
    return 0;
  }
}

async function scorer(output: unknown, evalCase: EvalCase): Promise<number> {
  const expected = evalCase.expected as TicketExpectation;
  const parsed =
    typeof output === "object" && output !== null
      ? (output as Partial<TicketOutput>)
      : null;

  if (!parsed || typeof parsed.draft_response !== "string") return 0;

  const queue = parsed.queue === expected.queue ? 1 : 0;
  const priority = priorityScore(parsed.priority, expected.priority);
  const needsHuman = parsed.needs_human === expected.needs_human ? 1 : 0;
  const refund = parsed.refund_supported === expected.refund_supported ? 1 : 0;
  const response = await responseQualityScore(
    parsed.draft_response,
    evalCase.input as Record<string, unknown>,
    expected,
  );

  return (
    queue * 0.25 +
    priority * 0.15 +
    needsHuman * 0.15 +
    refund * 0.1 +
    response * 0.35
  );
}

const PROJECT_DIR = resolve(import.meta.dir);
const OUTPUT_DIR = join(PROJECT_DIR, "experiment-support-triage-realistic-output");
const AGENT_DIR = join(PROJECT_DIR, "experiment-support-triage-realistic-agent");

const ROLE_CONFIG = {
  provider: "anthropic" as const,
  model: "claude-sonnet-4-20250514",
  temperature: 0,
};

const supportDomain: DomainConfig = {
  name: "support-triage",
  trainCases: TRAIN_CASES,
  validationCases: VALIDATION_CASES,
  testCases: TEST_CASES,
  scorer,
};

const stagedEval: StagedEvalConfig = {
  stages: [
    { taskCount: 4, passThreshold: 0.45, passCondition: "rate" },
    { taskCount: 8, passThreshold: 0, passCondition: "any" },
  ],
  defaultScore: 0,
};

const config: RunConfig = {
  iterations: 4,
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
    maxTokensPerIteration: 600_000,
    maxTotalTokens: 4_000_000,
    maxCostUSD: 10,
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
    domains: [supportDomain],
    stagedEval,
    parentSelectionScore: "validation",
  },
  protectedPaths: [],
  editableSelection: false,
};

async function buildPrompt(repoPath: string, input: unknown): Promise<string> {
  const taskPath = join(repoPath, "task.ts");
  if (!(await Bun.file(taskPath).exists())) {
    return `You are a support operations agent.\n\n${JSON.stringify(input, null, 2)}`;
  }

  const runner = `
import { buildTaskPrompt } from "./task.ts";
const input = JSON.parse(await Bun.stdin.text());
process.stdout.write(buildTaskPrompt(input));
`;
  const runnerPath = join(repoPath, ".realistic-task-runner.ts");
  await Bun.write(runnerPath, runner);

  const proc = Bun.spawn(["bun", "run", runnerPath], {
    cwd: repoPath,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });

  proc.stdin.write(JSON.stringify(input));
  proc.stdin.flush();
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return exitCode === 0 && stdout.trim().length > 0
    ? stdout
    : `You are a support operations agent.\n\n${JSON.stringify(input, null, 2)}`;
}

async function runTicketAgent(
  provider: AnthropicProvider,
  repoPath: string,
  input: unknown,
): Promise<TicketOutput | string> {
  const prompt = await buildPrompt(repoPath, input);
  const response = await provider.chat(
    [
      {
        role: "system",
        content:
          "You are a support operations agent. Return a plain JSON object and nothing else.",
      },
      { role: "user", content: prompt },
    ],
    ROLE_CONFIG,
  );

  try {
    const raw = response.content;
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match?.[0] ?? raw) as TicketOutput;
  } catch {
    return response.content;
  }
}

async function evaluateCases(
  provider: AnthropicProvider,
  repoPath: string,
  cases: EvalCase[],
): Promise<number> {
  let total = 0;
  for (const evalCase of cases) {
    const output = await runTicketAgent(provider, repoPath, evalCase.input);
    total += await scorer(output, evalCase);
  }
  return total / cases.length;
}

async function main() {
  console.log("=== Evolve Experiment: Realistic Support Triage ===\n");
  console.log(`  Iterations: ${config.iterations}, k: ${config.k}`);
  console.log(
    `  Train/Val/Test: ${TRAIN_CASES.length}/${VALIDATION_CASES.length}/${TEST_CASES.length}`,
  );
  console.log("  Workflow: queue + priority + escalation + refund + draft response");
  console.log(`  Model: ${ROLE_CONFIG.model}`);
  console.log(`  Budget: $${config.budget.maxCostUSD}\n`);

  await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(AGENT_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(AGENT_DIR, { recursive: true });

  await Bun.write(
    join(AGENT_DIR, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return \`You are a support agent. Read the ticket and respond in JSON.

Ticket:
\${JSON.stringify(inputs, null, 2)}

Include these keys:
- queue
- priority
- needs_human
- refund_supported
- draft_response\`;
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
  return \`You are improving a support triage agent.

Current scores:
\${scores}
Best archive score: \${input.archiveSummary.bestScore.toFixed(3)}
Remaining iterations: \${input.remainingIterations}

Task:
The agent must output valid JSON with:
- queue
- priority
- needs_human
- refund_supported
- draft_response

The workflow is operational, not just conversational:
- route to the right queue
- set urgency correctly
- decide escalation correctly
- apply refund policy correctly
- draft an accurate customer response grounded in context

Edit task.ts at '\${input.repoPath}'.
Improve the task prompt so the model performs better on structured support triage, not just generic empathy.\`;
}`,
  );

  const provider = new AnthropicProvider();
  const startTime = Date.now();

  const emit = (event: EvolveEvent) => {
    switch (event.type) {
      case "eval_complete":
        console.log(
          `  [eval] ${event.agentId}: ${event.scores.map((s) => `${s.domain}=train:${s.trainScore.toFixed(3)} val:${(s.validationScore ?? 0).toFixed(3)}`).join(", ")}`,
        );
        break;
      case "iteration_start":
        console.log(`\n--- Iteration ${event.iteration}/${config.iterations} ---`);
        console.log(`  Parents: ${event.parentIds.join(", ")}`);
        break;
      case "iteration_end":
        console.log(`  Created ${event.newAgentIds.length} new agent(s)`);
        break;
      case "agent_created":
        console.log(
          `  [new] ${event.agentId} (parent: ${event.parentId}, gen ${event.generation})`,
        );
        break;
      case "budget_warning":
        console.log(
          `  [budget] ${event.percentUsed.toFixed(0)}% ($${event.estimatedCostUSD.toFixed(2)})`,
        );
        break;
      case "run_complete":
        console.log(
          `\n=== COMPLETE ===\n  Best: ${event.bestAgentId} (score: ${event.bestScore.toFixed(4)})`,
        );
        break;
    }
  };

  const result = await runEvolutionLoop(provider, config, emit);

  const archive = new Archive(OUTPUT_DIR);
  try {
    const entries = archive.entries();
    const best = archive.topK(1, "validation")[0];
    const initial = entries.find((entry) => entry.generation === 0);

    if (!best || !initial) {
      console.log("Archive missing expected agents.");
      return;
    }

    const initialVal = await evaluateCases(provider, initial.repoSnapshot, VALIDATION_CASES);
    const bestVal = await evaluateCases(provider, best.repoSnapshot, VALIDATION_CASES);
    const initialTest = await evaluateCases(provider, initial.repoSnapshot, TEST_CASES);
    const bestTest = await evaluateCases(provider, best.repoSnapshot, TEST_CASES);

    console.log("\nHeld-out evaluation:");
    console.log(`  Validation: ${initialVal.toFixed(3)} -> ${bestVal.toFixed(3)} (${(bestVal - initialVal >= 0 ? "+" : "") + (bestVal - initialVal).toFixed(3)})`);
    console.log(`  Test:       ${initialTest.toFixed(3)} -> ${bestTest.toFixed(3)} (${(bestTest - initialTest >= 0 ? "+" : "") + (bestTest - initialTest).toFixed(3)})`);

    const bestTaskPath = join(best.repoSnapshot, "task.ts");
    if (await Bun.file(bestTaskPath).exists()) {
      console.log("\nBest evolved task prompt builder:");
      console.log("─".repeat(60));
      console.log((await Bun.file(bestTaskPath).text()).slice(0, 3000));
      console.log("─".repeat(60));
    }

    console.log(
      `Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s | Archive: ${entries.length} agents | Best agent: ${result.bestAgentId}`,
    );
  } finally {
    archive.close();
  }
}

main().catch(console.error);
