/**
 * architect.ts — Final "zoom out" architecture review after mini-review loops complete
 *
 * Triggered automatically when more than 1 file was actively reviewed by the
 * senior-review step. No heuristics or judge gating — if multiple files were
 * touched, an architecture-level review always runs.
 *
 * Looks at the big picture: architecture coherence, cross-file consistency,
 * accumulated tech debt, and documentation accuracy.
 */

import { runReviewSession, type ReviewResult } from "./reviewer";
import { readConfigFile } from "./settings";
import { log } from "./logger";

const DEFAULT_ARCHITECT_PROMPT = `You are a senior architect doing a final "zoom out" review. A series of code changes were just made and passed individual mini-reviews. Now step back and look at the big picture.

You have tools available (read, bash, grep, find, ls) to explore the full codebase.

## Architecture coherence
- Do all the pieces fit together? Any orphaned code that nothing calls?
- Is the module dependency graph clean? Any unexpected coupling?
- Does the layering make sense (e.g. no circular dependencies)?

## Cross-file consistency
- Are naming conventions consistent across all changed files?
- Are similar patterns handled the same way everywhere?
- Are types/interfaces consistent and not duplicated?

## Integration completeness
- Is new code properly wired up? Exports used? Imports correct?
- Are there any missing integration points?
- Do tests cover the integration paths, not just unit-level?

## Accumulated tech debt
- Did the back-and-forth fix loops create any franken-code?
- Any TODO/FIXME/HACK comments that were added?
- Dead code or unused imports that accumulated?
- Any functions that grew too large or do too many things?

## Documentation
- Is the README still accurate after all changes?
- Are architecture docs (if any) still correct?
- Do public APIs have adequate comments/types?
- Are new files/modules properly documented?

## Response format
If everything looks good at the big-picture level, say "LGTM — architecture looks solid."
If there are issues, list them as bullet points with severity (high/medium/low).
Focus on systemic issues that individual mini-reviews would miss.
Do NOT repeat issues that were already found and fixed in mini-reviews.`;

/**
 * Load architect review rules from .senior-review/architect.md.
 * Falls back to .senior-review/roundup.md for backwards compatibility.
 */
export async function loadArchitectRules(cwd: string): Promise<string | null> {
  // Try new name first, fall back to old name
  const content = await readConfigFile(cwd, "architect.md");
  if (content?.trim()) return content.trim();
  const legacy = await readConfigFile(cwd, "roundup.md");
  return legacy?.trim() || null;
}

export function buildArchitectPrompt(customRules: string | null): string {
  let prompt = DEFAULT_ARCHITECT_PROMPT;
  if (customRules) {
    prompt += `\n\n## Additional project-specific architect review rules\n\n${customRules}`;
  }
  return prompt;
}

// ── Trigger logic ──────────────────────────────────

/**
 * Determine whether the architect review should run.
 * Triggers when more than 1 file was actively reviewed AND the review
 * content came from one or more git repositories.
 */
export function shouldRunArchitectReview(reviewedFiles: string[], isGitBased: boolean): boolean {
  if (!isGitBased) {
    log(`architect: skip — reviewed files are not from a git repo`);
    return false;
  }
  const dominated = reviewedFiles.length > 1;
  if (dominated) {
    log(`architect: will run — ${reviewedFiles.length} files reviewed from git repo(s)`);
  } else {
    log(`architect: skip — only ${reviewedFiles.length} file(s) reviewed`);
  }
  return dominated;
}

// ── Full architect review ──────────────────────────

export interface ArchitectReviewOptions {
  signal: AbortSignal;
  cwd: string;
  model?: string;
  customRules: string | null;
  sessionChangeSummary: string;
  onActivity?: (description: string) => void;
  onToolCall?: (toolName: string, targetPath: string | null) => void;
}

/**
 * Run the final architect review.
 */
export async function runArchitectReview(opts: ArchitectReviewOptions): Promise<ReviewResult> {
  const prompt = `${buildArchitectPrompt(opts.customRules)}\n\n---\n\nHere is a summary of all changes made in this session:\n\n${opts.sessionChangeSummary}\n\nPlease explore the codebase with your tools to verify everything fits together.`;

  return await runReviewSession(prompt, {
    signal: opts.signal,
    cwd: opts.cwd,
    model: opts.model,
    onActivity: opts.onActivity,
    onToolCall: opts.onToolCall,
  });
}
