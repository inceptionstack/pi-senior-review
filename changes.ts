/**
 * changes.ts — Change detection and summary building
 */

export const FILE_MODIFYING_TOOLS = ["write", "edit"];

const MAX_NON_GIT_FILE_SIZE = 100_000;

/** Common binary file extensions to skip */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".pyc",
  ".class",
  ".o",
  ".obj",
  ".wasm",
  ".sqlite",
  ".db",
]);

/**
 * Check if a file path looks like a binary file.
 */
export function isBinaryPath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export interface TrackedToolCall {
  name: string;
  input: any;
  result?: string;
}

/**
 * Git subcommands that don't modify tracked files (VCS operations).
 * Used to filter out bash calls like `git push`, `git commit`, etc.
 * Note: merge/rebase/reset/checkout CAN modify files so they're NOT here.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "push",
  "commit",
  "add",
  "log",
  "status",
  "diff",
  "show",
  "branch",
  "tag",
  "fetch",
  "remote",
  "stash",
  "config",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "hash-object",
  "blame",
  "reflog",
  "describe",
  "shortlog",
]);

/** Command roots that are treated as non-file-modifying regardless of args. */
const NON_MODIFYING_COMMAND_ROOTS = new Set([
  "aws", // AWS CLI — API calls
  "curl", // HTTP requests
  "wget", // though wget -O writes, treat as non-modifying per user request
  "ping",
  "dig",
  "nslookup",
  "whoami",
  "hostname",
  "date",
  "uname",
  "which",
  "type",
  "true",
  "false",
  "ps",
  "df",
  "du",
  "free",
  "uptime",
  "env",
  "printenv",
  // Read-only / inspection commands
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "stat",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "diff",
  "md5sum",
  "sha256sum",
  "sha1sum",
  "xxd",
  "hexdump",
  "strings",
  "tree",
  "jq",
  "yq",
  // Search / text processing (read-only)
  "grep",
  "egrep",
  "fgrep",
  "rg", // ripgrep
  "ag", // the silver searcher
  "ack",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "column",
  "nl",
  "test",
  "[", // test alias
]);

/** Single-part commands that are allowed in a chain without making it file-modifying. */
const ALLOWED_NAVIGATION = /^(cd|export|pwd|exit|return|true|false)\b/;

/**
 * Patterns matching formatter/linter commands across languages.
 * These modify files but only cosmetically — not worth reviewing.
 */
const FORMATTER_PATTERNS: RegExp[] = [
  // JavaScript / TypeScript
  /\bprettier\b/,
  /\beslint\b.*--fix/,
  /\bbiome\b.*(?:format|check.*--fix|lint.*--fix)/,
  /\bdprint\b.*fmt/,
  // Python
  /\bblack\b/,
  /\bruff\b.*(?:format|check.*--fix)/,
  /\bisort\b/,
  /\bautopep8\b/,
  /\byapf\b/,
  // Go
  /\bgofmt\b/,
  /\bgoimports\b/,
  /\bgolangci-lint\b.*--fix/,
  // Rust
  /\brustfmt\b/,
  /\bcargo\s+fmt\b/,
  /\bcargo\s+clippy\b.*--fix/,
  // C / C++
  /\bclang-format\b/,
  // Java / Kotlin
  /\bgoogle-java-format\b/,
  /\bktlint\b.*--format/,
  /\bktfmt\b/,
  // Ruby
  /\brubocop\b.*-[aA]/,
  /\brubocop\b.*--auto-correct/,
  // PHP
  /\bphp-cs-fixer\b/,
  /\bphpcbf\b/,
  // Swift
  /\bswiftformat\b/,
  // Dart
  /\bdart\s+format\b/,
  // General
  /\beditorconfig-checker\b/,
  // npm/npx wrappers
  /\bnpx\s+prettier\b/,
  /\bnpx\s+eslint\b.*--fix/,
  /\bnpm\s+run\s+(format|lint:fix|fix)\b/,
  /\byarn\s+(format|lint:fix|fix)\b/,
  /\bpnpm\s+(format|lint:fix|fix)\b/,
  /\bbun\s+run\s+(format|lint:fix|fix)\b/,
];

/**
 * Check if a bash command is a code formatter or linter auto-fix.
 * These modify files but only cosmetically (whitespace, ordering, style).
 */
export function isFormatterCommand(command: string): boolean {
  if (!command) return false;
  return FORMATTER_PATTERNS.some((p) => p.test(command));
}

/**
 * Check if an entire turn's tool calls are ONLY formatting/linting operations.
 * Returns true if every file-modifying action is a known formatter command.
 * Returns false if there are no tool calls, or any non-formatter modifications.
 */
export function isFormattingOnlyTurn(toolCalls: TrackedToolCall[]): boolean {
  if (toolCalls.length === 0) return false;

  let hasFormatterCall = false;

  for (const tc of toolCalls) {
    // write/edit tool calls are real modifications, not formatting
    if (FILE_MODIFYING_TOOLS.includes(tc.name)) return false;

    if (tc.name === "bash") {
      const cmd = tc.input?.command ?? "";
      if (isNonFileModifyingCommand(cmd)) continue; // skip non-modifying (git, curl, etc.)
      if (isFormatterCommand(cmd)) {
        hasFormatterCall = true;
        continue;
      }
      // Unknown bash command that could modify files → not formatting-only
      return false;
    }
  }

  return hasFormatterCall;
}

/**
 * Check if a bash command part is a known non-file-modifying command.
 */
