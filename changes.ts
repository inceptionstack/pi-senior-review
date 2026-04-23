/**
 * changes.ts — Change detection and summary building
 */

export const FILE_MODIFYING_TOOLS = ["write", "edit"];
export const BASH_FILE_PATTERN = /\b(cat\s*>|tee|sed\s+-i|mv\s|cp\s|rm\s|mkdir|echo\s.*>)\b/;

export interface TrackedToolCall {
  name: string;
  input: any;
  result?: string;
}

/**
 * Check if any tool calls include file modifications.
 */
export function hasFileChanges(toolCalls: TrackedToolCall[]): boolean {
  return toolCalls.some(
    (tc) =>
      FILE_MODIFYING_TOOLS.includes(tc.name) ||
      (tc.name === "bash" && BASH_FILE_PATTERN.test(tc.input?.command ?? "")),
  );
}

/**
 * Check if a single tool call modifies files.
 */
export function isFileModifyingTool(toolName: string, args?: any): boolean {
  if (FILE_MODIFYING_TOOLS.includes(toolName)) return true;
  if (toolName === "bash" && BASH_FILE_PATTERN.test(args?.command ?? "")) return true;
  return false;
}

/**
 * Build a human-readable summary of file changes from tool calls.
 */
export function buildChangeSummary(toolCalls: TrackedToolCall[]): string {
  return toolCalls
    .filter((tc) => FILE_MODIFYING_TOOLS.includes(tc.name) || tc.name === "bash")
    .map((tc) => {
      if (tc.name === "write") {
        return `WROTE file: ${tc.input?.path}\n${(tc.input?.content ?? "").slice(0, 3000)}`;
      }
      if (tc.name === "edit") {
        const edits = tc.input?.edits ?? [];
        const editSummary = edits
          .map(
            (e: any, i: number) =>
              `  Edit ${i + 1}: replaced "${(e.oldText ?? "").slice(0, 200)}" with "${(e.newText ?? "").slice(0, 200)}"`,
          )
          .join("\n");
        return `EDITED file: ${tc.input?.path}\n${editSummary}`;
      }
      if (tc.name === "bash") {
        return `BASH: ${tc.input?.command}\n→ ${(tc.result ?? "").slice(0, 1000)}`;
      }
      return `${tc.name}: ${JSON.stringify(tc.input).slice(0, 500)}`;
    })
    .join("\n\n---\n\n");
}
