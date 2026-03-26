import { test, expect, describe } from "bun:test";
import {
  selectParents,
  getAverageScore,
  selectTransferAgent,
} from "./selection.ts";
import type { ArchiveEntry } from "./types.ts";
import { agentId } from "./types.ts";

function makeEntry(
  id: string,
  trainScore: number,
  children: number = 0,
  parentId: string | null = null,
  generation: number = 0,
): ArchiveEntry {
  return {
    id: agentId(id),
    parentId: parentId ? agentId(parentId) : null,
    generation,
    repoSnapshot: `/tmp/${id}`,
    scores: [
      {
        domain: "test",
        trainScore,
        validationScore: null,
        testScore: null,
      },
    ],
    compiledChildrenCount: children,
    validParent: true,
    metadata: { createdAt: new Date(), diffFromParent: "" },
  };
}

describe("getAverageScore", () => {
  test("returns train score when no validation", () => {
    const entry = makeEntry("a", 0.75);
    expect(getAverageScore(entry)).toBe(0.75);
  });

  test("prefers validation score when available", () => {
    const entry = makeEntry("a", 0.5);
    entry.scores[0]!.validationScore = 0.8;
    expect(getAverageScore(entry)).toBe(0.8);
  });

  test("averages across multiple domains", () => {
    const entry = makeEntry("a", 0.6);
    entry.scores.push({
      domain: "test2",
      trainScore: 0.8,
      validationScore: null,
      testScore: null,
    });
    expect(getAverageScore(entry)).toBe(0.7);
  });

  test("returns 0 for empty scores", () => {
    const entry = makeEntry("a", 0);
    entry.scores = [];
    expect(getAverageScore(entry)).toBe(0);
  });
});

describe("selectParents", () => {
  test("throws on empty archive", () => {
    expect(() => selectParents([], 1)).toThrow("empty archive");
  });

  test("returns the only entry when archive has one agent", () => {
    const archive = [makeEntry("a", 0.5)];
    const parents = selectParents(archive, 3);
    expect(parents.length).toBe(3);
    expect(parents.every((p) => p.id === "a")).toBe(true);
  });

  test("returns correct count", () => {
    const archive = [
      makeEntry("a", 0.3),
      makeEntry("b", 0.7),
      makeEntry("c", 0.9),
    ];
    const parents = selectParents(archive, 5);
    expect(parents.length).toBe(5);
  });

  test("favors high-scoring agents", () => {
    const archive = [
      makeEntry("low", 0.1),
      makeEntry("high", 0.95),
    ];
    // Run many samples and check distribution
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const [parent] = selectParents(archive, 1);
      counts.set(parent!.id, (counts.get(parent!.id) ?? 0) + 1);
    }
    // High scorer should be selected significantly more often
    expect(counts.get("high")!).toBeGreaterThan(counts.get("low")!);
  });

  test("novelty bonus favors unexplored agents", () => {
    const archive = [
      makeEntry("explored", 0.8, 10), // High score but many children
      makeEntry("fresh", 0.75, 0), // Slightly lower but unexplored
    ];
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const [parent] = selectParents(archive, 1);
      counts.set(parent!.id, (counts.get(parent!.id) ?? 0) + 1);
    }
    // Fresh agent should get a meaningful share despite lower score
    expect(counts.get("fresh")!).toBeGreaterThan(200);
  });
});

