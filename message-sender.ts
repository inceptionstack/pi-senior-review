import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { log } from "./logger";
import type { ReviewResult } from "./reviewer";

/**
 * Format a review-id footer line for appending to a code-review message.
 * Returns "" when no id is supplied, so call sites can unconditionally inline it.
 *
 * Single source of truth for the footer format — callers outside message-sender
 * (e.g. the architect message in index.ts) should use this helper rather than
 * inlining the markup, so the format stays consistent everywhere.
 */
export function formatReviewIdFooter(reviewId: string | undefined): string {
  if (!reviewId) return "";
  return `\n\n_review-id: \`${reviewId}\`_`;
}

/**
 * Format file paths as a compact tree.
 */
function formatFileTree(files: string[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort();
  return sorted.map((f) => `  ${f}`).join("\n");
}

/**
 * Send the appropriate review result message (LGTM or issues found).
 */
export function sendReviewResult(
  pi: ExtensionAPI,
  result: ReviewResult,
  label: string,
  opts?: {
    showLoopCount?: string;
    reviewedFiles?: string[];
    triggerTurn?: boolean;
    /** Optional unique id for this review cycle, appended as a footer line for log correlation. */
    reviewId?: string;
  },
): void {
  // If no files were reviewed and it's LGTM, silently skip — nothing to report.
  // Always show issues even with zero files (tool-call-only reviews can find bugs).
  if (result.isLgtm && opts?.reviewedFiles && opts.reviewedFiles.length === 0) {
    log(`reviewer: skipping LGTM message — zero reviewed files`);
    return;
  }

  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  const reviewedFiles = opts?.reviewedFiles ?? [];
  const fileList =
    reviewedFiles.length > 0
      ? `\n\n**Reviewed files:**\n\`\`\`\n${formatFileTree(reviewedFiles)}\n\`\`\``
      : "";
  // Footer line with the review id, placed under the reviewed-files block (or under the header when no files).
  // Format: `_review-id: r-abcdef01_` — small/italic, unobtrusive, but visible if scanning.
  // The agent sees this literally in the message content so logs in ~/.pi/.hardno can be correlated.
  const idFooter = formatReviewIdFooter(opts?.reviewId);

  if (result.isLgtm) {
    log(`reviewer: LGTM (${duration}, tools=${result.toolCalls.length})`);
    pi.sendMessage(
      {
        customType: "code-review",
        content: `✅ **Automated Code Review**${label ? ` (${label})` : ""} — ${duration}\n\nReview found no issues. Looks good!${fileList}${idFooter}\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
        display: true,
      },
      { triggerTurn: opts?.triggerTurn ?? true, deliverAs: "followUp" },
    );
  } else {
    log(`reviewer: issues found (${duration}, tools=${result.toolCalls.length})`);
    const loopInfo = opts?.showLoopCount ? ` (${opts.showLoopCount})` : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `🔍 **Automated Code Review**${loopInfo || (label ? ` (${label})` : "")} — ${duration}\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${result.text}${fileList}${idFooter}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either — a new review cycle will check your fixes automatically.`,
        display: true,
      },
      { triggerTurn: opts?.triggerTurn ?? true, deliverAs: "followUp" },
    );
  }
}
