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
  private static readonly CD_REGEX = /^\s*cd(?:\s+(.+?))?(?:\s*[;&|]|$)/;

  constructor(
    private repoPath: string,
    private timeoutMs: number = 120_000,
  ) {
    this.cwd = repoPath;
  }

  async run(command: string): Promise<BashResult> {
    // Check for directory change and extract target path in one operation
    const cdMatch = ScopedBashTool.CD_REGEX.exec(command.trim());
    const isDirectoryChange = cdMatch !== null;
    
    let actualCommand = command;
    let newCwd = this.cwd;
    
    if (isDirectoryChange) {
      // Pre-compute the new directory path without spawning a subprocess
      const targetPath = cdMatch[1]?.trim();
      if (targetPath) {
        // Resolve relative/absolute path
        const resolved = targetPath.startsWith('/') 
          ? targetPath 
          : `${this.cwd}/${targetPath}`;
        // Normalize path (handle .. and .)
        const normalized = this.normalizePath(resolved);
        // Only update if within repo scope
        if (normalized.startsWith(this.repoPath)) {
          newCwd = normalized;
        }
      } else {
        // cd with no args goes to HOME (repoPath)
        newCwd = this.repoPath;
      }
    }

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
    if (exitCode === 0 && isDirectoryChange) {
      this.cwd = newCwd;
    }

    return {
      stdout: truncateString(stdout, 100_000),
      stderr: truncateString(stderr, 50_000),
      exitCode,
    };
  }

  private normalizePath(path: string): string {
    // Simple path normalization - handle . and .. components
    const parts = path.split('/').filter(p => p.length > 0);
    const normalized: string[] = [];
    
    for (const part of parts) {
      if (part === '.') {
        continue; // Skip current directory references
      } else if (part === '..') {
        if (normalized.length > 0) {
          normalized.pop(); // Go up one level
        }
      } else {
        normalized.push(part);
      }
    }
    
    return '/' + normalized.join('/');
  }
}
