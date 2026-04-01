import type { ArchiveEntry, AgentId } from "./types.ts";
import { getAverageScoreForMode, type ScoreSelectionMode } from "./selection.ts";

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
  scoreMode: ScoreSelectionMode = "validation",
): number {
  const initial = archive.find((e) => e.id === initialAgentId);
  if (!initial) return 0;

  const initialScore = getAverageScoreForMode(initial, scoreMode);
  const byId = new Map(archive.map((entry) => [entry.id, entry]));

  // Restrict to descendants of the specified initial agent that are reachable
  // within k modification steps, matching the paper's A^(k) definition.
  const descendants = archive
    .filter((entry) => {
      if (entry.id === initialAgentId) return false;
      const distance = getLineageDistance(initialAgentId, entry.id, byId);
      return distance !== null && distance <= k;
    })
    .sort(
      (a, b) =>
        getAverageScoreForMode(b, scoreMode) - getAverageScoreForMode(a, scoreMode),
    );

  const bestDescendantScore = descendants[0]
    ? getAverageScoreForMode(descendants[0], scoreMode)
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
    const scores = entries.map((entry) => getAverageScoreForMode(entry));
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
    score: getAverageScoreForMode(e),
    generation: e.generation,
  }));
}

function getLineageDistance(
  ancestorId: AgentId,
  descendantId: AgentId,
  byId: Map<AgentId, ArchiveEntry>,
): number | null {
  let current = byId.get(descendantId);
  let distance = 0;

  while (current) {
    if (current.id === ancestorId) return distance;
    if (current.parentId === null) return null;
    current = byId.get(current.parentId);
    distance++;
  }

  return null;
}
