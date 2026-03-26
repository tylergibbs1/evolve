import type { AgentId, ArchiveEntry, DomainScore } from "./types.ts";

/**
 * Parent selection matching Appendix A.2 of the HyperAgents paper.
 *
 * Balances exploitation (high-scoring agents selected more) with exploration
 * (agents that haven't been explored yet get a novelty bonus). The sigmoid
 * with λ=10 creates a sharp cutoff around the current frontier average.
 *
 * @example
 * ```ts
 * const parents = selectParents(archive, 2, { topM: 3, lambda: 10 });
 * ```
 */
export function selectParents(
  archive: readonly ArchiveEntry[],
  count: number,
  opts: { topM?: number; lambda?: number } = {},
): ArchiveEntry[] {
  const { topM = 3, lambda = 10 } = opts;

  // Filter to valid parents only; fall back to full archive if all invalid
  const eligible = archive.filter((e) => e.validParent);
  const pool = eligible.length > 0 ? eligible : archive;

  if (pool.length === 0) {
    throw new Error("Cannot select parents from empty archive");
  }
  if (pool.length === 1) {
    return Array.from({ length: count }, () => pool[0]!);
  }

  // Step 1: Dynamic midpoint from top-m scores
  const sorted = [...pool].sort(
    (a, b) => getAverageScore(b) - getAverageScore(a),
  );
  const effectiveM = Math.min(topM, sorted.length);
  const topScores = sorted.slice(0, effectiveM).map(getAverageScore);
  const alphaMid = topScores.reduce((a, b) => a + b, 0) / effectiveM;

  // Step 2-4: Sigmoid + novelty bonus per agent
  const weights = pool.map((entry) => {
    const score = getAverageScore(entry);
    const sigmoid = 1 / (1 + Math.exp(-lambda * (score - alphaMid)));
    const novelty = 1 / (1 + entry.compiledChildrenCount);
    return sigmoid * novelty;
  });

  // Step 5: Normalize to categorical distribution
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const probabilities =
    totalWeight > 0
      ? weights.map((w) => w / totalWeight)
      : weights.map(() => 1 / pool.length);

  // Step 6: Sample with replacement
  return sampleCategorical(pool, probabilities, count);
}

/**
 * Average score across all domains for an archive entry.
 * Multi-domain: parent selection uses the average (Appendix A.4).
 */
export function getAverageScore(entry: ArchiveEntry): number {
  if (entry.scores.length === 0) return 0;
  const scores = entry.scores.map((s) =>
    s.validationScore !== null ? s.validationScore : s.trainScore,
  );
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Sample `count` items from `items` according to `probabilities` with replacement.
 * Uses inverse transform sampling.
 */
function sampleCategorical<T>(
  items: readonly T[],
  probabilities: number[],
  count: number,
): T[] {
  // Build CDF
  const cdf: number[] = [];
  let cumulative = 0;
  for (const p of probabilities) {
    cumulative += p;
    cdf.push(cumulative);
  }

  const results: T[] = [];
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    let idx = cdf.findIndex((c) => u <= c);
    if (idx === -1) idx = items.length - 1;
    results.push(items[idx]!);
  }
  return results;
}

/**
 * Growth score for transfer agent selection (Appendix D.4).
 *
 * G_γ(i) = (1/|D(i)|) * Σ_{j ∈ D(i)} (α_j - α_i) * γ^dist(i,j)
 *
 * Selects agents that reliably produce strong improvements within fewer
 * modification steps. Only agents with ≥3 descendants are considered.
 */
export function selectTransferAgent(
  archive: readonly ArchiveEntry[],
  gamma: number = 0.6,
  minDescendants: number = 3,
): ArchiveEntry | null {
  const byId = new Map(archive.map((e) => [e.id, e]));

  let bestScore = -Infinity;
  let bestAgent: ArchiveEntry | null = null;

  for (const candidate of archive) {
    const descendants = getDescendants(candidate.id, archive, byId);
    if (descendants.length < minDescendants) continue;

    const candidateScore = getAverageScore(candidate);
    let growthScore = 0;

    for (const desc of descendants) {
      const improvement = getAverageScore(desc) - candidateScore;
      const distance = getDistance(candidate.id, desc.id, byId);
      growthScore += improvement * Math.pow(gamma, distance);
    }
    growthScore /= descendants.length;

    if (growthScore > bestScore) {
      bestScore = growthScore;
      bestAgent = candidate;
    }
  }

  return bestAgent;
}

function getDescendants(
  ancestorId: AgentId,
  archive: readonly ArchiveEntry[],
  byId: Map<AgentId, ArchiveEntry>,
): ArchiveEntry[] {
  return archive.filter(
    (e) => e.id !== ancestorId && isDescendantOf(e, ancestorId, byId),
  );
}

function isDescendantOf(
  entry: ArchiveEntry,
  ancestorId: AgentId,
  byId: Map<AgentId, ArchiveEntry>,
): boolean {
  let current: ArchiveEntry | undefined = entry;
  while (current) {
    if (current.parentId === ancestorId) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function getDistance(
  fromId: AgentId,
  toId: AgentId,
  byId: Map<AgentId, ArchiveEntry>,
): number {
  let current = byId.get(toId);
  let distance = 0;
  while (current) {
    if (current.id === fromId) return distance;
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    distance++;
  }
  return distance;
}
