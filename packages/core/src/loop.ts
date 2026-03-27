import { cp, mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Archive } from "./archive.ts";
import { evaluateAgent } from "./evaluate.ts";
import { buildMetaPrompt } from "./feedback.ts";
import { BudgetTracker } from "./llm/budget.ts";
import type { LLMProvider } from "./llm/provider.ts";
import { runToolLoop } from "./llm/provider.ts";
import { selectParents, getAverageScore } from "./selection.ts";
import { ScopedBashTool } from "./tools/bash.ts";
import { ScopedEditorTool, executeEditorCommand } from "./tools/editor.ts";
import { ALL_TOOL_DEFINITIONS } from "./tools/interface.ts";
import {
  type AgentId,
  type ArchiveEntry,
  type EvalCase,
  type EvalFeedback,
  type EvolveEvent,
  type EventListener,
  type OutputSchema,
  type RunConfig,
  type ToolDefinition,
  EvolveException,
  agentId,
} from "./types.ts";

/**
 * Algorithm 1 from the DGM-H paper: the core evolution loop.
 *
 * 1. Evaluate the initial agent and add to archive
 * 2. For each iteration:
 *    a. Select k parent(s) from archive
 *    b. For each parent (in parallel):
 *       - Clone parent repo
 *       - Run meta agent to modify the clone
 *       - Check if variant compiles
 *       - Evaluate variant on tasks
 *       - Add to archive if compiled
 *    c. Increment parent's compiledChildrenCount
 *
 * @example
 * ```ts
 * const result = await runEvolutionLoop(provider, config, emit);
 * console.log(`Best agent: ${result.bestAgentId}, score: ${result.bestScore}`);
 * ```
 */
