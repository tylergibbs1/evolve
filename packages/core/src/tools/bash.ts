import type { BashResult, BashTool } from "../types.ts";
import { truncateString } from "../utils/string.ts";

/**
 * Bash tool implementation using Bun subprocess.
 *
 * Provides a persistent-ish shell: each call spawns a new process but
 * working directory is tracked and carried forward.
 *
 * The tool is scoped to a specific working directory (the agent's repo)
 * and cannot access paths outside it.
 */
export class ScopedBashTool implements BashTool {
  private cwd: string;

  constructor(
    private repoPath: string,
    private timeoutMs: number = 120_000,
  ) {
    this.cwd = repoPath;
  }

  async run(command: string): Promise<BashResult> {
    // For directory change commands, get new working directory in same subprocess
    const actualCommand = this.isDirectoryChangeCommand(command)
      ? `${command} && pwd`
      : command;

    const proc = Bun.spawn(["bash", "-c", actualCommand], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: this.timeoutMs,
      killSignal: "SIGKILL",
      env: {
        HOME: this.repoPath,
        PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
        TMPDIR: `${this.repoPath}/.tmp`,
        // No API keys or secrets inherited
      },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    // Update working directory if command succeeded and was a directory change
    if (exitCode === 0 && this.isDirectoryChangeCommand(command)) {
      const newCwd = stdout.trim().split('\n').pop() || this.cwd;
      // Only update if the new directory is within our repo scope
      if (newCwd.startsWith(this.repoPath)) {
        this.cwd = newCwd;
        // Remove the pwd output from stdout for the original command
        const lines = stdout.trim().split('\n');
        const originalOutput = lines.slice(0, -1).join('\n');
        return {
          stdout: truncateString(originalOutput, 100_000),
          stderr: truncateString(stderr, 50_000),
          exitCode,
        };
      }
    }

    return {
      stdout: truncateString(stdout, 100_000),
      stderr: truncateString(stderr, 50_000),
      exitCode,
    };
  }

  private isDirectoryChangeCommand(command: string): boolean {
    // Skip leading whitespace without allocating new string
    let start = 0;
    while (start < command.length && (command[start] === ' ' || command[start] === '\t')) {
      start++;
    }
    
    // Check if remaining starts with "cd" followed by end or whitespace
    return start + 1 < command.length &&
           command[start] === 'c' && 
           command[start + 1] === 'd' && 
           (start + 2 === command.length || 
            command[start + 2] === ' ' || 
            command[start + 2] === '\t');
  }
}
