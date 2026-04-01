import { test, expect, describe, afterEach } from "bun:test";
import { rm, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "./archive.ts";
import { agentId } from "./types.ts";
import type { DomainScore } from "./types.ts";

let testDir: string;
let archive: Archive;

async function setup(): Promise<void> {
  testDir = await mkdtemp(join(tmpdir(), "evolve-test-"));
  // Create a dummy agent repo to snapshot
  const dummyRepo = join(testDir, "dummy-agent");
  await mkdir(dummyRepo, { recursive: true });
  await Bun.write(join(dummyRepo, "task.ts"), "export default {}");
  archive = new Archive(testDir);
}

async function cleanup(): Promise<void> {
  archive.close();
  await rm(testDir, { recursive: true, force: true });
}

describe("Archive", () => {
  afterEach(cleanup);

  test("starts empty", async () => {
    await setup();
    expect(archive.size()).toBe(0);
    expect(archive.entries()).toEqual([]);
  });

  test("add and retrieve an agent", async () => {
    await setup();
    const id = agentId("test-agent");
    const dummyRepo = join(testDir, "dummy-agent");
    const scores: DomainScore[] = [
      { domain: "coding", trainScore: 0.5, validationScore: null, testScore: null },
    ];

    await archive.add(id, null, 0, dummyRepo, scores, "");

    expect(archive.size()).toBe(1);
    const entry = archive.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(agentId("test-agent"));
    expect(entry!.parentId).toBeNull();
    expect(entry!.generation).toBe(0);
    expect(entry!.scores[0]!.trainScore).toBe(0.5);
  });

  test("tracks parent-child relationships", async () => {
    await setup();
    const parentId = agentId("parent");
    const childId = agentId("child");
    const dummyRepo = join(testDir, "dummy-agent");
    const scores: DomainScore[] = [
      { domain: "test", trainScore: 0.5, validationScore: null, testScore: null },
    ];

    await archive.add(parentId, null, 0, dummyRepo, scores, "");
    await archive.add(childId, parentId, 1, dummyRepo, [
      { domain: "test", trainScore: 0.7, validationScore: null, testScore: null },
    ], "diff content");

    const child = archive.get(childId);
    expect(child!.parentId).toBe(agentId("parent"));
    expect(child!.generation).toBe(1);
  });

  test("incrementChildCount", async () => {
    await setup();
    const id = agentId("parent");
    const dummyRepo = join(testDir, "dummy-agent");
    await archive.add(id, null, 0, dummyRepo, [], "");

    expect(archive.get(id)!.compiledChildrenCount).toBe(0);
    archive.incrementChildCount(id);
    expect(archive.get(id)!.compiledChildrenCount).toBe(1);
    archive.incrementChildCount(id);
    expect(archive.get(id)!.compiledChildrenCount).toBe(2);
  });

  test("topK returns agents sorted by score", async () => {
    await setup();
    const dummyRepo = join(testDir, "dummy-agent");

    await archive.add(agentId("low"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.2, validationScore: null, testScore: null },
    ], "");
    await archive.add(agentId("mid"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.5, validationScore: null, testScore: null },
    ], "");
    await archive.add(agentId("high"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.9, validationScore: null, testScore: null },
    ], "");

    const top2 = archive.topK(2);
    expect(top2.length).toBe(2);
    expect(top2[0]!.id).toBe(agentId("high"));
    expect(top2[1]!.id).toBe(agentId("mid"));
  });

  test("summary provides correct aggregates", async () => {
    await setup();
    const dummyRepo = join(testDir, "dummy-agent");

    await archive.add(agentId("a"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.3, validationScore: null, testScore: null },
    ], "");
    await archive.add(agentId("b"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.7, validationScore: null, testScore: null },
    ], "");

    const summary = archive.summary();
    expect(summary.totalAgents).toBe(2);
    expect(summary.bestScore).toBe(0.7);
    expect(summary.averageScore).toBe(0.5);
    expect(summary.topAgents.length).toBe(2);
  });

  test("topK and summary honor training score mode", async () => {
    await setup();
    const dummyRepo = join(testDir, "dummy-agent");

    await archive.add(agentId("train-best"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.9, validationScore: 0.2, testScore: null },
    ], "");
    await archive.add(agentId("val-best"), null, 0, dummyRepo, [
      { domain: "test", trainScore: 0.1, validationScore: 0.95, testScore: null },
    ], "");

    const top = archive.topK(1, "training");
    const summary = archive.summary("training");

    expect(top[0]!.id).toBe(agentId("train-best"));
    expect(summary.bestScore).toBe(0.9);
  });
});
