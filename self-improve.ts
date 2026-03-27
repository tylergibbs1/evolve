#!/usr/bin/env bun
/**
 * Evolve Self-Improvement Loop
 *
 * Autoresearch-style autonomous improvement of the Evolve codebase.
 * Uses the same core pattern: propose → commit → test → keep/revert → loop.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun self-improve.ts [--tag <name>] [--max <n>]
 */

import Anthropic from "@anthropic-ai/sdk";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir;
const RESULTS_FILE = join(ROOT, "results.tsv");
const RUN_LOG = join(ROOT, "run.log");

// Parse args
const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const tag = tagIdx !== -1 ? args[tagIdx + 1]! : new Date().toISOString().slice(5, 10).replace("-", "");
const maxIdx = args.indexOf("--max");
const maxIterations = maxIdx !== -1 ? parseInt(args[maxIdx + 1]!, 10) : Infinity;

const client = new Anthropic();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sh(cmd: string, timeout = 120_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function gitHash(): Promise<string> {
  const { stdout } = await sh("git rev-parse --short=7 HEAD");
  return stdout.trim();
}

async function gitDiff(): Promise<string> {
  const { stdout } = await sh("git diff HEAD~1 --stat 2>/dev/null || echo '(no previous commit)'");
  return stdout.trim();
}

async function readSourceFiles(): Promise<string> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "output") continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const content = await Bun.file(fullPath).text();
        files.push(`--- ${relPath} ---\n${content}`);
      }
    }
  }

  await walk(join(ROOT, "packages/core/src"));
  await walk(join(ROOT, "packages/cli/src"));
  await walk(join(ROOT, "packages/initial-agent"));
  return files.join("\n\n");
}

async function readTestFiles(): Promise<string> {
  const files: string[] = [];
  async function walk(dir: string, prefix: string = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.name.endsWith(".test.ts") && !entry.name.includes("integration") && !entry.name.includes("smoke")) {
        const content = await Bun.file(fullPath).text();
        files.push(`--- ${relPath} ---\n${content}`);
      }
    }
  }
  await walk(join(ROOT, "packages/core/src"));
  return files.join("\n\n");
}

async function readResults(): Promise<string> {
  try {
    return await Bun.file(RESULTS_FILE).text();
  } catch {
    return "commit\ttests_passed\ttests_failed\ttypecheck\tstatus\tdescription\n";
  }
}

async function appendResult(line: string): Promise<void> {
  const existing = await readResults();
  await Bun.write(RESULTS_FILE, existing + line + "\n");
}

async function runTests(): Promise<{ passed: number; failed: number; output: string }> {
  const { stdout, stderr } = await sh(
    "bun test --exclude='**/integration*' --exclude='**/smoke*' 2>&1",
    180_000,
  );
  const output = stdout + stderr;

  const passMatch = output.match(/(\d+) pass/);
  const failMatch = output.match(/(\d+) fail/);
  return {
    passed: passMatch ? parseInt(passMatch[1]!, 10) : 0,
    failed: failMatch ? parseInt(failMatch[1]!, 10) : 0,
    output,
  };
}

async function runTypecheck(): Promise<{ pass: boolean; output: string }> {
  const { stdout, stderr, exitCode } = await sh("bunx tsc --noEmit 2>&1", 30_000);
  return { pass: exitCode === 0, output: stdout + stderr };
}

// ---------------------------------------------------------------------------
// LLM-driven improvement proposal
// ---------------------------------------------------------------------------

