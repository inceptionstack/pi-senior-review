/**
 * roundup.ts — Final "zoom out" review after all mini-review loops complete
 *
 * Looks at the big picture: architecture coherence, cross-file consistency,
 * accumulated tech debt, and documentation accuracy.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runReviewSession } from "./reviewer";
import { readConfigFile } from "./settings";

const DEFAULT_ROUNDUP_PROMPT = `You are a senior architect doing a final "zoom out" review. A series of code changes were just made and passed individual mini-reviews. Now step back and look at the big picture.

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

export async function loadRoundupRules(cwd: string): Promise<string | null> {
  const content = await readConfigFile(cwd, "roundup.md");
  return content?.trim() || null;
}

export function buildRoundupPrompt(customRules: string | null): string {
  let prompt = DEFAULT_ROUNDUP_PROMPT;
  if (customRules) {
    prompt += `\n\n## Additional project-specific roundup rules\n\n${customRules}`;
  }
  return prompt;
}

export interface RoundupOptions {
  pi: ExtensionAPI;
  signal: AbortSignal;
  cwd: string;
  model?: string;
  customRules: string | null;
  sessionChangeSummary: string;
  onActivity?: (description: string) => void;
}

/**
 * Run the final roundup review.
 * Returns true if it triggered a turn (issues found), false if LGTM.
 */
export async function runRoundupReview(opts: RoundupOptions): Promise<boolean> {
  const prompt = `${buildRoundupPrompt(opts.customRules)}\n\n---\n\nHere is a summary of all changes made in this session:\n\n${opts.sessionChangeSummary}\n\nPlease explore the codebase with your tools to verify everything fits together.`;

  const result = await runReviewSession(prompt, {
    signal: opts.signal,
    cwd: opts.cwd,
    model: opts.model,
    onActivity: opts.onActivity,
  });

  if (result.isLgtm) {
    opts.pi.sendMessage(
      {
        customType: "code-review",
        content: `🏁 **Roundup Review**\n\nFinal architecture review found no issues. Everything fits together.\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return false;
  } else {
    opts.pi.sendMessage(
      {
        customType: "code-review",
        content: `🏁 **Roundup Review**\n\nFinal architecture review found potential issues:\n\n${result.text}\n\nPlease review these findings. These are big-picture concerns that individual reviews may have missed.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return true;
  }
}
