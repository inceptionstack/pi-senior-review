/**
 * ignore.ts — .autoreview/ignore pattern matching
 *
 * Uses gitignore-style patterns:
 *   - Blank lines and lines starting with # are ignored
 *   - * matches anything except /
 *   - ** matches everything including /
 *   - ? matches a single character
 *   - Patterns without / match the filename only
 *   - Patterns with / match the full path
 *   - Leading ! negates a pattern
 */

import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";

/**
 * Parse an ignore file into a list of patterns.
 * Returns null if the file doesn't exist.
 */
export async function loadIgnorePatterns(cwd: string): Promise<string[] | null> {
  try {
    const content = await readFile(join(cwd, ".autoreview", "ignore"), "utf8");
    return parseIgnoreFile(content);
  } catch {
    return null;
  }
}

/**
 * Parse ignore file content into pattern strings.
 */
export function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Convert a gitignore-style pattern to a RegExp.
 */
function patternToRegex(pattern: string): RegExp {
  const isNegated = pattern.startsWith("!");
  const raw = isNegated ? pattern.slice(1) : pattern;

  // If pattern has no /, match against filename only
  // If pattern has /, match against full path
  const matchFullPath = raw.includes("/");

  let regex = raw
    // Escape regex special chars (except * and ?)
    .replace(/([.+^${}()|[\]\\])/g, "\\$1")
    // ** matches everything
    .replace(/\*\*/g, "DOUBLESTAR")
    // * matches anything except /
    .replace(/\*/g, "[^/]*")
    // ? matches single char
    .replace(/\?/g, "[^/]")
    // Restore **
    .replace(/DOUBLESTAR/g, ".*");

  // Anchor
  if (matchFullPath) {
    // Strip leading / for matching
    if (regex.startsWith("/")) regex = regex.slice(1);
    regex = `^${regex}`;
  } else {
    // Match anywhere in filename
    regex = `(^|/)${regex}$`;
  }

  return new RegExp(regex);
}

/**
 * Check if a file path should be ignored based on patterns.
 * Follows gitignore semantics: last matching pattern wins, ! negates.
 */
export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  const name = basename(filePath);
  // Normalize: strip leading ./
  const normalized = filePath.startsWith("./") ? filePath.slice(2) : filePath;

  let ignored = false;

  for (const pattern of patterns) {
    const isNegated = pattern.startsWith("!");
    const raw = isNegated ? pattern.slice(1) : pattern;
    const regex = patternToRegex(raw);

    // Test against full path and filename
    const matchesPath = regex.test(normalized);
    const matchesName = !raw.includes("/") && regex.test(name);

    if (matchesPath || matchesName) {
      ignored = !isNegated;
    }
  }

  return ignored;
}

/**
 * Filter a list of file paths, removing ignored ones.
 */
export function filterIgnored(files: string[], patterns: string[]): string[] {
  return files.filter((f) => !shouldIgnore(f, patterns));
}
