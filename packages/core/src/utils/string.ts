/**
 * String utilities for the Evolve framework.
 */

/**
 * Truncate string to maxLen characters, adding truncation notice.
 */
export function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... (truncated, ${str.length - maxLen} chars omitted)`;
}
