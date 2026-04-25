import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { log } from "./logger";
import type { ReviewResult } from "./reviewer";

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
  opts?: { showLoopCount?: string; reviewedFiles?: string[]; triggerTurn?: boolean },
): void {
  // If no files were reviewed and it's LGTM, silently skip — nothing to report.
  // Always show issues even with zero files (tool-call-only reviews can find bugs).
  if (result.isLgtm && opts?.reviewedFiles && opts.reviewedFiles.length === 0) {
    log(`reviewer: skipping LGTM message — zero reviewed files`);
    return;
  }

  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  if (result.isLgtm) {
    log(`reviewer: LGTM (${duration}, tools=${result.toolCalls.length})`);
    const fileList =
      opts?.reviewedFiles && opts.reviewedFiles.length > 0
        ? `\n\n**Reviewed files:**\n\`\`\`\n${formatFileTree(opts.reviewedFiles)}\n\`\`\``
        : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `✅ **Automated Code Review**${label ? ` (${label})` : ""} — ${duration}\n\nReview found no issues. Looks good!${fileList}\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
        display: true,
      },
      { triggerTurn: opts?.triggerTurn ?? true, deliverAs: "followUp" },
    );
  } else {
    log(`reviewer: issues found (${duration}, tools=${result.toolCalls.length})`);
    const loopInfo = opts?.showLoopCount ? ` (${opts.showLoopCount})` : "";
    const fileList =
      opts?.reviewedFiles && opts.reviewedFiles.length > 0
        ? `\n\n**Reviewed files:**\n\`\`\`\n${formatFileTree(opts.reviewedFiles)}\n\`\`\``
        : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `🔍 **Automated Code Review**${loopInfo || (label ? ` (${label})` : "")} — ${duration}\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${result.text}${fileList}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either — a new review cycle will check your fixes automatically.`,
        display: true,
      },
      { triggerTurn: opts?.triggerTurn ?? true, deliverAs: "followUp" },
    );
  }
}
