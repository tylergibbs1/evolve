import { test, expect, describe } from "bun:test";
import { evaluateAgent } from "./evaluate.ts";
import { agentId } from "./types.ts";
import type { DomainConfig, StagedEvalConfig } from "./types.ts";

describe("evaluateAgent", () => {
  const makeDomain = (name: string, caseCount: number): DomainConfig => ({
    name,
    trainCases: Array.from({ length: caseCount }, (_, i) => ({
      id: `case-${i}`,
      input: { value: i },
      expected: { answer: i * 2 },
    })),
    testCases: [],
    scorer: async (output: unknown, expected) => {
      const exp = (expected.expected as { answer: number }).answer;
      return output === exp ? 1 : 0;
    },
  });

  test("evaluates all cases in single stage", async () => {
    const domain = makeDomain("math", 5);
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 5, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    // Agent that always returns correct answer
    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val * 2;
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    expect(result.scores.length).toBe(1);
    expect(result.scores[0]!.trainScore).toBe(1);
    expect(result.feedback[0]!.score).toBe(1);
  });

  test("staged evaluation stops early on failure", async () => {
    const domain = makeDomain("math", 10);
    const staged: StagedEvalConfig = {
      stages: [
        { taskCount: 3, passThreshold: 0.5, passCondition: "rate" },
        { taskCount: 10, passThreshold: 0, passCondition: "any" },
      ],
      defaultScore: 0,
    };

    // Agent that always fails
    const runTask = async () => "wrong";

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    // Should get 0 because it failed stage 1
    expect(result.scores[0]!.trainScore).toBe(0);
  });

  test("handles validation set", async () => {
    const domain: DomainConfig = {
      ...makeDomain("math", 3),
      validationCases: [
        { id: "val-1", input: { value: 10 }, expected: { answer: 20 } },
        { id: "val-2", input: { value: 5 }, expected: { answer: 10 } },
      ],
    };
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 3, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val * 2;
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    expect(result.scores[0]!.validationScore).toBe(1);
    // Feedback should use validation score
    expect(result.feedback[0]!.score).toBe(1);
  });

  test("multiple domains", async () => {
    const domain1 = makeDomain("math", 2);
    const domain2 = makeDomain("logic", 2);
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val * 2;
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain1, domain2],
      staged,
      [],
    );

    expect(result.scores.length).toBe(2);
    expect(result.scores[0]!.domain).toBe("math");
    expect(result.scores[1]!.domain).toBe("logic");
  });

  test("empty domains returns empty results", async () => {
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 10, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };
    const result = await evaluateAgent(
      agentId("test"),
      async () => "ok",
      [],
      staged,
      [],
    );
    expect(result.scores).toEqual([]);
    expect(result.feedback).toEqual([]);
  });

  test("handles runTask throwing exceptions", async () => {
    const domain = makeDomain("crash", 3);
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 3, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const runTask = async () => {
      throw new Error("agent crashed");
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    // All cases should get defaultScore (0)
    expect(result.scores[0]!.trainScore).toBe(0);
  });

  test("partial success gives fractional score", async () => {
    const domain: DomainConfig = {
      name: "mixed",
      trainCases: [
        { id: "1", input: { value: 1 }, expected: { answer: 2 } },
        { id: "2", input: { value: 2 }, expected: { answer: 4 } },
        { id: "3", input: { value: 3 }, expected: { answer: 6 } },
        { id: "4", input: { value: 4 }, expected: { answer: 8 } },
      ],
      testCases: [],
      scorer: async (output: unknown, expected) => {
        const exp = (expected.expected as { answer: number }).answer;
        return output === exp ? 1 : 0;
      },
    };
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 4, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    // Only correct for even values
    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val % 2 === 0 ? val * 2 : "wrong";
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    // 2 out of 4 correct = 0.5
    expect(result.scores[0]!.trainScore).toBe(0.5);
  });

  test("passCondition 'any' passes with at least one success", async () => {
    const domain = makeDomain("math", 5);
    const staged: StagedEvalConfig = {
      stages: [
        { taskCount: 3, passThreshold: 0, passCondition: "any" },
        { taskCount: 5, passThreshold: 0, passCondition: "any" },
      ],
      defaultScore: 0,
    };

    let callCount = 0;
    const runTask = async (evalCase: { input: unknown }) => {
      callCount++;
      const val = (evalCase.input as { value: number }).value;
      // Only first case correct
      return val === 0 ? val * 2 : "wrong";
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    // Stage 1 should pass on the first fixed subset, then stage 2 evaluates all 5.
    expect(callCount).toBe(5);
    expect(result.scores[0]!.trainScore).toBeCloseTo(0.2);
  });

  test("three-tier staged evaluation", async () => {
    const domain = makeDomain("code", 20);
    const staged: StagedEvalConfig = {
      stages: [
        { taskCount: 5, passThreshold: 0, passCondition: "any" },
        { taskCount: 10, passThreshold: 0.3, passCondition: "rate" },
        { taskCount: 20, passThreshold: 0.5, passCondition: "rate" },
      ],
      defaultScore: 0,
    };

    // Agent gets all correct
    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val * 2;
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    // All stages pass, full score
    expect(result.scores[0]!.trainScore).toBe(1);
  });

  test("empty train cases gives zero score", async () => {
    const domain: DomainConfig = {
      name: "empty",
      trainCases: [],
      testCases: [],
      scorer: async () => 1,
    };
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 10, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const result = await evaluateAgent(
      agentId("test"),
      async () => "ok",
      [domain],
      staged,
      [],
    );

    expect(result.scores[0]!.trainScore).toBe(0);
  });

  test("validation score null when no validation cases", async () => {
    const domain = makeDomain("math", 2);
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val * 2;
    };

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    expect(result.scores[0]!.validationScore).toBeNull();
  });

  test("test score is always null during evolution", async () => {
    const domain = makeDomain("math", 2);
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const result = await evaluateAgent(
      agentId("test"),
      async (ec: { input: unknown }) => {
        const val = (ec.input as { value: number }).value;
        return val * 2;
      },
      [domain],
      staged,
      [],
    );

    expect(result.scores[0]!.testScore).toBeNull();
  });

  test("archiveRankRequired skips remaining stages when agent not in top-N", async () => {
    const domain = makeDomain("math", 10);
    const staged: StagedEvalConfig = {
      stages: [
        { taskCount: 3, passThreshold: 0, passCondition: "any" },
        { taskCount: 10, passThreshold: 0, passCondition: "any", archiveRankRequired: 1 },
      ],
      defaultScore: 0,
    };

    // Agent gets first few right (passes stage 1) but current average is low
    let callIdx = 0;
    const runTask = async (evalCase: { input: unknown }) => {
      callIdx++;
      // Return correct for first call so stage 1 "any" passes
      if (callIdx <= 1) {
        const val = (evalCase.input as { value: number }).value;
        return val * 2;
      }
      return "wrong";
    };

    // Provide archive entries that score higher, so our agent is ranked lower
    const archiveEntries = [
      {
        id: agentId("top1"),
        parentId: null,
        generation: 0,
        repoSnapshot: "/tmp/top1",
        scores: [{ domain: "math", trainScore: 0.9, validationScore: null, testScore: null }],
        compiledChildrenCount: 0,
        validParent: true,
        metadata: { createdAt: new Date(), diffFromParent: "" },
      },
      {
        id: agentId("top2"),
        parentId: null,
        generation: 0,
        repoSnapshot: "/tmp/top2",
        scores: [{ domain: "math", trainScore: 0.8, validationScore: null, testScore: null }],
        compiledChildrenCount: 0,
        validParent: true,
        metadata: { createdAt: new Date(), diffFromParent: "" },
      },
    ];

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      archiveEntries,
    );

    // Stage 1 passes (1 correct out of 3), then stage 2 archiveRankRequired
    // check fails because our agent's score is below the archive top-1.
    // Remaining cases get defaultScore (0), so final = 1 correct / 10 total = 0.1
    expect(result.scores[0]!.trainScore).toBeGreaterThan(0);
    expect(result.scores[0]!.trainScore).toBeLessThan(0.5);
  });

  test("archiveRankRequired proceeds when agent is in top-N", async () => {
    const domain = makeDomain("math", 10);
    const staged: StagedEvalConfig = {
      stages: [
        { taskCount: 3, passThreshold: 0, passCondition: "any" },
        { taskCount: 10, passThreshold: 0, passCondition: "any", archiveRankRequired: 5 },
      ],
      defaultScore: 0,
    };

    // Agent that always succeeds — it'll be top-ranked
    const runTask = async (evalCase: { input: unknown }) => {
      const val = (evalCase.input as { value: number }).value;
      return val * 2;
    };

    // Archive with lower scores
    const archiveEntries = [
      {
        id: agentId("low1"),
        parentId: null,
        generation: 0,
        repoSnapshot: "/tmp/low1",
        scores: [{ domain: "math", trainScore: 0.1, validationScore: null, testScore: null }],
        compiledChildrenCount: 0,
        validParent: true,
        metadata: { createdAt: new Date(), diffFromParent: "" },
      },
    ];

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      archiveEntries,
    );

    // Should pass archive rank check and evaluate all cases
    expect(result.scores[0]!.trainScore).toBe(1);
  });

  test("scorer returning fractional scores", async () => {
    const domain: DomainConfig = {
      name: "fuzzy",
      trainCases: [
        { id: "1", input: "hello", expected: "hello world" },
        { id: "2", input: "test", expected: "test case" },
      ],
      testCases: [],
      scorer: async (output: unknown, expected) => {
        // Similarity-based scorer returning 0-1
        const out = String(output);
        const exp = String(expected.expected);
        return out.includes(exp.split(" ")[0]!) ? 0.7 : 0;
      },
    };
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const runTask = async (evalCase: { input: unknown }) => String(evalCase.input);

    const result = await evaluateAgent(
      agentId("test"),
      runTask,
      [domain],
      staged,
      [],
    );

    // Both cases should get 0.7
    expect(result.scores[0]!.trainScore).toBe(0.7);
  });

  test("evaluation uses fixed training case order across runs", async () => {
    const domain = makeDomain("ordered", 4);
    const staged: StagedEvalConfig = {
      stages: [{ taskCount: 2, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    };

    const seen: string[] = [];
    const runTask = async (evalCase: { id: string }) => {
      seen.push(evalCase.id);
      return "wrong";
    };

    await evaluateAgent(agentId("ordered"), runTask, [domain], staged, []);
    expect(seen).toEqual(["case-0", "case-1"]);
  });

  test("archive rank checks honor requested training score mode", async () => {
    const domain: DomainConfig = {
      name: "ranked",
      trainCases: Array.from({ length: 4 }, (_, i) => ({
        id: `case-${i}`,
        input: { value: i },
        expected: { answer: i },
      })),
      testCases: [],
      scorer: async (output: unknown) => Number(output),
    };
    const staged: StagedEvalConfig = {
      stages: [
        { taskCount: 1, passThreshold: 0, passCondition: "any" },
        { taskCount: 4, passThreshold: 0, passCondition: "any" },
      ],
      defaultScore: 0,
    };

    const archive = [
      {
        id: agentId("strong-train"),
        parentId: null,
        generation: 0,
        repoSnapshot: "/tmp/strong-train",
        scores: [{ domain: "ranked", trainScore: 0.4, validationScore: 0.9, testScore: null }],
        compiledChildrenCount: 0,
        validParent: true,
        metadata: { createdAt: new Date(), diffFromParent: "" },
      },
      {
        id: agentId("strong-val"),
        parentId: null,
        generation: 0,
        repoSnapshot: "/tmp/strong-val",
        scores: [{ domain: "ranked", trainScore: 0.3, validationScore: 0.1, testScore: null }],
        compiledChildrenCount: 0,
        validParent: true,
        metadata: { createdAt: new Date(), diffFromParent: "" },
      },
    ];

    let trainingCalls = 0;
    const runTrainingTask = async () => {
      trainingCalls++;
      return 0.5;
    };

    await evaluateAgent(
      agentId("ranked-agent"),
      runTrainingTask,
      [domain],
      {
        stages: [
          staged.stages[0]!,
          { ...staged.stages[1]!, archiveRankRequired: 1 },
        ],
        defaultScore: 0,
      },
      archive,
      "training",
    );

    expect(trainingCalls).toBe(4);

    let validationCalls = 0;
    const runValidationTask = async () => {
      validationCalls++;
      return 0.5;
    };

    await evaluateAgent(
      agentId("ranked-agent"),
      runValidationTask,
      [domain],
      {
        stages: [
          staged.stages[0]!,
          { ...staged.stages[1]!, archiveRankRequired: 1 },
        ],
        defaultScore: 0,
      },
      archive,
      "validation",
    );

    expect(validationCalls).toBe(1);
  });
});
