import { test, expect, describe } from "bun:test";
import { improvementAtK, scoreProgression, lineageTree } from "./metrics.ts";
import type { ArchiveEntry } from "./types.ts";
import { agentId } from "./types.ts";

function makeEntry(
  id: string,
  trainScore: number,
  generation: number = 0,
  parentId: string | null = null,
): ArchiveEntry {
  return {
    id: agentId(id),
    parentId: parentId ? agentId(parentId) : null,
    generation,
    repoSnapshot: `/tmp/${id}`,
    scores: [{ domain: "test", trainScore, validationScore: null, testScore: null }],
    compiledChildrenCount: 0,
    validParent: true,
    metadata: { createdAt: new Date(), diffFromParent: "" },
  };
}

describe("improvementAtK", () => {
  test("returns 0 for initial agent not found", () => {
    expect(improvementAtK([], agentId("x"), 10)).toBe(0);
  });

  test("measures improvement from initial to best descendant within k gens", () => {
    const archive = [
      makeEntry("init", 0.2, 0),
      makeEntry("gen1", 0.4, 1, "init"),
      makeEntry("gen2", 0.7, 2, "gen1"),
      makeEntry("gen5", 0.9, 5, "gen2"),
    ];
    // k=2: only gen 0-2 considered
    expect(improvementAtK(archive, agentId("init"), 2)).toBeCloseTo(0.5); // 0.7 - 0.2
    // k=5: gen5 included
    expect(improvementAtK(archive, agentId("init"), 5)).toBeCloseTo(0.7); // 0.9 - 0.2
  });

  test("ignores non-descendants even if they appear within k generations", () => {
    const archive = [
      makeEntry("init", 0.2, 0),
      makeEntry("gen1", 0.4, 1, "init"),
      makeEntry("sibling-root", 0.95, 1, null),
    ];

    expect(improvementAtK(archive, agentId("init"), 2)).toBeCloseTo(0.2);
  });

  test("uses lineage distance rather than absolute generation", () => {
    const archive = [
      makeEntry("other-root", 0.1, 0),
      makeEntry("init", 0.2, 3, null),
      makeEntry("child", 0.9, 4, "init"),
    ];

    expect(improvementAtK(archive, agentId("init"), 1)).toBeCloseTo(0.7);
  });
});

describe("improvementAtK edge cases", () => {
  test("k=0 excludes all descendants", () => {
    const archive = [
      makeEntry("init", 0.5, 0),
      makeEntry("gen1", 0.9, 1, "init"),
    ];
    // k=0: only generation <=0, which excludes gen1; init excluded by id filter
    expect(improvementAtK(archive, agentId("init"), 0)).toBe(0);
  });

  test("no descendants returns 0", () => {
    const archive = [makeEntry("init", 0.5, 0)];
    expect(improvementAtK(archive, agentId("init"), 100)).toBe(0);
  });

  test("descendants worse than initial returns negative improvement", () => {
    const archive = [
      makeEntry("init", 0.8, 0),
      makeEntry("gen1", 0.3, 1, "init"),
    ];
    expect(improvementAtK(archive, agentId("init"), 5)).toBeCloseTo(-0.5);
  });
});

describe("scoreProgression", () => {
  test("returns empty array for empty archive", () => {
    expect(scoreProgression([])).toEqual([]);
  });

  test("tracks best score per generation", () => {
    const archive = [
      makeEntry("a0", 0.3, 0),
      makeEntry("a1", 0.5, 1),
      makeEntry("a1b", 0.4, 1),
      makeEntry("a2", 0.8, 2),
    ];
    const prog = scoreProgression(archive);
    expect(prog.length).toBe(3);
    expect(prog[0]!.bestScore).toBe(0.3);
    expect(prog[1]!.bestScore).toBe(0.5); // running best
    expect(prog[2]!.bestScore).toBe(0.8);
    expect(prog[1]!.agentCount).toBe(2);
  });

  test("running best never decreases", () => {
    const archive = [
      makeEntry("a0", 0.9, 0),
      makeEntry("a1", 0.3, 1),
      makeEntry("a2", 0.5, 2),
    ];
    const prog = scoreProgression(archive);
    expect(prog[0]!.bestScore).toBe(0.9);
    expect(prog[1]!.bestScore).toBe(0.9); // running best maintained
    expect(prog[2]!.bestScore).toBe(0.9);
  });

  test("handles gaps in generations", () => {
    const archive = [
      makeEntry("a0", 0.3, 0),
      makeEntry("a5", 0.8, 5),
    ];
    const prog = scoreProgression(archive);
    expect(prog.length).toBe(6); // gen 0 through 5
    // Gaps should carry forward the running best, with 0 agents
    expect(prog[1]!.agentCount).toBe(0);
    expect(prog[1]!.bestScore).toBe(0.3); // carried from gen 0
    expect(prog[5]!.bestScore).toBe(0.8);
  });

  test("single generation archive", () => {
    const archive = [makeEntry("only", 0.42, 0)];
    const prog = scoreProgression(archive);
    expect(prog.length).toBe(1);
    expect(prog[0]!.bestScore).toBe(0.42);
    expect(prog[0]!.avgScore).toBe(0.42);
    expect(prog[0]!.agentCount).toBe(1);
  });
});

describe("lineageTree", () => {
  test("returns all nodes with parent links", () => {
    const archive = [
      makeEntry("root", 0.2, 0),
      makeEntry("child", 0.5, 1, "root"),
    ];
    const tree = lineageTree(archive);
    expect(tree.length).toBe(2);
    expect(tree[0]!.parentId).toBeNull();
    expect(tree[1]!.parentId).toBe(agentId("root"));
  });

  test("includes scores and generations", () => {
    const archive = [makeEntry("a", 0.75, 3)];
    const tree = lineageTree(archive);
    expect(tree[0]!.score).toBe(0.75);
    expect(tree[0]!.generation).toBe(3);
  });

  test("returns empty for empty archive", () => {
    expect(lineageTree([])).toEqual([]);
  });

  test("handles deep lineage", () => {
    const archive = [
      makeEntry("g0", 0.1, 0),
      makeEntry("g1", 0.2, 1, "g0"),
      makeEntry("g2", 0.3, 2, "g1"),
      makeEntry("g3", 0.4, 3, "g2"),
      makeEntry("g4", 0.5, 4, "g3"),
    ];
    const tree = lineageTree(archive);
    expect(tree.length).toBe(5);
    expect(tree[4]!.parentId).toBe(agentId("g3"));
  });
});
