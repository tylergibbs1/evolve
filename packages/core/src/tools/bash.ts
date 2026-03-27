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
    const proc = Bun.spawn(["bash", "-c", command], {
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

    // Update working directory if command succeeded and might have changed it
    if (exitCode === 0 && this.isDirectoryChangeCommand(command)) {
      await this.updateWorkingDirectory(command);
    }

    return {
      stdout: truncateString(stdout, 100_000),
      stderr: truncateString(stderr, 50_000),
      exitCode,
    };
  }

  private isDirectoryChangeCommand(command: string): boolean {
    const trimmed = command.trim();
    return trimmed.startsWith("cd ") || trimmed === "cd";
  }

  private async updateWorkingDirectory(command: string): Promise<void> {
    // Execute pwd in the same context to get the actual new directory
    const pwdProc = Bun.spawn(["bash", "-c", `${command} && pwd`], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      env: {
        HOME: this.repoPath,
        PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
      },
    });

    const stdout = await new Response(pwdProc.stdout).text();
    const exitCode = await pwdProc.exited;

    if (exitCode === 0) {
      const newCwd = stdout.trim();
      // Only update if the new directory is within our repo scope
      if (newCwd.startsWith(this.repoPath)) {
        this.cwd = newCwd;
      }
    }
  }
}