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
 *   - Trailing / means directory (treated as dir/**)
 */

import { basename } from "node:path";
import { log } from "./logger";
import { readConfigFile } from "./settings";

/**
 * Parse an ignore file into a list of patterns.
 * Tries cwd/.autoreview/ first, then ~/.pi/.autoreview/.
 */
export async function loadIgnorePatterns(cwd: string): Promise<string[] | null> {
  const content = await readConfigFile(cwd, "ignore");
  if (content === null) return null;
  return parseIgnoreFile(content);
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
 * The pattern should NOT have a ! prefix (negation is handled by the caller).
 */
function patternToRegex(pattern: string): RegExp {
  // Handle trailing / as directory pattern → dir/**
  let p = pattern;
  if (p.endsWith("/")) {
    p = p.slice(0, -1) + "/**";
  }

  const matchFullPath = p.includes("/");

  let regex = p
    .replace(/([.+^${}()|[\]\\])/g, "\\$1")
    .replace(/\*\*/g, "DOUBLESTAR")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/DOUBLESTAR/g, ".*");

  if (matchFullPath) {
    if (regex.startsWith("/")) regex = regex.slice(1);
    regex = `^${regex}$`;
  } else {
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
  const normalized = filePath.startsWith("./") ? filePath.slice(2) : filePath;

  let ignored = false;

  for (const pattern of patterns) {
    const isNegated = pattern.startsWith("!");
    const raw = isNegated ? pattern.slice(1) : pattern;
    const regex = patternToRegex(raw);

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
