import type { ToolDefinition } from "../types.ts";

/**
 * Tool definitions matching Appendix A.1 of both papers.
 * Agents receive exactly two tools: bash and editor.
 */

export const BASH_TOOL_DEFINITION: ToolDefinition = {
  name: "bash",
  description:
    "Run a command in a bash shell. The shell session is persistent across calls. " +
    "Use this to run commands, install packages, execute scripts, and manage files. " +
    "No internet access is available except to allowed LLM API endpoints.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to run.",
      },
    },
    required: ["command"],
  },
};

export const EDITOR_TOOL_DEFINITION: ToolDefinition = {
  name: "editor",
  description:
    "A file editing tool for viewing, creating, and editing files. " +
    "Commands: 'view' (display file contents with line numbers or list directory), " +
    "'create' (create a new file), 'str_replace' (replace exact string in a file), " +
    "'insert' (insert text after a line number), 'undo_edit' (undo last edit to a file).",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["view", "create", "str_replace", "insert", "undo_edit"],
        description: "The editor command to execute.",
      },
      path: {
        type: "string",
        description: "Absolute path to the file or directory.",
      },
      file_text: {
        type: "string",
        description: "Content for 'create' command.",
      },
      old_str: {
        type: "string",
        description: "String to replace for 'str_replace' command. Must match exactly.",
      },
      new_str: {
        type: "string",
        description: "Replacement string for 'str_replace' command.",
      },
      insert_line: {
        type: "number",
        description: "Line number after which to insert text for 'insert' command.",
      },
      new_str_insert: {
        type: "string",
        description: "Text to insert for 'insert' command.",
      },
      view_range: {
        type: "array",
        items: { type: "number" },
        description: "Optional [start, end] line range for 'view' command.",
      },
    },
    required: ["command", "path"],
  },
};

export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [
  BASH_TOOL_DEFINITION,
  EDITOR_TOOL_DEFINITION,
];
