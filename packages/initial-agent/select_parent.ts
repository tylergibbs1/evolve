/**
 * Editable parent selection script.
 *
 * This file is run by the evolution loop when `editableSelection` is enabled.
 * The meta agent can modify this file to evolve the selection strategy.
 *
 * Input (stdin): JSON with { archive, count }
 *   - archive: Array of { id, parentId, generation, scores, compiledChildrenCount, validParent }
 *   - count: Number of parents to select
 *
 * Output (stdout): JSON array of selected agent IDs
 *
 * The default implementation matches the sigmoid + novelty algorithm from
 * Appendix A.2 of the HyperAgents paper.
 */

interface ArchiveItem {
  id: string;
  parentId: string | null;
  generation: number;
  scores: Array<{
    domain: string;
    trainScore: number;
    validationScore: number | null;
    testScore: number | null;
  }>;
  compiledChildrenCount: number;
  validParent: boolean;
}

interface Input {
  archive: ArchiveItem[];
  count: number;
}

function getScore(item: ArchiveItem): number {
  if (item.scores.length === 0) return 0;
  const scores = item.scores.map((s) =>
    s.validationScore !== null ? s.validationScore : s.trainScore,
  );
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function selectParents(archive: ArchiveItem[], count: number): string[] {
  const eligible = archive.filter((e) => e.validParent);
  const pool = eligible.length > 0 ? eligible : archive;

  if (pool.length === 0) return [];
  if (pool.length === 1) return Array.from({ length: count }, () => pool[0]!.id);

  // Dynamic midpoint from top-3 scorers
  const sorted = [...pool].sort((a, b) => getScore(b) - getScore(a));
  const topM = Math.min(3, sorted.length);
  const topScores = sorted.slice(0, topM).map(getScore);
  const alphaMid = topScores.reduce((a, b) => a + b, 0) / topM;

  // Sigmoid + novelty bonus
  const lambda = 10;
  const weights = pool.map((entry) => {
    const score = getScore(entry);
    const sigmoid = 1 / (1 + Math.exp(-lambda * (score - alphaMid)));
    const novelty = 1 / (1 + entry.compiledChildrenCount);
    return sigmoid * novelty;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const probabilities =
    totalWeight > 0
      ? weights.map((w) => w / totalWeight)
      : weights.map(() => 1 / pool.length);

  // Sample with replacement
  const cdf: number[] = [];
  let cumulative = 0;
  for (const p of probabilities) {
    cumulative += p;
    cdf.push(cumulative);
  }

  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    let idx = cdf.findIndex((c) => u <= c);
    if (idx === -1) idx = pool.length - 1;
    results.push(pool[idx]!.id);
  }
  return results;
}

// Read input from stdin, run selection, write output to stdout
const chunks: string[] = [];
const reader = Bun.stdin.stream().getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(new TextDecoder().decode(value));
}
const input: Input = JSON.parse(chunks.join(""));
const selected = selectParents(input.archive, input.count);
process.stdout.write(JSON.stringify(selected));
