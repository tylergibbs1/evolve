import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceLimits, Sandbox, SandboxResult, Tools } from "../types.ts";
import { ScopedBashTool } from "../tools/bash.ts";
import { ScopedEditorTool, executeEditorCommand } from "../tools/editor.ts";
import { ALL_TOOL_DEFINITIONS } from "../tools/interface.ts";
import type { LLMProvider } from "../llm/provider.ts";
import { runToolLoop } from "../llm/provider.ts";
import type { LLMRoleConfig } from "../types.ts";

/**
 * L1 Sandbox: Bun subprocess with resource limits.
 *
 * Each agent variant runs in a cloned directory. The bash and editor tools
 * are scoped to that directory. Network is blocked except for LLM calls.
 */
export class SubprocessSandbox implements Sandbox {
  constructor(
    private provider: LLMProvider,
    private roleConfig: LLMRoleConfig,
  ) {}

  async run(
    repoPath: string,
    entrypoint: string,
    _tools: Tools,
    limits: ResourceLimits,
  ): Promise<SandboxResult> {
    // Clone the repo to an isolated temp directory
    const workDir = await mkdtemp(join(tmpdir(), "evolve-sandbox-"));
    await cp(repoPath, workDir, { recursive: true });
    // Ensure .tmp dir exists for bash tool
    await Bun.write(join(workDir, ".tmp", ".keep"), "");

    const bash = new ScopedBashTool(workDir, limits.maxWallTimeSeconds * 1000);
    const editor = new ScopedEditorTool(workDir);

    let llmCallsUsed = 0;
    const startTime = Date.now();

    const executeTool = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<string> => {
      try {
        if (name === "bash") {
          const result = await bash.run(input["command"] as string);
          return result.exitCode === 0
            ? result.stdout
            : `Exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        if (name === "editor") {
          return await executeEditorCommand(editor, input);
        }
        return `Unknown tool: ${name}`;
      } catch (err) {
        return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    try {
      // Read the entrypoint to get the agent's instructions
      const entrypointContent = await Bun.file(
        join(workDir, entrypoint),
      ).text();

      const result = await runToolLoop(
        {
          chat: async (messages, config, tools) => {
            if (llmCallsUsed >= limits.maxLLMCalls) {
              return {
                content: "LLM call limit reached. Wrapping up.",
                toolCalls: [],
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            }
            llmCallsUsed++;
            return this.provider.chat(messages, config, tools);
          },
        },
        this.roleConfig,
        "You are an agent. Execute the task defined in the entrypoint file.",
        [
          {
            role: "user",
            content: `Entrypoint file (${entrypoint}):\n\`\`\`\n${entrypointContent}\n\`\`\`\n\nExecute the task.`,
          },
        ],
        ALL_TOOL_DEFINITIONS,
        executeTool,
        limits.maxLLMCalls,
      );

      const wallTimeSeconds = (Date.now() - startTime) / 1000;

      return {
        success: true,
        output: result.finalResponse,
        exitCode: 0,
        wallTimeSeconds,
        llmCallsUsed,
      };
    } catch (err) {
      const wallTimeSeconds = (Date.now() - startTime) / 1000;
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        wallTimeSeconds,
        llmCallsUsed,
      };
    } finally {
      // Clean up temp directory
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