export async function runEvolutionLoop(
  provider: LLMProvider,
  config: RunConfig,
  emit: EventListener = () => {},
): Promise<{ bestAgentId: AgentId; bestScore: number; totalIterations: number }> {
  await mkdir(config.outputDir, { recursive: true });
  const archive = new Archive(config.outputDir);
  const budget = new BudgetTracker(
    config.budget,
    config.llm.modification.model,
  );

  // Cache per-case feedback so the meta agent can see which cases failed
  const feedbackCache = new Map<AgentId, EvalFeedback[]>();

  try {
    // --- Step 0: Evaluate initial agent and add to archive ---
    const initialId = agentId(`agent-0-initial`);
    const initialScores = await evaluateAgent(
      initialId,
      (evalCase, domain) => {
        const domainConfig = config.eval.domains.find(d => d.name === domain);
        return runTaskAgent(provider, config, config.initialAgentPath, evalCase, domain, domainConfig?.outputSchema);
      },
      config.eval.domains,
      config.eval.stagedEval,
      [],
    );

    await archive.add(
      initialId,
      null,
      0,
      config.initialAgentPath,
      initialScores.scores,
      "",
    );
    feedbackCache.set(initialId, initialScores.feedback);
    emit({
      type: "eval_complete",
      agentId: initialId,
      scores: initialScores.scores,
    });

    // --- Main evolution loop ---
    for (let t = 1; t <= config.iterations; t++) {
      // Budget check
      const budgetError = budget.check();
      if (budgetError) {
        if (config.budget.pauseOnBudgetExhausted) {
          emit({
            type: "budget_warning",
            percentUsed: 100,
            estimatedCostUSD: budget.getState().estimatedCostUSD,
          });
          break;
        }
        throw new EvolveException(budgetError);
      }

      // Select k parents — either via fixed algorithm or agent's editable selection
      const archiveEntries = archive.entries();
      let parents: ArchiveEntry[];
      if (config.editableSelection) {
        parents = await runEditableSelection(
          provider,
          config,
          archiveEntries,
          config.k,
        );
      } else {
        parents = selectParents(archiveEntries, config.k, {
          topM: config.topM,
          lambda: config.lambda,
        });
      }
      const parentIds = parents.map((p) => p.id);
      emit({ type: "iteration_start", iteration: t, parentIds });

      // Process k parents in parallel
      const newAgentIds: AgentId[] = [];
      const results = await Promise.allSettled(
        parents.map(async (parent, idx) => {
          const childId = agentId(`agent-${t}-${idx}`);

          // Clone parent repo
          const childRepoPath = join(
            config.outputDir,
            "working",
            childId,
          );
          await mkdir(join(config.outputDir, "working"), { recursive: true });
          await cp(parent.repoSnapshot, childRepoPath, { recursive: true });

          // Run meta agent to modify the clone — use cached feedback if available
          const cachedFeedback = feedbackCache.get(parent.id);
          const evalHistory = cachedFeedback ?? parent.scores.map(
            (s): EvalFeedback => ({
              domain: s.domain,
              score: s.validationScore ?? s.trainScore,
            }),
          );

          const metaResult = await runMetaAgent(
            provider,
            config,
            childRepoPath,
            evalHistory,
            archive.summary(),
            config.iterations - t,
          );
          budget.recordUsage(
            metaResult.usage.inputTokens,
            metaResult.usage.outputTokens,
          );

          // Restore protected paths — undo any meta agent changes to eval/domain files
          if (config.protectedPaths.length > 0) {
            await restoreProtectedPaths(
              parent.repoSnapshot,
              childRepoPath,
              config.protectedPaths,
            );
          }

          // Check if variant compiles
          const compiles = await checkCompiles(childRepoPath);
          if (!compiles) {
            return { compiled: false as const, parentId: parent.id };
          }

          // Capture diff
          const diff = await captureDiff(parent.repoSnapshot, childRepoPath);

          // Evaluate variant
          const evalResult = await evaluateAgent(
            childId,
            (evalCase, domain) => {
              const domainConfig = config.eval.domains.find(d => d.name === domain);
              return runTaskAgent(provider, config, childRepoPath, evalCase, domain, domainConfig?.outputSchema);
            },
            config.eval.domains,
            config.eval.stagedEval,
            archive.entries(),
          );

          return { compiled: true as const, childId, childRepoPath, evalResult, diff, parentId: parent.id };
        }),
      );

      // Process results: add compiled variants, mark invalid parents
      const failedParents = new Map<AgentId, number>(); // parentId -> failure count
      const attemptedParents = new Map<AgentId, number>(); // parentId -> attempt count

      for (const result of results) {
        if (result.status !== "fulfilled" || result.value === null) continue;
        const val = result.value;

        // Track attempts per parent
        attemptedParents.set(
          val.parentId,
          (attemptedParents.get(val.parentId) ?? 0) + 1,
        );

        if (!val.compiled) {
          failedParents.set(
            val.parentId,
            (failedParents.get(val.parentId) ?? 0) + 1,
          );
          continue;
        }

        const { childId, childRepoPath, evalResult, diff, parentId } = val;
        feedbackCache.set(childId, evalResult.feedback);
        await archive.add(
          childId,
          parentId,
          t,
          childRepoPath,
          evalResult.scores,
          diff,
        );
        archive.incrementChildCount(parentId);
        newAgentIds.push(childId);

        emit({
          type: "agent_created",
          agentId: childId,
          parentId,
          generation: t,
        });
        emit({
          type: "eval_complete",
          agentId: childId,
          scores: evalResult.scores,
        });
      }

      // Invalidate parents whose children ALL failed compilation
      for (const [parentId, failures] of failedParents) {
        const attempts = attemptedParents.get(parentId) ?? 0;
        if (failures === attempts) {
          archive.invalidateParent(parentId);
        }
      }

      budget.recordIteration();
      emit({ type: "iteration_end", iteration: t, newAgentIds });

      // Budget warning
      if (budget.isWarningThreshold()) {
        emit({
          type: "budget_warning",
          percentUsed:
            (budget.getState().estimatedCostUSD / config.budget.maxCostUSD) *
            100,
          estimatedCostUSD: budget.getState().estimatedCostUSD,
        });
      }
    }

    // --- Return best agent ---
    const best = archive.topK(1)[0];
    const bestId = best?.id ?? initialId;
    const bestScore = best ? getAverageScore(best) : 0;

    emit({
      type: "run_complete",
      bestAgentId: bestId,
      bestScore,
      totalIterations: config.iterations,
    });

    return { bestAgentId: bestId, bestScore, totalIterations: config.iterations };
  } finally {
    archive.close();
  }
}

/**
 * Run the meta agent on a cloned repo to generate modifications.
 * The meta agent uses bash + editor tools to modify the codebase.
 */
