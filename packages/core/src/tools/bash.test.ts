import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopedBashTool } from "./bash.ts";

let testDir: string;

async function setup(): Promise<string> {
  testDir = await mkdtemp(join(tmpdir(), "evolve-bash-test-"));
  await mkdir(join(testDir, ".tmp"), { recursive: true });
  return testDir;
}

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

describe("ScopedBashTool", () => {
  test("runs simple command", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("captures stderr", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("echo error >&2");
    expect(result.stderr.trim()).toBe("error");
    expect(result.exitCode).toBe(0);
  });

  test("returns non-zero exit code for failing command", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("exit 42");
    expect(result.exitCode).toBe(42);
  });

  test("runs in scoped directory", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("pwd");
    // macOS resolves /var -> /private/var, so check suffix
    expect(result.stdout.trim().endsWith(dir.split("/").pop()!)).toBe(true);
  });

  test("handles empty command", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("");
    expect(result.exitCode).toBe(0);
  });

  test("handles command not found", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("nonexistentcommand12345");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });

  test("can create and read files within repo", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    await bash.run("echo 'test content' > testfile.txt");
    const result = await bash.run("cat testfile.txt");
    expect(result.stdout.trim()).toBe("test content");
  });

  test("environment is restricted", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("echo $HOME");
    expect(result.stdout.trim()).toBe(dir);
  });

  test("handles multi-line output", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("echo 'line1\nline2\nline3'");
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(3);
  });

  test("truncates large stdout", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    // Generate output longer than 100_000 chars
    const result = await bash.run("python3 -c \"print('x' * 200000)\"");
    expect(result.stdout.length).toBeLessThan(200_000);
    expect(result.stdout).toContain("truncated");
  });

  test("truncates large stderr", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("python3 -c \"import sys; sys.stderr.write('x' * 100000)\"");
    expect(result.stderr.length).toBeLessThan(100_000);
    expect(result.stderr).toContain("truncated");
  });

  test("respects timeout", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir, 1000); // 1 second timeout
    const start = Date.now();
    const result = await bash.run("sleep 30");
    const elapsed = Date.now() - start;
    // Should be killed within ~2 seconds (timeout + some slack)
    expect(elapsed).toBeLessThan(5000);
    expect(result.exitCode).not.toBe(0);
  });

  test("handles special characters in command", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("echo 'hello \"world\"' | cat");
    expect(result.stdout.trim()).toBe('hello "world"');
  });

  test("handles pipe commands", async () => {
    const dir = await setup();
    const bash = new ScopedBashTool(dir);
    const result = await bash.run("echo 'abc\ndef\nghi' | grep def");
    expect(result.stdout.trim()).toBe("def");
  });
});
