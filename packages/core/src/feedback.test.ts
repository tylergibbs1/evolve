import { test, expect, describe } from "bun:test";
import { buildMetaPrompt, safeArchiveSummary } from "./feedback.ts";
import { agentId } from "./types.ts";
import type { MetaContext, ArchiveSummary } from "./types.ts";

describe("buildMetaPrompt", () => {
  const baseCtx: MetaContext = {
    repoPath: "/tmp/agent-repo",
    evalHistory: [],
    archiveSummary: {
      totalAgents: 0,
      bestScore: 0,
      averageScore: 0,
      topAgents: [],
    },
    remainingIterations: 10,
  };

  test("includes repo path", () => {
    const prompt = buildMetaPrompt(baseCtx);
    expect(prompt).toContain("/tmp/agent-repo");
  });

  test("includes remaining iterations", () => {
    const prompt = buildMetaPrompt(baseCtx);
    expect(prompt).toContain("Remaining iterations: 10");
  });

  test("includes archive summary", () => {
    const ctx: MetaContext = {
      ...baseCtx,
      archiveSummary: {
        totalAgents: 5,
        bestScore: 0.85,
        averageScore: 0.6,
        topAgents: [
          { id: agentId("best"), score: 0.85, generation: 3 },
        ],
      },
    };
    const prompt = buildMetaPrompt(ctx);
    expect(prompt).toContain("Total agents in archive: 5");
    expect(prompt).toContain("0.8500");
    expect(prompt).toContain("gen 3");
  });

  test("skips eval history section when empty", () => {
    const prompt = buildMetaPrompt(baseCtx);
    expect(prompt).not.toContain("Previous Evaluation Results");
  });

  test("includes eval history when present", () => {
    const ctx: MetaContext = {
      ...baseCtx,
      evalHistory: [
        { domain: "coding", score: 0.75 },
        { domain: "review", score: 0.6, feedback: "Too verbose" },
      ],
    };
    const prompt = buildMetaPrompt(ctx);
    expect(prompt).toContain("Previous Evaluation Results");
    expect(prompt).toContain("coding");
    expect(prompt).toContain("0.7500");
    expect(prompt).toContain("review");
    expect(prompt).toContain("Too verbose");
  });

  test("handles zero remaining iterations", () => {
    const ctx: MetaContext = { ...baseCtx, remainingIterations: 0 };
    const prompt = buildMetaPrompt(ctx);
    expect(prompt).toContain("Remaining iterations: 0");
  });

  test("includes instructions section", () => {
    const prompt = buildMetaPrompt(baseCtx);
    expect(prompt).toContain("Instructions");
    expect(prompt).toContain("Modify any part of the codebase");
    expect(prompt).toContain("bash and editor tools");
  });

  test("skips top agents section when empty", () => {
    const prompt = buildMetaPrompt(baseCtx);
    expect(prompt).not.toContain("Top agents:");
  });

  test("includes multiple top agents", () => {
    const ctx: MetaContext = {
      ...baseCtx,
      archiveSummary: {
        totalAgents: 3,
        bestScore: 0.9,
        averageScore: 0.7,
        topAgents: [
          { id: agentId("a1"), score: 0.9, generation: 5 },
          { id: agentId("a2"), score: 0.8, generation: 3 },
        ],
      },
    };
    const prompt = buildMetaPrompt(ctx);
    expect(prompt).toContain("gen 5");
    expect(prompt).toContain("gen 3");
  });
});

describe("safeArchiveSummary", () => {
  test("returns a copy of the summary", () => {
    const original: ArchiveSummary = {
      totalAgents: 10,
      bestScore: 0.9,
      averageScore: 0.5,
      topAgents: [{ id: agentId("top"), score: 0.9, generation: 5 }],
    };
    const safe = safeArchiveSummary(original);
    expect(safe).toEqual(original);
    // Should be a different reference
    expect(safe).not.toBe(original);
    expect(safe.topAgents).not.toBe(original.topAgents);
  });

  test("handles empty summary", () => {
    const original: ArchiveSummary = {
      totalAgents: 0,
      bestScore: 0,
      averageScore: 0,
      topAgents: [],
    };
    const safe = safeArchiveSummary(original);
    expect(safe.totalAgents).toBe(0);
    expect(safe.topAgents).toEqual([]);
  });
});
