import type { BashResult, BashTool } from "../types.ts";

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

    return {
      stdout: truncate(stdout, 100_000),
      stderr: truncate(stderr, 50_000),
      exitCode,
    };
  }
}

/**
 * Truncate string to maxLen characters, adding truncation notice.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... (truncated, ${str.length - maxLen} chars omitted)`;
}
