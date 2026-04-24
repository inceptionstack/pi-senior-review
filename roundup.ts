/**
 * roundup.ts — Final "zoom out" review after all mini-review loops complete
 *
 * Gated by cheap heuristics + a fast LLM judge call:
 * 1. Skip immediately if changes are trivially small
 * 2. Ask a quick LLM judge if a broader review is warranted
 * 3. Only run the full roundup if the judge says yes
 *
 * Looks at the big picture: architecture coherence, cross-file consistency,
 * accumulated tech debt, and documentation accuracy.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runReviewSession } from "./reviewer";
import { readConfigFile } from "./settings";
import { log } from "./logger";

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

// ── Cheap heuristics ───────────────────────────────

const TEST_FILE_PATTERN = /\b(test|spec|__tests__|__mocks__|fixtures?|mocks?)\b/i;

export interface RoundupContext {
  /** All files changed across the session's review loops */
  changedFiles: string[];
  /** Peak review loop count (how many fix loops before LGTM) */
  peakLoopCount: number;
  /** Accumulated change summaries from each review loop */
  changeSummaries: string[];
}

/**
 * Check cheap heuristics to decide if roundup is obviously unnecessary.
 * Returns "skip" (definitely not needed) or "maybe" (needs judge call).
 */
export function checkRoundupHeuristics(ctx: RoundupContext): "skip" | "maybe" {
  const { changedFiles, peakLoopCount } = ctx;

  // No fix loops happened — first-pass LGTM, changes were clean
  if (peakLoopCount === 0) {
    log("roundup heuristic: skip — no fix loops (peakLoopCount=0)");
    return "skip";
  }

  // Too few files to warrant a cross-cutting review
  if (changedFiles.length < 3) {
    log(`roundup heuristic: skip — only ${changedFiles.length} file(s) changed`);
    return "skip";
  }

  // Only test files changed
  const nonTestFiles = changedFiles.filter((f) => !TEST_FILE_PATTERN.test(f));
  if (nonTestFiles.length === 0) {
    log("roundup heuristic: skip — only test files changed");
    return "skip";
  }

  log(
    `roundup heuristic: maybe — ${changedFiles.length} files, ${peakLoopCount} fix loops, ${nonTestFiles.length} non-test`,
  );
  return "maybe";
}

// ── LLM judge ──────────────────────────────────

const JUDGE_PROMPT = `You are deciding whether a set of code changes warrant a broader architecture review.

A broader review is valuable when:
- Changes span multiple modules with cross-cutting concerns
- Structural refactoring happened (files split, merged, moved, interfaces redesigned)
- New public APIs or modules were introduced
- Multiple fix loops happened (suggesting the changes were complex or tricky)
- Dependency graph or module boundaries changed

A broader review is NOT needed when:
- Changes are localized to one area
- Only bug fixes or small improvements
- Changes are additive with no impact on existing code
- Only config, docs, or formatting changes

Based on the summary below, should a broader architecture review be run?

Respond with ONLY a verdict tag and one sentence:
<verdict>ISSUES_FOUND</verdict> if a broader review is warranted (explain why in one sentence).
<verdict>LGTM</verdict> if not needed (explain why in one sentence).
`;

export interface JudgeOptions {
  signal: AbortSignal;
  cwd: string;
  model?: string;
  changedFiles: string[];
  peakLoopCount: number;
  changeSummaries: string[];
  onActivity?: (description: string) => void;
}

/**
 * Run a quick LLM judge to decide if roundup is warranted.
 * Returns true if the judge recommends a roundup, false otherwise.
 * Tight timeout (20s) — if it fails or times out, defaults to skipping.
 */
export async function runRoundupJudge(
  opts: JudgeOptions,
): Promise<{ recommended: boolean; reason: string }> {
  const fileList = opts.changedFiles.join("\n");
  const summarySnippet = opts.changeSummaries
    .map((s) => s.slice(0, 2000))
    .join("\n---\n")
    .slice(0, 8000);

  const context = [
    `## Changed files (${opts.changedFiles.length})`,
    "```",
    fileList,
    "```",
    "",
    `## Fix loops: ${opts.peakLoopCount}`,
    "",
    `## Change summaries`,
    summarySnippet,
  ].join("\n");

  const prompt = `${JUDGE_PROMPT}\n---\n\n${context}`;

  try {
    const result = await runReviewSession(prompt, {
      signal: opts.signal,
      cwd: opts.cwd,
      model: opts.model,
      timeoutMs: 20_000,
      onActivity: opts.onActivity,
    });

    const recommended = !result.isLgtm;
    const reason =
      result.text.slice(0, 200).trim() ||
      (recommended ? "Changes appear complex" : "Changes are localized");
    log(`roundup judge: ${recommended ? "YES" : "NO"} — ${reason} (${result.durationMs}ms)`);
    return { recommended, reason };
  } catch (err: any) {
    if (err?.message === "Review cancelled") throw err;
    log(`roundup judge: error (${err?.message}), defaulting to skip`);
    return { recommended: false, reason: "Judge failed, skipping" };
  }
}

// ── Full roundup ───────────────────────────────

export interface RoundupOptions {
  pi: ExtensionAPI;
  signal: AbortSignal;
  cwd: string;
  model?: string;
  customRules: string | null;
  sessionChangeSummary: string;
  onActivity?: (description: string) => void;
  onToolCall?: (toolName: string, targetPath: string | null) => void;
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
    onToolCall: opts.onToolCall,
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