async function runMetaAgent(
  provider: LLMProvider,
  config: RunConfig,
  repoPath: string,
  evalHistory: EvalFeedback[],
  archiveSummary: import("./types.ts").ArchiveSummary,
  remainingIterations: number,
): Promise<{ usage: { inputTokens: number; outputTokens: number } }> {
  const bash = new ScopedBashTool(repoPath);
  const editor = new ScopedEditorTool(repoPath);

  const prompt = buildMetaPrompt({
    repoPath,
    evalHistory,
    archiveSummary,
    remainingIterations,
  });

  const executeTool = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    try {
      if (name === "bash") {
        const result = await bash.run(input["command"] as string);
        return result.exitCode === 0
          ? result.stdout
          : `Exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
      }
      if (name === "editor") {
        return await executeEditorCommand(editor, input);
      }
      return `Unknown tool: ${name}`;
    } catch (err) {
      return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const result = await runToolLoop(
    provider,
    config.llm.modification,
    prompt,
    [{ role: "user", content: `Modify the codebase at '${repoPath}' to improve performance.` }],
    ALL_TOOL_DEFINITIONS,
    executeTool,
    config.sandbox.limits.maxLLMCalls,
  );

  return { usage: result.totalUsage };
}

/**
 * Run the task agent on a single evaluation case.
 *
 * The agent's `task.ts` is executed as a Bun subprocess to construct the
 * prompt. The LLM is then called with a forced tool call (`tool_choice`)
 * to get structured JSON output — no parsing needed.
 *
 * The agent's code is *executed*, not shown to the LLM. This matches both
 * papers: the task agent is a program that the meta agent can modify.
 */
async function runTaskAgent(
  provider: LLMProvider,
  config: RunConfig,
  repoPath: string,
  evalCase: EvalCase,
  _domain: string,
  outputSchema?: OutputSchema,
): Promise<unknown> {
  const customTaskPath = join(repoPath, "task.ts");
  const customTaskExists = await Bun.file(customTaskPath).exists();

  let taskPrompt: string;

  if (customTaskExists) {
    // Execute task.ts as a subprocess — the agent's code drives prompt construction
    try {
      const runner = `
import { buildTaskPrompt } from "./task.ts";
const input = JSON.parse(await Bun.stdin.text());
const prompt = buildTaskPrompt(input);
process.stdout.write(prompt);
`;
      const runnerPath = join(repoPath, ".task-runner.ts");
      await Bun.write(runnerPath, runner);

      const proc = Bun.spawn(["bun", "run", runnerPath], {
        cwd: repoPath,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        env: {
          HOME: repoPath,
          PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
        },
      });

      proc.stdin.write(JSON.stringify(evalCase.input));
      proc.stdin.flush();
      proc.stdin.end();

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      taskPrompt = (exitCode === 0 && stdout.trim().length > 0)
        ? stdout
        : buildGenericTaskPrompt(evalCase);
    } catch {
      taskPrompt = buildGenericTaskPrompt(evalCase);
    }
  } else {
    taskPrompt = buildGenericTaskPrompt(evalCase);
  }

  // When an outputSchema is provided, use structured outputs (output_config.format)
  // to guarantee the response matches the schema. No tool hack needed.
  if (outputSchema) {
    const response = await provider.chat(
      [
        { role: "system", content: "You are a task-solving agent. Return your answer as JSON matching the required schema." },
        { role: "user", content: taskPrompt },
      ],
      config.llm.evaluation,
      undefined,
      undefined,
      outputSchema,
    );

    try {
      return JSON.parse(response.content);
    } catch {
      return response.content;
    }
  }

  // Fallback: use submit_response tool with forced tool_choice
  const submitTool: ToolDefinition = {
    name: "submit_response",
    description: "Submit your response to the task.",
    inputSchema: {
      type: "object",
      properties: {
        response: {
          description: "Your response to the task. Can be any JSON value — string, object, array, etc.",
        },
      },
      required: ["response"],
    },
  };

  const response = await provider.chat(
    [
      { role: "system", content: "You are a task-solving agent. Use the submit_response tool to return your answer." },
      { role: "user", content: taskPrompt },
    ],
    config.llm.evaluation,
    [submitTool],
    { tool: "submit_response" },
  );

  const toolCall = response.toolCalls[0];
  if (toolCall) {
    return toolCall.input["response"] ?? toolCall.input;
  }

  try {
    return JSON.parse(response.content);
  } catch {
    return response.content;
  }
}

function buildGenericTaskPrompt(evalCase: EvalCase): string {
  return `You are an agent.

Task input:
'''
${JSON.stringify(evalCase.input)}
'''

Respond with your answer using the submit_response tool.`;
}

/**
 * Check if an agent variant has valid, parseable TypeScript.
 *
 * Uses `bun build --no-bundle` for a quick syntax check. Falls back to
 * checking that the task.ts file exists and is non-empty — the agent's
 * code runs inside a tool loop, not as a standalone module, so strict
 * compilation isn't required.
 */
async function checkCompiles(repoPath: string): Promise<boolean> {
  const taskFile = Bun.file(join(repoPath, "task.ts"));
  if (!(await taskFile.exists())) return false;
  const content = await taskFile.text();
  if (content.trim().length === 0) return false;

  // Quick syntax check — verify Bun can parse the file
  const proc = Bun.spawn(
    ["bun", "build", "--no-bundle", join(repoPath, "task.ts"), "--outdir", "/dev/null"],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  if (exitCode === 0) return true;

  // Fallback: if bun build fails (e.g. missing imports), check basic syntax
  // by trying to parse as a module. The agent code is run as prompt text,
  // not executed directly, so import errors are acceptable.
  const syntaxProc = Bun.spawn(
    ["bun", "eval", `await import("${join(repoPath, "task.ts")}");`],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(syntaxProc.stderr).text();
  await syntaxProc.exited;

  // Accept if no SyntaxError — other errors (like missing modules) are OK
  return !stderr.includes("SyntaxError");
}

/**
 * Capture the diff between parent and child repos.
 */
async function captureDiff(
  parentPath: string,
  childPath: string,
): Promise<string> {
  const proc = Bun.spawn(["diff", "-rq", parentPath, childPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

/**
 * Restore protected paths in the child repo from the parent repo.
 *
 * After the meta agent runs, any files matching `protectedPaths` are copied
 * back from the parent snapshot. This prevents the agent from modifying
 * evaluation harnesses, domain configs, or other files that should stay fixed.
 *
 * Matches HyperAgents' behavior of resetting `domains/` after meta agent runs.
 */
async function restoreProtectedPaths(
  parentPath: string,
  childPath: string,
  protectedPaths: string[],
): Promise<void> {
  const { stat, rm } = await import("node:fs/promises");
  for (const protectedPath of protectedPaths) {
    const srcPath = join(parentPath, protectedPath);
    const dstPath = join(childPath, protectedPath);
    try {
      const srcStat = await stat(srcPath);
      if (srcStat.isDirectory()) {
        await rm(dstPath, { recursive: true, force: true });
        await cp(srcPath, dstPath, { recursive: true });
      } else {
        await cp(srcPath, dstPath);
      }
    } catch {
      // Source doesn't exist — nothing to restore
    }
  }
}

/**
 * Run the agent's own editable `select_parent.ts` to choose parents.
 *
 * This is the metacognitive feature from HyperAgents Appendix E.5.
 * The agent can modify `select_parent.ts` to evolve its own selection strategy.
 *
 * The script receives the archive as JSON on stdin and must output a JSON
 * array of selected agent IDs on stdout.
 *
 * Falls back to fixed selection if the script doesn't exist or fails.
 */
async function runEditableSelection(
  _provider: LLMProvider,
  config: RunConfig,
  archive: readonly ArchiveEntry[],
  count: number,
): Promise<ArchiveEntry[]> {
  // Find the best agent's repo to source the selection script from
  const bestAgent = [...archive].sort(
    (a, b) => getAverageScore(b) - getAverageScore(a),
  )[0];

  if (!bestAgent) {
    return selectParents(archive, count, {
      topM: config.topM,
      lambda: config.lambda,
    });
  }

  const selectionScript = join(bestAgent.repoSnapshot, "select_parent.ts");
  const scriptExists = await Bun.file(selectionScript).exists();

  if (!scriptExists) {
    return selectParents(archive, count, {
      topM: config.topM,
      lambda: config.lambda,
    });
  }

  // Prepare archive data for the script (no repo paths exposed)
  const archiveData = archive.map((e) => ({
    id: e.id,
    parentId: e.parentId,
    generation: e.generation,
    scores: e.scores,
    compiledChildrenCount: e.compiledChildrenCount,
    validParent: e.validParent,
  }));

  const input = JSON.stringify({ archive: archiveData, count });

  try {
    const proc = Bun.spawn(["bun", "run", selectionScript], {
      cwd: bestAgent.repoSnapshot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
      },
    });

    // Write archive data to stdin
    proc.stdin.write(input);
    proc.stdin.flush();
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // Script failed — fall back to fixed selection
      return selectParents(archive, count, {
        topM: config.topM,
        lambda: config.lambda,
      });
    }

    // Parse selected IDs from stdout
    const selectedIds: string[] = JSON.parse(stdout.trim());
    const byId = new Map(archive.map((e) => [e.id as string, e]));
    const selected = selectedIds
      .map((id) => byId.get(id))
      .filter((e): e is ArchiveEntry => e !== undefined);

    if (selected.length === 0) {
      return selectParents(archive, count, {
        topM: config.topM,
        lambda: config.lambda,
      });
    }

    // Pad with duplicates if script returned fewer than count
    while (selected.length < count) {
      selected.push(selected[selected.length - 1]!);
    }

    return selected.slice(0, count);
  } catch {
    // Any error — fall back to fixed selection
    return selectParents(archive, count, {
      topM: config.topM,
      lambda: config.lambda,
    });
  }
}
