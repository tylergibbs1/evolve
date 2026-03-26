import { resolve } from "node:path";
import { Archive, scoreProgression, lineageTree, getAverageScore } from "@evolve/core";

/**
 * `evolve results` — Display archive contents and evolution progress.
 */
export function results(opts: { dir: string; top?: number }): void {
  const outputDir = resolve(opts.dir, "output");
  let archive: Archive;

  try {
    archive = new Archive(outputDir);
  } catch {
    console.error(`No archive found at ${outputDir}`);
    console.error("Run 'evolve run' first.");
    process.exit(1);
  }

  try {
    const entries = archive.entries();
    if (entries.length === 0) {
      console.log("Archive is empty.");
      return;
    }

    const topN = opts.top ?? 10;

    console.log(`\n--- Archive: ${entries.length} agents ---\n`);

    // Top agents
    const top = archive.topK(topN);
    console.log(`Top ${Math.min(topN, top.length)} agents:`);
    console.log(
      "  " +
        ["Rank", "ID", "Gen", "Score", "Children"].map(pad).join("  "),
    );
    console.log("  " + "-".repeat(70));
    for (let i = 0; i < top.length; i++) {
      const e = top[i]!;
      console.log(
        "  " +
          [
            String(i + 1),
            e.id,
            String(e.generation),
            getAverageScore(e).toFixed(4),
            String(e.compiledChildrenCount),
          ]
            .map(pad)
            .join("  "),
      );
    }

    // Score progression
    const progression = scoreProgression(entries);
    console.log(`\nScore Progression:`);
    console.log(
      "  " + ["Gen", "Best", "Avg", "Agents"].map(pad).join("  "),
    );
    console.log("  " + "-".repeat(50));
    for (const p of progression) {
      console.log(
        "  " +
          [
            String(p.generation),
            p.bestScore.toFixed(4),
            p.avgScore.toFixed(4),
            String(p.agentCount),
          ]
            .map(pad)
            .join("  "),
      );
    }

    // Lineage summary
    const tree = lineageTree(entries);
    const roots = tree.filter((n) => n.parentId === null);
    const maxDepth = Math.max(...entries.map((e) => e.generation));
    console.log(`\nLineage: ${roots.length} root(s), max depth ${maxDepth}`);
  } finally {
    archive.close();
  }
}

function pad(s: string): string {
  return s.padEnd(14);
}