async function proposeImprovement(
  sourceCode: string,
  testCode: string,
  resultsLog: string,
  iteration: number,
): Promise<Array<{ path: string; content: string }>> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    temperature: 0.7, // some creativity for diverse proposals
    system: `You are an autonomous research agent improving a TypeScript codebase.
You propose ONE small, focused improvement per iteration. Read the source code, tests, and past results carefully.

Rules:
- ONE change per iteration. Small and focused.
- Do NOT modify test files. If tests need updating, that's a separate iteration.
- Do NOT break existing public APIs (exported types and function signatures).
- Do NOT add new dependencies.
- Typecheck (tsc --noEmit) must pass.
- All existing tests must still pass.
- Simpler is better. Don't add complexity without clear benefit.
- Read the results log to avoid repeating failed experiments.

Categories to pick from:
1. Performance — reduce allocations, batch DB ops, remove unnecessary copies
2. Correctness — edge cases, error handling, race conditions
3. Architecture — extract shared helpers, reduce duplication, simplify interfaces
4. Test coverage — add tests for uncovered paths (in a test-only commit)
5. Small features — plateau detection, cost tracking, archive export, etc.

Respond with a JSON array of file edits. Each edit has "path" (relative to project root) and "content" (full file content). Only include files you're changing.

Example response:
\`\`\`json
[
  {"path": "packages/core/src/selection.ts", "content": "...full file content..."}
]
\`\`\`

IMPORTANT: Output ONLY the JSON array. No explanation before or after.`,
    messages: [
      {
        role: "user",
        content: `Iteration ${iteration}. Propose one improvement.

## Past Results
${resultsLog}

## Source Code
${sourceCode}

## Test Code
${testCode}`,
      },
    ],
  });

  const text = response.content[0]!.type === "text" ? response.content[0]!.text : "";

  // Extract JSON array from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("LLM did not return a JSON array");
  }

  return JSON.parse(jsonMatch[0]) as Array<{ path: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== Evolve Self-Improvement Loop ===`);
  console.log(`Tag: ${tag} | Max iterations: ${maxIterations === Infinity ? "unlimited" : maxIterations}\n`);

  // Setup branch
  const { exitCode: branchExists } = await sh(`git show-ref --verify --quiet refs/heads/self-improve/${tag}`);
  if (branchExists === 0) {
    console.log(`Branch self-improve/${tag} already exists, checking out...`);
    await sh(`git checkout self-improve/${tag}`);
  } else {
    console.log(`Creating branch self-improve/${tag}...`);
    await sh(`git checkout -b self-improve/${tag}`);
  }

  // Baseline
  console.log("Running baseline...");
  const baselineTests = await runTests();
  const baselineTypecheck = await runTypecheck();
  const baselineHash = await gitHash();

  console.log(`Baseline: ${baselineTests.passed} pass, ${baselineTests.failed} fail, typecheck: ${baselineTypecheck.pass ? "pass" : "FAIL"}`);

  // Init results.tsv if needed
  const existingResults = await readResults();
  if (!existingResults.includes(baselineHash)) {
    if (existingResults.trim() === "commit\ttests_passed\ttests_failed\ttypecheck\tstatus\tdescription") {
      await appendResult(
        `${baselineHash}\t${baselineTests.passed}\t${baselineTests.failed}\t${baselineTypecheck.pass ? "pass" : "fail"}\tkeep\tbaseline`,
      );
    }
  }

  // Loop
  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n--- Iteration ${i} ---`);

    // 1. Read current state
    const sourceCode = await readSourceFiles();
    const testCode = await readTestFiles();
    const resultsLog = await readResults();

    // 2. Propose improvement
    console.log("Proposing improvement...");
    let edits: Array<{ path: string; content: string }>;
    let description: string;
    try {
      edits = await proposeImprovement(sourceCode, testCode, resultsLog, i);
      description = edits.map((e) => e.path.split("/").pop()).join(", ");
      console.log(`  Editing: ${description} (${edits.length} file(s))`);
    } catch (err) {
      console.log(`  Failed to get proposal: ${err}`);
      continue;
    }

    // 3. Apply edits
    for (const edit of edits) {
      const fullPath = join(ROOT, edit.path);
      await Bun.write(fullPath, edit.content);
    }

    // 4. Commit
    await sh(`git add -A && git commit -m "${description.replace(/"/g, '\\"')}"` );
    const commitHash = await gitHash();
    console.log(`  Committed: ${commitHash}`);

    // 5. Test
    console.log("  Running tests...");
    const testResult = await runTests();
    console.log(`  Tests: ${testResult.passed} pass, ${testResult.failed} fail`);

    // 6. Typecheck
    const typecheckResult = await runTypecheck();
    console.log(`  Typecheck: ${typecheckResult.pass ? "pass" : "FAIL"}`);

    // 7. Evaluate
    const allGood = testResult.failed === 0 && typecheckResult.pass;
    const status = allGood ? "keep" : "discard";

    // 8. Record
    await appendResult(
      `${commitHash}\t${testResult.passed}\t${testResult.failed}\t${typecheckResult.pass ? "pass" : "fail"}\t${status}\t${description}`,
    );

    // 9. Keep or revert
    if (allGood) {
      console.log(`  ✓ KEEP — ${description}`);
    } else {
      console.log(`  ✗ DISCARD — reverting`);
      if (!typecheckResult.pass) {
        console.log(`    Typecheck errors: ${typecheckResult.output.slice(0, 500)}`);
      }
      if (testResult.failed > 0) {
        console.log(`    Test failures: ${testResult.output.slice(-500)}`);
      }
      await sh("git reset --hard HEAD~1");
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  const finalResults = await readResults();
  const lines = finalResults.trim().split("\n").slice(1); // skip header
  const kept = lines.filter((l) => l.includes("\tkeep\t"));
  const discarded = lines.filter((l) => l.includes("\tdiscard\t"));
  console.log(`Total experiments: ${lines.length}`);
  console.log(`Kept: ${kept.length}`);
  console.log(`Discarded: ${discarded.length}`);
  console.log(`\nKept improvements:`);
  for (const line of kept) {
    const [hash, passed, , , , desc] = line.split("\t");
    console.log(`  ${hash} (${passed} tests) — ${desc}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
