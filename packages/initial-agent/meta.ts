/**
 * Initial meta agent — deliberately minimal (Appendix A.1).
 *
 * The meta agent receives the repo path, previous evaluation results,
 * and remaining iteration budget. Its only instruction is:
 * "Modify any part of the codebase."
 *
 * From Section 4: "We deliberately keep the implementation of the initial
 * hyperagent simple, allowing for a broad search space and avoiding
 * prematurely constraining the range of possible improvements."
 */

export interface MetaInput {
  repoPath: string;
  evalHistory: Array<{ domain: string; score: number; feedback?: string }>;
  archiveSummary: {
    totalAgents: number;
    bestScore: number;
    averageScore: number;
  };
  remainingIterations: number;
}

/**
 * Build the meta agent's instruction prompt.
 * This is what gets evolved — future generations may completely rewrite this.
 */
export function buildMetaPrompt(input: MetaInput): string {
  const lines: string[] = [];

  lines.push(`Modify any part of the codebase at '${input.repoPath}'.`);
  lines.push("");

  if (input.evalHistory.length > 0) {
    lines.push("Previous evaluation results:");
    for (const result of input.evalHistory) {
      lines.push(`  ${result.domain}: ${result.score}`);
      if (result.feedback) {
        lines.push(`    Feedback: ${result.feedback}`);
      }
    }
    lines.push("");
  }

  lines.push(`Remaining iterations: ${input.remainingIterations}`);
  lines.push(`Archive size: ${input.archiveSummary.totalAgents} agents`);
  lines.push(`Best score so far: ${input.archiveSummary.bestScore}`);

  return lines.join("\n");
}