function isNonModifyingPart(part: string): boolean {
  if (ALLOWED_NAVIGATION.test(part)) return true;

  // Any output redirection to a file means the command modifies files
  if (/[^>]>[^>]|>>/.test(part)) return false;

  // Git VCS read-only operations
  const gitMatch = part.match(/^git(?:\s+-C\s+\S+)?\s+(\w[\w-]*)/);
  if (gitMatch) return GIT_READ_ONLY_SUBCOMMANDS.has(gitMatch[1]);

  // Generic non-modifying commands (aws, curl, etc.)
  const rootMatch = part.match(/^(\w[\w-]*)/);
  if (rootMatch && NON_MODIFYING_COMMAND_ROOTS.has(rootMatch[1])) return true;

  return false;
}

/**
 * Check if a bash command has no file-modifying side effects.
 * Examples: `git push`, `aws s3 ls`, `curl https://api`, `cd foo && git log`
 */
export function isNonFileModifyingCommand(command: string): boolean {
  if (!command || typeof command !== "string") return false;

  // Split on && || ; to handle command chains
  const parts = command
    .split(/&&|\|\||;/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  return parts.every(isNonModifyingPart);
}

/**
 * Check if any tool calls include file modifications.
 * Bash commands count UNLESS they are known non-modifying (git VCS ops, API calls, etc.)
 */
export function hasFileChanges(toolCalls: TrackedToolCall[]): boolean {
  return toolCalls.some((tc) => {
    if (FILE_MODIFYING_TOOLS.includes(tc.name)) return true;
    if (tc.name === "bash") {
      return !isNonFileModifyingCommand(tc.input?.command ?? "");
    }
    return false;
  });
}

/**
 * Check if a single tool call modifies files.
 * Any bash command is conservatively treated as file-modifying.
 * The reviewer checks git diff and skips if nothing actually changed.
 */
export function isFileModifyingTool(toolName: string): boolean {
  return FILE_MODIFYING_TOOLS.includes(toolName) || toolName === "bash";
}

/**
 * Extract potential file paths from a bash command string.
 * Best-effort: catches common patterns like redirections, common tools.
 */
export function extractPathsFromBashCommand(command: string): string[] {
  const paths: string[] = [];

  // Match quoted or unquoted file paths (absolute or relative)
  // Patterns: > file, >> file, tool file, cp/mv src dst
  const pathPattern = /(?:['"]([^'"]+\.\w+)['"]|\b(\/[\w./-]+\.\w+)\b|\b(\w[\w./-]*\.\w{1,10})\b)/g;
  let match;
  while ((match = pathPattern.exec(command)) !== null) {
    const p = match[1] || match[2] || match[3];
    if (p && !p.startsWith("-") && !isBinaryPath(p)) {
      paths.push(p);
    }
  }

  return [...new Set(paths)];
}

/**
 * Collect all potential file paths from tracked tool calls.
 * Includes explicit paths from write/edit and extracted paths from bash.
 */
export function collectModifiedPaths(toolCalls: TrackedToolCall[]): string[] {
  const paths = new Set<string>();

  for (const tc of toolCalls) {
    if ((tc.name === "write" || tc.name === "edit") && tc.input?.path) {
      paths.add(tc.input.path);
    }
    if (tc.name === "bash" && tc.input?.command) {
      // Skip path extraction from non-file-modifying commands
      // (commit messages, curl URLs, aws ARNs may look like file paths)
      if (isNonFileModifyingCommand(tc.input.command)) continue;
      for (const p of extractPathsFromBashCommand(tc.input.command)) {
        paths.add(p);
      }
    }
  }

  return [...paths];
}

export { MAX_NON_GIT_FILE_SIZE };

/**
 * Check if the agent ran `git commit` during this turn.
 * Used to gate last-commit fallback in auto-review content gathering.
 */
export function hasGitCommitCommand(toolCalls: TrackedToolCall[]): boolean {
  return toolCalls.some((tc) => {
    if (tc.name !== "bash") return false;
    const cmd = String(tc.input?.command ?? "");
    return /\bgit(?:\s+-C\s+\S+)?\s+commit\b/.test(cmd);
  });
}

/**
 * Build a human-readable summary of file changes from tool calls.
 */
export function buildChangeSummary(toolCalls: TrackedToolCall[]): string {
  return toolCalls
    .filter((tc) => FILE_MODIFYING_TOOLS.includes(tc.name) || tc.name === "bash")
    .map((tc) => {
      if (tc.name === "write") {
        return `WROTE file: ${tc.input?.path}\n${String(tc.input?.content ?? "").slice(0, 3000)}`;
      }
      if (tc.name === "edit") {
        const rawEdits = tc.input?.edits;
        const edits = Array.isArray(rawEdits) ? rawEdits : [];
        const editSummary = edits
          .map(
            (e: any, i: number) =>
              `  Edit ${i + 1}:\n    OLD: ${String(e.oldText ?? "").slice(0, 500)}\n    NEW: ${String(e.newText ?? "").slice(0, 500)}`,
          )
          .join("\n");
        return `EDITED file: ${tc.input?.path}\n${editSummary}`;
      }
      if (tc.name === "bash") {
        return `BASH: ${tc.input?.command}\n→ ${String(tc.result ?? "").slice(0, 1000)}`;
      }
      return `${tc.name}: ${JSON.stringify(tc.input).slice(0, 500)}`;
    })
    .join("\n\n---\n\n");
}
