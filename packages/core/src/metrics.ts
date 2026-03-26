import type { ArchiveEntry, AgentId } from "./types.ts";
import { getAverageScore } from "./selection.ts";

/**
 * improvement@k metric (Appendix D.3).
 *
 * Measures a meta agent's ability to generate improved task agents:
 *   imp@k = max_{A' ∈ A^(k)} Evaluate(A', T) - Evaluate(A, T)
 *
 * This isolates the meta agent's quality from parent selection and archive.
 */
export function improvementAtK(
  archive: readonly ArchiveEntry[],
  initialAgentId: AgentId,
  k: number,
): number {
  const initial = archive.find((e) => e.id === initialAgentId);
  if (!initial) return 0;

  const initialScore = getAverageScore(initial);

  // Get the k agents produced within k generations from the initial
  const descendants = archive
    .filter((e) => e.generation <= k && e.id !== initialAgentId)
    .sort((a, b) => getAverageScore(b) - getAverageScore(a));

  const bestDescendantScore = descendants[0]
    ? getAverageScore(descendants[0])
    : initialScore;

  return bestDescendantScore - initialScore;
}

/**
 * Score progression over generations.
 * Returns the best score achieved at each generation.
 */
export function scoreProgression(
  archive: readonly ArchiveEntry[],
): Array<{ generation: number; bestScore: number; avgScore: number; agentCount: number }> {
  if (archive.length === 0) return [];

  const byGen = new Map<number, ArchiveEntry[]>();

  for (const entry of archive) {
    const gen = entry.generation;
    const existing = byGen.get(gen) ?? [];
    existing.push(entry);
    byGen.set(gen, existing);
  }

  const maxGen = Math.max(...archive.map((e) => e.generation));
  const result: Array<{
    generation: number;
    bestScore: number;
    avgScore: number;
    agentCount: number;
  }> = [];

  let runningBest = -Infinity;

  for (let gen = 0; gen <= maxGen; gen++) {
    const entries = byGen.get(gen) ?? [];
    const scores = entries.map(getAverageScore);
    const genBest = scores.length > 0 ? Math.max(...scores) : runningBest;
    runningBest = Math.max(runningBest, genBest);

    result.push({
      generation: gen,
      bestScore: runningBest,
      avgScore:
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 0,
      agentCount: entries.length,
    });
  }

  return result;
}

/**
 * Archive lineage tree — returns parent-child relationships for visualization.
 */
export function lineageTree(
  archive: readonly ArchiveEntry[],
): Array<{ id: AgentId; parentId: AgentId | null; score: number; generation: number }> {
  return archive.map((e) => ({
    id: e.id,
    parentId: e.parentId,
    score: getAverageScore(e),
    generation: e.generation,
  }));
}
