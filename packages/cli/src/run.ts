import { resolve } from "node:path";
import {
  AnthropicProvider,
  BudgetTracker,
  runEvolutionLoop,
  type EvolveEvent,
  type RunConfig,
} from "@evolve/core";

/**
 * `evolve run` — Run the evolution loop.
 *
 * Displays cost estimate before launch, then runs Algorithm 1.
 */
export async function run(opts: {
  iterations: number;
  k: number;
  dir: string;
  configPath?: string;
}): Promise<void> {
  const projectDir = resolve(opts.dir);

  // Load user config
  const configPath = opts.configPath ?? resolve(projectDir, "evolve.config.ts");
  let userConfig: Partial<RunConfig> = {};
  try {
    const mod = await import(configPath);
    userConfig = mod.config ?? mod.default ?? {};
  } catch (err) {
    console.error(`Could not load config from ${configPath}: ${err}`);
    console.error("Run 'evolve init' first to create a project.");
    process.exit(1);
  }

  const config = buildRunConfig(userConfig, opts, projectDir);

  // Cost estimate
  const estimate = BudgetTracker.estimateRunCost(
    config.iterations,
    config.k,
    config.llm.modification.model,
    config.eval.domains.length || 1,
  );

  console.log("\n--- Evolve Run Configuration ---");
  console.log(`  Iterations:      ${config.iterations}`);
  console.log(`  Parents per iter: ${config.k}`);
  console.log(`  Model:           ${config.llm.modification.model}`);
  console.log(`  Budget limit:    $${config.budget.maxCostUSD}`);
  console.log(`  Est. tokens:     ${(estimate.estimatedTokens / 1e6).toFixed(1)}M`);
  console.log(`  Est. cost:       $${estimate.estimatedCostUSD.toFixed(0)}`);
  console.log(`  Output dir:      ${config.outputDir}`);
  console.log("--------------------------------\n");

  if (estimate.estimatedCostUSD > config.budget.maxCostUSD) {
    console.warn(
      `Warning: Estimated cost ($${estimate.estimatedCostUSD.toFixed(0)}) ` +
        `exceeds budget ($${config.budget.maxCostUSD}). Run will stop when budget is exhausted.`,
    );
  }

  const provider = new AnthropicProvider();

  console.log("Starting evolution loop...\n");
  const startTime = Date.now();

  const result = await runEvolutionLoop(provider, config, logEvent);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n--- Run Complete ---`);
  console.log(`  Best agent:      ${result.bestAgentId}`);
  console.log(`  Best score:      ${result.bestScore.toFixed(4)}`);
  console.log(`  Iterations:      ${result.totalIterations}`);
  console.log(`  Elapsed:         ${elapsed} min`);
  console.log(`  Output:          ${config.outputDir}`);
}

function logEvent(event: EvolveEvent): void {
  switch (event.type) {
    case "iteration_start":
      console.log(
        `[iter ${event.iteration}] Selecting parents: ${event.parentIds.join(", ")}`,
      );
      break;
    case "iteration_end":
      console.log(
        `[iter ${event.iteration}] Created ${event.newAgentIds.length} new agent(s)`,
      );
      break;
    case "eval_complete":
      console.log(
        `  [eval] ${event.agentId}: ${event.scores.map((s) => `${s.domain}=${s.trainScore.toFixed(3)}`).join(", ")}`,
      );
      break;
    case "budget_warning":
      console.warn(
        `  [budget] ${event.percentUsed.toFixed(0)}% used ($${event.estimatedCostUSD.toFixed(2)})`,
      );
      break;
    case "agent_created":
      // Logged as part of iteration_end
      break;
    case "eval_staged_skip":
      console.log(
        `  [eval] ${event.agentId} skipped stage ${event.stage}: ${event.reason}`,
      );
      break;
    case "run_complete":
      // Logged in the run function
      break;
  }
}

function buildRunConfig(
  user: Partial<RunConfig>,
  opts: { iterations: number; k: number; dir: string },
  projectDir: string,
): RunConfig {
  const defaultLLM = {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  };

  return {
    iterations: opts.iterations ?? user.iterations ?? 10,
    k: opts.k ?? user.k ?? 2,
    topM: user.topM ?? 3,
    lambda: user.lambda ?? 10,
    initialAgentPath: user.initialAgentPath ?? resolve(projectDir, "agent"),
    outputDir: user.outputDir ?? resolve(projectDir, "output"),
    llm: {
      diagnosis: user.llm?.diagnosis ?? defaultLLM,
      modification: user.llm?.modification ?? defaultLLM,
      evaluation: user.llm?.evaluation ?? defaultLLM,
    },
    budget: {
      maxTokensPerIteration: user.budget?.maxTokensPerIteration ?? 1_000_000,
      maxTotalTokens: user.budget?.maxTotalTokens ?? 100_000_000,
      maxCostUSD: user.budget?.maxCostUSD ?? 500,
      pauseOnBudgetExhausted: user.budget?.pauseOnBudgetExhausted ?? true,
      warnAtPercentage: user.budget?.warnAtPercentage ?? 80,
    },
    sandbox: {
      limits: {
        maxWallTimeSeconds:
          user.sandbox?.limits?.maxWallTimeSeconds ?? 300,
        maxMemoryMB: user.sandbox?.limits?.maxMemoryMB ?? 512,
        maxLLMCalls: user.sandbox?.limits?.maxLLMCalls ?? 50,
        networkAccess: user.sandbox?.limits?.networkAccess ?? "llm-only",
      },
    },
    eval: user.eval ?? {
      domains: [],
      stagedEval: {
        stages: [{ taskCount: 10, passThreshold: 0, passCondition: "any" }],
        defaultScore: 0,
      },
      parentSelectionScore: "training",
    },
    protectedPaths: user.protectedPaths ?? [],
    editableSelection: user.editableSelection ?? false,
  };
}
