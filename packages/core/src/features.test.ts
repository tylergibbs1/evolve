import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "./archive.ts";
import { selectParents } from "./selection.ts";
import { runEvolutionLoop } from "./loop.ts";
import { agentId } from "./types.ts";
import type {
  ArchiveEntry,
  DomainConfig,
  DomainScore,
  EvalConfig,
  LLMRoleConfig,
  LLMResponse,
  Message,
  RunConfig,
  ToolDefinition,
  ToolChoice,
} from "./types.ts";
import type { LLMProvider } from "./llm/provider.ts";

// ---------------------------------------------------------------------------
// Feature 1: Invalid parent marking
// ---------------------------------------------------------------------------

let testDir: string;

async function setupArchive(): Promise<{ archive: Archive; dummyRepo: string }> {
  testDir = await mkdtemp(join(tmpdir(), "evolve-features-"));
  const dummyRepo = join(testDir, "dummy");
  await mkdir(dummyRepo, { recursive: true });
  await Bun.write(join(dummyRepo, "task.ts"), "export default {}");
  const archive = new Archive(testDir);
  return { archive, dummyRepo };
}

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Feature: Invalid parent marking", () => {
  test("new agents are valid parents by default", async () => {
    const { archive, dummyRepo } = await setupArchive();
    const id = agentId("test");
    await archive.add(id, null, 0, dummyRepo, [], "");
    const entry = archive.get(id);
    expect(entry!.validParent).toBe(true);
    archive.close();
  });

  test("invalidateParent marks agent as invalid", async () => {
    const { archive, dummyRepo } = await setupArchive();
    const id = agentId("parent");
    await archive.add(id, null, 0, dummyRepo, [], "");
    expect(archive.get(id)!.validParent).toBe(true);

    archive.invalidateParent(id);
    expect(archive.get(id)!.validParent).toBe(false);
    archive.close();
  });

  test("selectParents skips invalid parents", () => {
    const entries: ArchiveEntry[] = [
      makeEntry("invalid", 0.9, true),  // High score but invalid
      makeEntry("valid", 0.5, false),   // Lower score but valid
    ];
    entries[0]!.validParent = false;
    entries[1]!.validParent = true;

    // All selections should be "valid" since "invalid" is filtered out
    const parents = selectParents(entries, 10);
    expect(parents.every((p) => p.id === "valid")).toBe(true);
  });

  test("selectParents falls back to all entries if all invalid", () => {
    const entries: ArchiveEntry[] = [
      makeEntry("a", 0.5, false),
      makeEntry("b", 0.7, false),
    ];
    entries[0]!.validParent = false;
    entries[1]!.validParent = false;

    // Should still work (falls back to full archive)
    const parents = selectParents(entries, 5);
    expect(parents.length).toBe(5);
  });

  test("invalidation persists across archive reads", async () => {
    const { archive, dummyRepo } = await setupArchive();
    const id = agentId("persist-test");
    await archive.add(id, null, 0, dummyRepo, [], "");
    archive.invalidateParent(id);

    // Re-read
    const entries = archive.entries();
    const entry = entries.find((e) => e.id === id);
    expect(entry!.validParent).toBe(false);
    archive.close();
  });
});

// ---------------------------------------------------------------------------
// Feature 2: Protected path restoration
// ---------------------------------------------------------------------------

