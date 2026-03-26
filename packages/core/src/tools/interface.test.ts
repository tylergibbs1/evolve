import { test, expect, describe } from "bun:test";
import {
  BASH_TOOL_DEFINITION,
  EDITOR_TOOL_DEFINITION,
  ALL_TOOL_DEFINITIONS,
} from "./interface.ts";

describe("Tool definitions", () => {
  test("BASH_TOOL_DEFINITION has correct name", () => {
    expect(BASH_TOOL_DEFINITION.name).toBe("bash");
  });

  test("BASH_TOOL_DEFINITION has description", () => {
    expect(BASH_TOOL_DEFINITION.description.length).toBeGreaterThan(10);
  });

  test("BASH_TOOL_DEFINITION requires command parameter", () => {
    const schema = BASH_TOOL_DEFINITION.inputSchema;
    expect(schema["required"]).toEqual(["command"]);
    const props = schema["properties"] as Record<string, unknown>;
    expect(props["command"]).toBeDefined();
  });

  test("EDITOR_TOOL_DEFINITION has correct name", () => {
    expect(EDITOR_TOOL_DEFINITION.name).toBe("editor");
  });

  test("EDITOR_TOOL_DEFINITION has all command enums", () => {
    const props = EDITOR_TOOL_DEFINITION.inputSchema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const commandEnum = props["command"]!["enum"] as string[];
    expect(commandEnum).toContain("view");
    expect(commandEnum).toContain("create");
    expect(commandEnum).toContain("str_replace");
    expect(commandEnum).toContain("insert");
    expect(commandEnum).toContain("undo_edit");
    expect(commandEnum.length).toBe(5);
  });

  test("EDITOR_TOOL_DEFINITION requires command and path", () => {
    const schema = EDITOR_TOOL_DEFINITION.inputSchema;
    const required = schema["required"] as string[];
    expect(required).toContain("command");
    expect(required).toContain("path");
  });

  test("ALL_TOOL_DEFINITIONS contains exactly 2 tools", () => {
    expect(ALL_TOOL_DEFINITIONS.length).toBe(2);
    expect(ALL_TOOL_DEFINITIONS[0]!.name).toBe("bash");
    expect(ALL_TOOL_DEFINITIONS[1]!.name).toBe("editor");
  });

  test("all tool definitions have valid inputSchema structure", () => {
    for (const tool of ALL_TOOL_DEFINITIONS) {
      expect(tool.inputSchema["type"]).toBe("object");
      expect(tool.inputSchema["properties"]).toBeDefined();
      expect(tool.inputSchema["required"]).toBeDefined();
    }
  });
});
