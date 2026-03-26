import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopedEditorTool, executeEditorCommand } from "./editor.ts";

let testDir: string;

async function setup(): Promise<string> {
  testDir = await mkdtemp(join(tmpdir(), "evolve-editor-test-"));
  return testDir;
}

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

describe("ScopedEditorTool", () => {
  describe("path validation", () => {
    test("rejects paths outside repo", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await expect(editor.view("/etc/passwd")).rejects.toThrow("outside the agent's repository");
    });

    test("rejects path traversal with ..", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await expect(editor.view("../../../etc/passwd")).rejects.toThrow("outside the agent's repository");
    });

    test("allows paths within repo", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "test.txt"), "hello");
      const content = await editor.view(join(dir, "test.txt"));
      expect(content).toContain("hello");
    });

    test("allows relative paths resolved within repo", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      // Relative path that resolves within repo
      await editor.create(join(dir, "sub", "..", "test.txt"), "hello");
      const content = await editor.view(join(dir, "test.txt"));
      expect(content).toContain("hello");
    });
  });

  describe("view", () => {
    test("views file with line numbers", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "test.txt"), "line1\nline2\nline3");
      const content = await editor.view(join(dir, "test.txt"));
      expect(content).toContain("1");
      expect(content).toContain("line1");
      expect(content).toContain("3");
      expect(content).toContain("line3");
    });

    test("views file with range", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "test.txt"), "a\nb\nc\nd\ne");
      const content = await editor.view(join(dir, "test.txt"), [2, 4]);
      expect(content).toContain("b");
      expect(content).toContain("c");
      expect(content).toContain("d");
      expect(content).not.toContain("\ta\n");
      expect(content).not.toContain("\te");
    });

    test("views directory listing", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file1.ts"), "");
      await editor.create(join(dir, "file2.ts"), "");
      const listing = await editor.view(dir);
      expect(listing).toContain("file1.ts");
      expect(listing).toContain("file2.ts");
    });

    test("throws for non-existent file", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await expect(editor.view(join(dir, "nope.txt"))).rejects.toThrow();
    });

    test("handles empty file", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "empty.txt"), "");
      const content = await editor.view(join(dir, "empty.txt"));
      expect(content).toBeDefined();
    });

    test("handles range beyond file length", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "short.txt"), "one\ntwo");
      const content = await editor.view(join(dir, "short.txt"), [1, 100]);
      expect(content).toContain("one");
      expect(content).toContain("two");
    });
  });

  describe("create", () => {
    test("creates new file", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "new.txt"), "content");
      const text = await Bun.file(join(dir, "new.txt")).text();
      expect(text).toBe("content");
    });

    test("throws if file already exists", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "exists.txt"), "first");
      await expect(
        editor.create(join(dir, "exists.txt"), "second"),
      ).rejects.toThrow("already exists");
    });

    test("creates file with empty content", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "empty.txt"), "");
      const text = await Bun.file(join(dir, "empty.txt")).text();
      expect(text).toBe("");
    });

    test("creates file with multi-line content", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      const content = "line1\nline2\nline3\n";
      await editor.create(join(dir, "multi.txt"), content);
      const text = await Bun.file(join(dir, "multi.txt")).text();
      expect(text).toBe(content);
    });
  });

  describe("replace", () => {
    test("replaces unique string", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "code.ts"), "const x = 1;\nconst y = 2;");
      await editor.replace(join(dir, "code.ts"), "const x = 1;", "const x = 42;");
      const text = await Bun.file(join(dir, "code.ts")).text();
      expect(text).toBe("const x = 42;\nconst y = 2;");
    });

    test("throws if old_str not found", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "hello world");
      await expect(
        editor.replace(join(dir, "file.txt"), "not here", "replaced"),
      ).rejects.toThrow("not found");
    });

    test("throws if old_str matches multiple times", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "foo bar foo");
      await expect(
        editor.replace(join(dir, "file.txt"), "foo", "baz"),
      ).rejects.toThrow("2 times");
    });

    test("saves undo state", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "original");
      await editor.replace(join(dir, "file.txt"), "original", "modified");
      await editor.undo(join(dir, "file.txt"));
      const text = await Bun.file(join(dir, "file.txt")).text();
      expect(text).toBe("original");
    });

    test("handles whitespace-sensitive replacements", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "code.ts"), "  if (x) {\n    return;\n  }");
      await editor.replace(
        join(dir, "code.ts"),
        "  if (x) {\n    return;\n  }",
        "  if (x) {\n    return true;\n  }",
      );
      const text = await Bun.file(join(dir, "code.ts")).text();
      expect(text).toContain("return true;");
    });
  });

  describe("insert", () => {
    test("inserts after specified line", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "line1\nline3");
      await editor.insert(join(dir, "file.txt"), 1, "line2");
      const text = await Bun.file(join(dir, "file.txt")).text();
      expect(text).toBe("line1\nline2\nline3");
    });

    test("inserts at beginning (line 0)", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "line2\nline3");
      await editor.insert(join(dir, "file.txt"), 0, "line1");
      const text = await Bun.file(join(dir, "file.txt")).text();
      expect(text).toBe("line1\nline2\nline3");
    });

    test("inserts beyond file length", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "line1");
      await editor.insert(join(dir, "file.txt"), 100, "appended");
      const text = await Bun.file(join(dir, "file.txt")).text();
      expect(text).toContain("appended");
    });

    test("saves undo state", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "original");
      await editor.insert(join(dir, "file.txt"), 1, "inserted");
      await editor.undo(join(dir, "file.txt"));
      const text = await Bun.file(join(dir, "file.txt")).text();
      expect(text).toBe("original");
    });
  });

  describe("undo", () => {
    test("throws when no edit to undo", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await expect(editor.undo(join(dir, "nofile.txt"))).rejects.toThrow("No edit to undo");
    });

    test("only stores last edit per file", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "v1");
      await editor.replace(join(dir, "file.txt"), "v1", "v2");
      await editor.replace(join(dir, "file.txt"), "v2", "v3");
      await editor.undo(join(dir, "file.txt"));
      const text = await Bun.file(join(dir, "file.txt")).text();
      // Undo restores to state before last edit (v2), not original (v1)
      expect(text).toBe("v2");
    });

    test("undo clears the undo entry", async () => {
      const dir = await setup();
      const editor = new ScopedEditorTool(dir);
      await editor.create(join(dir, "file.txt"), "original");
      await editor.replace(join(dir, "file.txt"), "original", "modified");
      await editor.undo(join(dir, "file.txt"));
      // Second undo should fail
      await expect(editor.undo(join(dir, "file.txt"))).rejects.toThrow("No edit to undo");
    });
  });
});

