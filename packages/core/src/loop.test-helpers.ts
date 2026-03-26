/**
 * Exported test helpers for loop internals.
 * These are the same functions used internally by loop.ts, extracted
 * so feature tests can test them in isolation.
 */

import { cp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Restore protected paths in the child repo from the parent repo.
 */
export async function restoreProtectedPaths(
  parentPath: string,
  childPath: string,
  protectedPaths: string[],
): Promise<void> {
  for (const protectedPath of protectedPaths) {
    const srcPath = join(parentPath, protectedPath);
    const dstPath = join(childPath, protectedPath);
    try {
      const srcStat = await stat(srcPath);
      if (srcStat.isDirectory()) {
        await rm(dstPath, { recursive: true, force: true });
        await cp(srcPath, dstPath, { recursive: true });
      } else {
        await cp(srcPath, dstPath);
      }
    } catch {
      // Source doesn't exist — nothing to restore
    }
  }
}
