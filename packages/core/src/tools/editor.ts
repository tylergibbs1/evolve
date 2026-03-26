import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EditorTool } from "../types.ts";

/**
 * File editor tool matching Appendix A.1 of both papers.
 *
 * Supports: view, create, str_replace, insert, undo_edit.
 * Scoped to a specific directory — cannot access files outside it.
 */
export class ScopedEditorTool implements EditorTool {
  private undoStack = new Map<string, string>();

  constructor(private repoPath: string) {}

  async view(path: string, range?: [number, number]): Promise<string> {
    const resolved = this.resolve(path);
    const fileStat = await stat(resolved);

    if (fileStat.isDirectory()) {
      const entries = await readdir(resolved);
      return entries.join("\n");
    }

    const content = await Bun.file(resolved).text();
    const lines = content.split("\n");

    if (range) {
      const [start, end] = range;
      const slice = lines.slice(start - 1, end);
      return slice
        .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
        .join("\n");
    }

    return lines
      .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
      .join("\n");
  }

  async create(path: string, content: string): Promise<void> {
    const resolved = this.resolve(path);
    const file = Bun.file(resolved);
    if (await file.exists()) {
      throw new Error(`File already exists: ${path}. Use str_replace to edit.`);
    }
    await Bun.write(resolved, content);
  }

  async replace(path: string, oldStr: string, newStr: string): Promise<void> {
    const resolved = this.resolve(path);
    const content = await Bun.file(resolved).text();

    // Save for undo
    this.undoStack.set(resolved, content);

    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `old_str not found in ${path}. Make sure it matches exactly, including whitespace.`,
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `old_str found ${occurrences} times in ${path}. It must be unique. Add more surrounding context.`,
      );
    }

    const newContent = content.replace(oldStr, newStr);
    await Bun.write(resolved, newContent);
  }

  async insert(path: string, line: number, content: string): Promise<void> {
    const resolved = this.resolve(path);
    const fileContent = await Bun.file(resolved).text();

    // Save for undo
    this.undoStack.set(resolved, fileContent);

    const lines = fileContent.split("\n");
    lines.splice(line, 0, content);
    await Bun.write(resolved, lines.join("\n"));
  }

  async undo(path: string): Promise<void> {
    const resolved = this.resolve(path);
    const previous = this.undoStack.get(resolved);
    if (!previous) {
      throw new Error(`No edit to undo for ${path}`);
    }
    await Bun.write(resolved, previous);
    this.undoStack.delete(resolved);
  }

  private resolve(path: string): string {
    const resolved = resolve(this.repoPath, path);
    if (!resolved.startsWith(this.repoPath)) {
      throw new Error(
        `Access denied: ${path} is outside the agent's repository.`,
      );
    }
    return resolved;
  }
}

/**
 * Dispatch editor tool calls from LLM tool use into the typed interface.
 */
export function executeEditorCommand(
  editor: ScopedEditorTool,
  input: Record<string, unknown>,
): Promise<string> {
  const command = input["command"] as string;
  const path = input["path"] as string;

  switch (command) {
    case "view": {
      const range = input["view_range"] as [number, number] | undefined;
      return editor.view(path, range);
    }
    case "create": {
      const fileText = input["file_text"] as string;
      return editor.create(path, fileText).then(() => `Created ${path}`);
    }
    case "str_replace": {
      const oldStr = input["old_str"] as string;
      const newStr = input["new_str"] as string;
      return editor
        .replace(path, oldStr, newStr)
        .then(() => `Replaced in ${path}`);
    }
    case "insert": {
      const line = input["insert_line"] as number;
      const text = input["new_str_insert"] as string;
      return editor.insert(path, line, text).then(() => `Inserted at ${path}:${line}`);
    }
    case "undo_edit": {
      return editor.undo(path).then(() => `Undid last edit to ${path}`);
    }
    default:
      return Promise.resolve(`Unknown editor command: ${command}`);
  }
}