describe("executeEditorCommand", () => {
  test("dispatches view command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolve-editor-dispatch-"));
    const editor = new ScopedEditorTool(dir);
    await editor.create(join(dir, "test.txt"), "hello");
    const result = await executeEditorCommand(editor, {
      command: "view",
      path: join(dir, "test.txt"),
    });
    expect(result).toContain("hello");
    await rm(dir, { recursive: true, force: true });
  });

  test("dispatches create command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolve-editor-dispatch-"));
    const editor = new ScopedEditorTool(dir);
    const result = await executeEditorCommand(editor, {
      command: "create",
      path: join(dir, "new.txt"),
      file_text: "content",
    });
    expect(result).toContain("Created");
    await rm(dir, { recursive: true, force: true });
  });

  test("dispatches str_replace command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolve-editor-dispatch-"));
    const editor = new ScopedEditorTool(dir);
    await editor.create(join(dir, "file.txt"), "old text");
    const result = await executeEditorCommand(editor, {
      command: "str_replace",
      path: join(dir, "file.txt"),
      old_str: "old text",
      new_str: "new text",
    });
    expect(result).toContain("Replaced");
    await rm(dir, { recursive: true, force: true });
  });

  test("dispatches insert command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolve-editor-dispatch-"));
    const editor = new ScopedEditorTool(dir);
    await editor.create(join(dir, "file.txt"), "line1");
    const result = await executeEditorCommand(editor, {
      command: "insert",
      path: join(dir, "file.txt"),
      insert_line: 1,
      new_str_insert: "line2",
    });
    expect(result).toContain("Inserted");
    await rm(dir, { recursive: true, force: true });
  });

  test("dispatches undo_edit command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolve-editor-dispatch-"));
    const editor = new ScopedEditorTool(dir);
    await editor.create(join(dir, "file.txt"), "orig");
    await editor.replace(join(dir, "file.txt"), "orig", "mod");
    const result = await executeEditorCommand(editor, {
      command: "undo_edit",
      path: join(dir, "file.txt"),
    });
    expect(result).toContain("Undid");
    await rm(dir, { recursive: true, force: true });
  });

  test("returns error for unknown command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolve-editor-dispatch-"));
    const editor = new ScopedEditorTool(dir);
    const result = await executeEditorCommand(editor, {
      command: "delete_everything",
      path: join(dir),
    });
    expect(result).toContain("Unknown editor command");
    await rm(dir, { recursive: true, force: true });
  });
});