describe("selectParents edge cases", () => {
  test("handles all agents with equal scores", () => {
    const archive = [
      makeEntry("a", 0.5),
      makeEntry("b", 0.5),
      makeEntry("c", 0.5),
    ];
    // Should not crash — sigmoid around midpoint = 0.5 for all
    const parents = selectParents(archive, 10);
    expect(parents.length).toBe(10);
  });

  test("handles all agents with zero scores", () => {
    const archive = [
      makeEntry("a", 0),
      makeEntry("b", 0),
    ];
    const parents = selectParents(archive, 5);
    expect(parents.length).toBe(5);
  });

  test("custom lambda changes sharpness", () => {
    const archive = [
      makeEntry("low", 0.3),
      makeEntry("high", 0.7),
    ];
    // With lambda=0, sigmoid is flat (0.5 for all) — distribution more uniform
    const countsFlat = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const [p] = selectParents(archive, 1, { lambda: 0 });
      countsFlat.set(p!.id, (countsFlat.get(p!.id) ?? 0) + 1);
    }
    // With lambda=100, sigmoid is step-function — almost all to highest
    const countsSharp = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const [p] = selectParents(archive, 1, { lambda: 100 });
      countsSharp.set(p!.id, (countsSharp.get(p!.id) ?? 0) + 1);
    }
    // Flat should be closer to 50/50 than sharp
    const flatRatio = (countsFlat.get("high") ?? 0) / 1000;
    const sharpRatio = (countsSharp.get("high") ?? 0) / 1000;
    expect(sharpRatio).toBeGreaterThan(flatRatio);
  });

  test("custom topM changes midpoint calculation", () => {
    const archive = [
      makeEntry("a", 0.1),
      makeEntry("b", 0.5),
      makeEntry("c", 0.9),
    ];
    // topM=1: midpoint is 0.9 (only top scorer), most agents well below midpoint
    // topM=3: midpoint is 0.5 (average of all), more balanced
    const parents1 = selectParents(archive, 100, { topM: 1 });
    const parents3 = selectParents(archive, 100, { topM: 3 });
    // Both should work without error
    expect(parents1.length).toBe(100);
    expect(parents3.length).toBe(100);
  });

  test("topM larger than archive size is handled", () => {
    const archive = [makeEntry("a", 0.5), makeEntry("b", 0.7)];
    const parents = selectParents(archive, 5, { topM: 10 });
    expect(parents.length).toBe(5);
  });

  test("sampling with replacement allows duplicates", () => {
    const archive = [makeEntry("a", 0.9), makeEntry("b", 0.1)];
    const parents = selectParents(archive, 10);
    // With high score difference, "a" should appear multiple times
    const aCount = parents.filter((p) => p.id === "a").length;
    expect(aCount).toBeGreaterThan(1);
  });
});

describe("selectTransferAgent", () => {
  test("returns null when no agent has enough descendants", () => {
    const archive = [makeEntry("a", 0.5)];
    expect(selectTransferAgent(archive)).toBeNull();
  });

  test("returns null on empty archive", () => {
    expect(selectTransferAgent([])).toBeNull();
  });

  test("selects agent whose descendants show most improvement", () => {
    const archive = [
      makeEntry("root", 0.2, 3, null, 0),
      makeEntry("c1", 0.3, 1, "root", 1),
      makeEntry("c2", 0.5, 0, "root", 1),
      makeEntry("c3", 0.8, 0, "root", 1),
      makeEntry("gc1", 0.9, 0, "c1", 2),
      // Another branch that doesn't improve much
      makeEntry("other", 0.3, 3, null, 0),
      makeEntry("o1", 0.31, 0, "other", 1),
      makeEntry("o2", 0.32, 0, "other", 1),
      makeEntry("o3", 0.33, 0, "other", 1),
    ];
    const best = selectTransferAgent(archive);
    expect(best).not.toBeNull();
    expect(best!.id).toBe(agentId("root")); // root's descendants show much more improvement
  });

  test("handles descendants that regress", () => {
    const archive = [
      makeEntry("root", 0.8, 3, null, 0),
      makeEntry("c1", 0.3, 0, "root", 1),
      makeEntry("c2", 0.2, 0, "root", 1),
      makeEntry("c3", 0.1, 0, "root", 1),
    ];
    const best = selectTransferAgent(archive);
    // root has 3 descendants but they all regress — growth score is negative
    expect(best).not.toBeNull();
    // It's the only candidate with ≥3 descendants
    expect(best!.id).toBe(agentId("root"));
  });

  test("respects minDescendants parameter", () => {
    const archive = [
      makeEntry("root", 0.2, 5, null, 0),
      makeEntry("c1", 0.4, 0, "root", 1),
      makeEntry("c2", 0.6, 0, "root", 1),
      makeEntry("c3", 0.8, 0, "root", 1),
      makeEntry("c4", 0.9, 0, "root", 1),
      makeEntry("c5", 0.95, 0, "root", 1),
    ];
    // With minDescendants=10, no agent qualifies
    expect(selectTransferAgent(archive, 0.6, 10)).toBeNull();
    // With minDescendants=3, root qualifies
    expect(selectTransferAgent(archive, 0.6, 3)).not.toBeNull();
  });

  test("gamma=0 only considers immediate improvement", () => {
    const archive = [
      makeEntry("root", 0.2, 3, null, 0),
      makeEntry("c1", 0.3, 1, "root", 1),
      makeEntry("c2", 0.4, 0, "root", 1),
      makeEntry("c3", 0.5, 0, "root", 1),
      makeEntry("gc1", 0.95, 0, "c1", 2), // Great grandchild but gamma=0 ignores it
    ];
    const best = selectTransferAgent(archive, 0);
    expect(best).not.toBeNull();
  });
});
