import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "./archive.ts";
import { selectParents } from "./selection.ts";
import { agentId } from "./types.ts";
import type { ArchiveEntry, DomainScore } from "./types.ts";

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
