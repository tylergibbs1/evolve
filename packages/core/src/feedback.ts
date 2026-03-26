import type { ArchiveSummary, EvalFeedback, MetaContext } from "./types.ts";

/**
 * Constructs the prompt context for the meta agent.
 *
 * The meta agent receives: the repo path, previous evaluation results,
 * archive summary, and remaining iterations. It NEVER receives scoring
 * implementation details (DGM Appendix H).
 */
export function buildMetaPrompt(ctx: MetaContext): string {
  const lines: string[] = [];

  lines.push("# Self-Improvement Task");
  lines.push("");
  lines.push(`You are a meta agent tasked with improving a codebase at '${ctx.repoPath}'.`);
  lines.push(`Remaining iterations: ${ctx.remainingIterations}`);
  lines.push("");

  // Eval history
  if (ctx.evalHistory.length > 0) {
    lines.push("## Previous Evaluation Results");
    lines.push("");
    for (const fb of ctx.evalHistory) {
      lines.push(`- **${fb.domain}**: score = ${fb.score.toFixed(4)}`);
      if (fb.feedback) {
        lines.push(`  Feedback: ${fb.feedback}`);
      }
    }
    lines.push("");
  }

  // Archive summary
  lines.push("## Archive Summary");
  lines.push("");
  lines.push(`- Total agents in archive: ${ctx.archiveSummary.totalAgents}`);
  lines.push(`- Best score: ${ctx.archiveSummary.bestScore.toFixed(4)}`);
  lines.push(`- Average score: ${ctx.archiveSummary.averageScore.toFixed(4)}`);
  if (ctx.archiveSummary.topAgents.length > 0) {
    lines.push("- Top agents:");
    for (const agent of ctx.archiveSummary.topAgents) {
      lines.push(
        `  - gen ${agent.generation}: score ${agent.score.toFixed(4)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Instructions");
  lines.push("");
  lines.push(
    "Analyze the current codebase and evaluation results. " +
      "Modify any part of the codebase to improve performance. " +
      "You can modify the task agent (how tasks are solved), the meta agent (how improvements are generated), " +
      "or create new files, utilities, and infrastructure.",
  );
  lines.push("");
  lines.push(
    "Use the bash and editor tools to examine the code, understand it, and make targeted improvements.",
  );

  return lines.join("\n");
}

/**
 * Construct an archive summary safe for agent consumption.
 * No internal IDs or paths exposed.
 */
export function safeArchiveSummary(summary: ArchiveSummary): ArchiveSummary {
  return {
    totalAgents: summary.totalAgents,
    bestScore: summary.bestScore,
    averageScore: summary.averageScore,
    topAgents: summary.topAgents.map((a) => ({
      id: a.id, // The agent can reference these but can't access their code
      score: a.score,
      generation: a.generation,
    })),
  };
}