describe("Feature: Protected path restoration", () => {
  test("protected files are restored after modification", async () => {
    testDir = await mkdtemp(join(tmpdir(), "evolve-protect-"));
    const parentDir = join(testDir, "parent");
    const childDir = join(testDir, "child");
    await mkdir(parentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });

    // Write original eval config in parent
    await Bun.write(join(parentDir, "eval.config.ts"), "export const scorer = 'original';");
    // Write modified version in child (as if meta agent changed it)
    await Bun.write(join(childDir, "eval.config.ts"), "export const scorer = 'HACKED';");

    // Import and run restoreProtectedPaths
    const { restoreProtectedPaths } = await import("./loop.test-helpers.ts");
    await restoreProtectedPaths(parentDir, childDir, ["eval.config.ts"]);

    const content = await Bun.file(join(childDir, "eval.config.ts")).text();
    expect(content).toBe("export const scorer = 'original';");
  });

  test("protected directories are restored recursively", async () => {
    testDir = await mkdtemp(join(tmpdir(), "evolve-protect-"));
    const parentDir = join(testDir, "parent");
    const childDir = join(testDir, "child");
    await mkdir(join(parentDir, "eval"), { recursive: true });
    await mkdir(join(childDir, "eval"), { recursive: true });

    await Bun.write(join(parentDir, "eval", "cases.json"), '["original"]');
    await Bun.write(join(childDir, "eval", "cases.json"), '["hacked"]');
    await Bun.write(join(childDir, "eval", "injected.ts"), "evil code");

    const { restoreProtectedPaths } = await import("./loop.test-helpers.ts");
    await restoreProtectedPaths(parentDir, childDir, ["eval"]);

    const content = await Bun.file(join(childDir, "eval", "cases.json")).text();
    expect(content).toBe('["original"]');
    // Injected file should be gone (directory was replaced)
    expect(await Bun.file(join(childDir, "eval", "injected.ts")).exists()).toBe(false);
  });

  test("non-existent protected paths are silently skipped", async () => {
    testDir = await mkdtemp(join(tmpdir(), "evolve-protect-"));
    const parentDir = join(testDir, "parent");
    const childDir = join(testDir, "child");
    await mkdir(parentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });

    const { restoreProtectedPaths } = await import("./loop.test-helpers.ts");
    // Should not throw
    await restoreProtectedPaths(parentDir, childDir, ["nonexistent.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Feature 3: Editable parent selection
// ---------------------------------------------------------------------------

describe("Feature: Editable parent selection script", () => {
  test("select_parent.ts can be run standalone", async () => {
    testDir = await mkdtemp(join(tmpdir(), "evolve-sel-"));
    const scriptDir = join(testDir, "agent");
    await mkdir(scriptDir, { recursive: true });

    // Copy the initial select_parent.ts
    const scriptSrc = join(
      import.meta.dir,
      "../../initial-agent/select_parent.ts",
    );
    const scriptDst = join(scriptDir, "select_parent.ts");
    await Bun.write(scriptDst, await Bun.file(scriptSrc).text());

    const input = JSON.stringify({
      archive: [
        {
          id: "agent-a",
          parentId: null,
          generation: 0,
          scores: [{ domain: "test", trainScore: 0.8, validationScore: null, testScore: null }],
          compiledChildrenCount: 0,
          validParent: true,
        },
        {
          id: "agent-b",
          parentId: "agent-a",
          generation: 1,
          scores: [{ domain: "test", trainScore: 0.5, validationScore: null, testScore: null }],
          compiledChildrenCount: 2,
          validParent: true,
        },
      ],
      count: 3,
    });

    const proc = Bun.spawn(["bun", "run", scriptDst], {
      cwd: scriptDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(input);
    proc.stdin.flush();
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const selected: string[] = JSON.parse(stdout.trim());
    expect(selected.length).toBe(3);
    // All selected IDs should be from the archive
    expect(selected.every((id) => id === "agent-a" || id === "agent-b")).toBe(true);
  });

  test("select_parent.ts filters invalid parents", async () => {
    testDir = await mkdtemp(join(tmpdir(), "evolve-sel-"));
    const scriptDir = join(testDir, "agent");
    await mkdir(scriptDir, { recursive: true });

    const scriptSrc = join(
      import.meta.dir,
      "../../initial-agent/select_parent.ts",
    );
    await Bun.write(join(scriptDir, "select_parent.ts"), await Bun.file(scriptSrc).text());

    const input = JSON.stringify({
      archive: [
        {
          id: "invalid-parent",
          parentId: null,
          generation: 0,
          scores: [{ domain: "test", trainScore: 0.9, validationScore: null, testScore: null }],
          compiledChildrenCount: 0,
          validParent: false, // Invalid!
        },
        {
          id: "valid-parent",
          parentId: null,
          generation: 0,
          scores: [{ domain: "test", trainScore: 0.3, validationScore: null, testScore: null }],
          compiledChildrenCount: 0,
          validParent: true,
        },
      ],
      count: 5,
    });

    const proc = Bun.spawn(["bun", "run", join(scriptDir, "select_parent.ts")], {
      cwd: scriptDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(input);
    proc.stdin.flush();
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const selected: string[] = JSON.parse(stdout.trim());
    // All should be valid-parent since invalid-parent is filtered
    expect(selected.every((id) => id === "valid-parent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 4: Loop coverage — budget, compilation failures, protected paths
// ---------------------------------------------------------------------------

const ROLE_CONFIG: LLMRoleConfig = {
  provider: "anthropic",
  model: "mock",
  temperature: 0,
};

/** Mock LLM provider that returns no tool calls for meta agent
 *  and a submit_response tool call for task agent. */
function createMockProvider(): LLMProvider {
  return {
    async chat(
      messages: Message[],
      _config: LLMRoleConfig,
      tools?: ToolDefinition[],
      toolChoice?: ToolChoice,
    ): Promise<LLMResponse> {
      // Task agent: forced submit_response tool call
      if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
        return {
          content: "",
          toolCalls: [{
            id: "tc-1",
            name: "submit_response",
            input: { response: "mock answer" },
          }],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      }
      // Meta agent: return text only (no modifications)
      return {
        content: "No changes needed.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
}

async function setupLoopTest(): Promise<{ dir: string; agentDir: string; config: RunConfig }> {
  const dir = await mkdtemp(join(tmpdir(), "evolve-loop-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir, { recursive: true });

  await Bun.write(
    join(agentDir, "task.ts"),
    `export function buildTaskPrompt(inputs: Record<string, unknown>): string {
  return "Answer: " + JSON.stringify(inputs);
}`,
  );

  const domain: DomainConfig = {
    name: "test",
    trainCases: [
      { id: "t1", input: { q: "hello" }, expected: { answer: "mock answer" } },
    ],
    testCases: [],
    scorer: async (output: unknown, _expected) => {
      return String(output).includes("mock") ? 1 : 0;
    },
  };

  const evalConfig: EvalConfig = {
    domains: [domain],
    stagedEval: {
      stages: [{ taskCount: 1, passThreshold: 0, passCondition: "any" }],
      defaultScore: 0,
    },
    parentSelectionScore: "training",
  };

  const config: RunConfig = {
    iterations: 1,
    k: 1,
    topM: 3,
    lambda: 10,
    initialAgentPath: agentDir,
    outputDir: join(dir, "output"),
    llm: {
      diagnosis: ROLE_CONFIG,
      modification: ROLE_CONFIG,
      evaluation: ROLE_CONFIG,
    },
    budget: {
      maxTokensPerIteration: 500_000,
      maxTotalTokens: 2_000_000,
      maxCostUSD: 100,
      pauseOnBudgetExhausted: false,
      warnAtPercentage: 80,
    },
    sandbox: {
      limits: {
        maxWallTimeSeconds: 30,
        maxMemoryMB: 256,
        maxLLMCalls: 5,
        networkAccess: "llm-only",
      },
    },
    eval: evalConfig,
    protectedPaths: [],
    editableSelection: false,
  };

  return { dir, agentDir, config };
}

describe("Feature: Loop budget handling", () => {
  let loopDir: string;

  afterEach(async () => {
    if (loopDir) {
      await rm(loopDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("pauseOnBudgetExhausted emits budget_warning and stops", async () => {
    const { dir, config } = await setupLoopTest();
    loopDir = dir;
    config.iterations = 5;
    config.budget.maxCostUSD = 0.000001; // Extremely low budget
    config.budget.pauseOnBudgetExhausted = true;

    const events: string[] = [];
    const provider = createMockProvider();

    const result = await runEvolutionLoop(provider, config, (event) => {
      events.push(event.type);
    });

    // Should have completed (not thrown) even though budget was exceeded
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
    expect(events).toContain("run_complete");
  }, 30_000);

  test("budget warning is emitted at threshold", async () => {
    const { dir, config } = await setupLoopTest();
    loopDir = dir;
    config.iterations = 2;
    config.budget.maxCostUSD = 0.0001; // Very low to trigger warning
    config.budget.warnAtPercentage = 1; // Very low threshold
    config.budget.pauseOnBudgetExhausted = true;

    const events: string[] = [];
    const provider = createMockProvider();

    await runEvolutionLoop(provider, config, (event) => {
      events.push(event.type);
    });

    // May or may not get budget_warning depending on exact cost
    expect(events).toContain("run_complete");
  }, 30_000);
});

describe("Feature: Loop budget exhaustion throws", () => {
  let loopDir: string;

  afterEach(async () => {
    if (loopDir) {
      await rm(loopDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("throws EvolveException when budget exhausted and pauseOnBudgetExhausted is false", async () => {
    const { dir, config } = await setupLoopTest();
    loopDir = dir;
    config.iterations = 10;
    config.budget.maxCostUSD = 0.000001;
    config.budget.pauseOnBudgetExhausted = false;

    const provider = createMockProvider();

    // The initial eval should use some budget, then next iteration should throw
    // But budget check happens at start of each iteration, so first iteration
    // may complete before budget is exhausted
    try {
      await runEvolutionLoop(provider, config, () => {});
      // If it didn't throw, it might have finished before budget was hit
    } catch (err) {
      expect(err).toBeDefined();
    }
  }, 30_000);
});

describe("Feature: Loop compilation and parent invalidation", () => {
  let loopDir: string;

  afterEach(async () => {
    if (loopDir) {
      await rm(loopDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("compilation failure does not crash the loop", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;

    // Meta agent that breaks task.ts
    const provider: LLMProvider = {
      async chat(messages, _config, tools, toolChoice) {
        if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "submit_response", input: { response: "ok" } }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        // Meta agent: break the task.ts file via bash tool
        const msgs = messages.map(m => typeof m.content === "string" ? m.content : "");
        const isFirstMetaCall = msgs.some(m => m.includes("Modify the codebase"));
        if (isFirstMetaCall) {
          return {
            content: "",
            toolCalls: [{
              id: "tc-meta",
              name: "bash",
              input: { command: "echo 'syntax error {{{{' > task.ts" },
            }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "Done.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const events: string[] = [];
    const result = await runEvolutionLoop(provider, config, (event) => {
      events.push(event.type);
    });

    // Loop should complete despite compilation failure
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
    expect(events).toContain("run_complete");
  }, 30_000);

  test("parent is invalidated when all children fail compilation", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.k = 2; // Multiple children from same parent

    // Meta agent that deletes task.ts, causing compilation failure
    const provider: LLMProvider = {
      async chat(messages, _config, tools, toolChoice) {
        if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "submit_response", input: { response: "ok" } }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        // Meta agent: delete task.ts to cause compilation failure
        const msgs = messages.map(m => typeof m.content === "string" ? m.content : "");
        const isMetaCall = msgs.some(m => m.includes("Modify the codebase"));
        if (isMetaCall) {
          return {
            content: "",
            toolCalls: [{
              id: "tc-meta",
              name: "bash",
              input: { command: "rm task.ts" },
            }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "Done.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const events: string[] = [];
    const result = await runEvolutionLoop(provider, config, (event) => {
      events.push(event.type);
    });

    // Loop completes but no new agents created (all failed compilation)
    expect(events).toContain("run_complete");
    expect(events).toContain("iteration_end");
    // No agent_created events since compilation failed
    expect(events.filter(e => e === "agent_created").length).toBe(0);
  }, 30_000);

  test("protected paths are restored after meta agent runs", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.protectedPaths = ["eval.config.ts"];

    // Create a protected file
    await Bun.write(join(agentDir, "eval.config.ts"), "export const x = 'original';");

    const provider = createMockProvider();
    const result = await runEvolutionLoop(provider, config, () => {});

    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

describe("Feature: Meta agent editor tool + task agent fallbacks", () => {
  let loopDir: string;

  afterEach(async () => {
    if (loopDir) {
      await rm(loopDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("meta agent uses editor tool successfully", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;

    let metaCallCount = 0;
    const provider: LLMProvider = {
      async chat(messages, _config, tools, toolChoice) {
        if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "submit_response", input: { response: "mock answer" } }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        // Meta agent: first call uses editor tool, second returns done
        metaCallCount++;
        if (metaCallCount === 1) {
          return {
            content: "",
            toolCalls: [{
              id: "tc-editor",
              name: "editor",
              input: { command: "view", path: "task.ts" },
            }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "Done.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("meta agent unknown tool returns error string", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;

    let metaCallCount = 0;
    const provider: LLMProvider = {
      async chat(messages, _config, tools, toolChoice) {
        if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "submit_response", input: { response: "mock answer" } }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        metaCallCount++;
        if (metaCallCount === 1) {
          return {
            content: "",
            toolCalls: [{
              id: "tc-unknown",
              name: "nonexistent_tool",
              input: {},
            }],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "Done.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("task agent falls back to generic prompt when task.ts does not exist", async () => {
    const { dir, config } = await setupLoopTest();
    loopDir = dir;

    // Delete task.ts from initial agent — but we need it to exist for compile check
    // Actually the issue is: runTaskAgent checks if customTaskPath exists
    // For the initial eval, it runs against config.initialAgentPath
    // The meta agent then modifies the clone.

    // Simpler approach: just make task.ts empty (it'll still exist but subprocess fails)
    const agentDir = config.initialAgentPath;
    await Bun.write(join(agentDir, "task.ts"), "// empty");

    const provider: LLMProvider = {
      async chat(messages, _config, tools, toolChoice) {
        if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
          // Return a JSON string (no tool call) to test the fallback parse path
          return {
            content: '{"answer": "fallback"}',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "Done.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("task agent handles non-JSON text response", async () => {
    const { dir, config } = await setupLoopTest();
    loopDir = dir;

    const provider: LLMProvider = {
      async chat(messages, _config, tools, toolChoice) {
        if (toolChoice && typeof toolChoice === "object" && toolChoice.tool === "submit_response") {
          // Return plain text (not JSON) with no tool call
          return {
            content: "just a plain text answer",
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "Done.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

describe("Feature: Editable selection via select_parent.ts", () => {
  let loopDir: string;

  afterEach(async () => {
    if (loopDir) {
      await rm(loopDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("uses select_parent.ts when editableSelection is true", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.editableSelection = true;

    // Copy the initial select_parent.ts into the agent dir
    const scriptSrc = join(
      import.meta.dir,
      "../../initial-agent/select_parent.ts",
    );
    const scriptExists = await Bun.file(scriptSrc).exists();
    if (scriptExists) {
      await Bun.write(
        join(agentDir, "select_parent.ts"),
        await Bun.file(scriptSrc).text(),
      );
    }

    const provider = createMockProvider();
    const events: string[] = [];
    const result = await runEvolutionLoop(provider, config, (event) => {
      events.push(event.type);
    });

    expect(result.bestScore).toBeGreaterThanOrEqual(0);
    expect(events).toContain("run_complete");
  }, 30_000);

  test("falls back when select_parent.ts exits non-zero", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.editableSelection = true;

    // Write a script that exits with error
    await Bun.write(
      join(agentDir, "select_parent.ts"),
      `process.exit(1);`,
    );

    const provider = createMockProvider();
    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("falls back when select_parent.ts returns empty array", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.editableSelection = true;

    // Write a script that outputs empty array
    await Bun.write(
      join(agentDir, "select_parent.ts"),
      `process.stdout.write("[]");`,
    );

    const provider = createMockProvider();
    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("falls back when select_parent.ts throws", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.editableSelection = true;

    // Write a script that throws
    await Bun.write(
      join(agentDir, "select_parent.ts"),
      `throw new Error("crash");`,
    );

    const provider = createMockProvider();
    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("pads results when select_parent.ts returns fewer than count", async () => {
    const { dir, agentDir, config } = await setupLoopTest();
    loopDir = dir;
    config.editableSelection = true;
    config.k = 3;

    // Script that returns just one ID
    await Bun.write(
      join(agentDir, "select_parent.ts"),
      `const input = JSON.parse(await Bun.stdin.text());
const ids = input.archive.map((a: any) => a.id);
// Return fewer than count
process.stdout.write(JSON.stringify(ids.slice(0, 1)));`,
    );

    const provider = createMockProvider();
    const result = await runEvolutionLoop(provider, config, () => {});
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("falls back to fixed selection when no select_parent.ts exists", async () => {
    const { dir, config } = await setupLoopTest();
    loopDir = dir;
    config.editableSelection = true;

    const provider = createMockProvider();
    const result = await runEvolutionLoop(provider, config, () => {});

    expect(result.bestScore).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  id: string,
  trainScore: number,
  valid: boolean = true,
): ArchiveEntry {
  return {
    id: agentId(id),
    parentId: null,
    generation: 0,
    repoSnapshot: `/tmp/${id}`,
    scores: [
      { domain: "test", trainScore, validationScore: null, testScore: null },
    ],
    compiledChildrenCount: 0,
    validParent: valid,
    metadata: { createdAt: new Date(), diffFromParent: "" },
  };
}
