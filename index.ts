/**
 * pi-autoreview — Pi extension
 *
 * After each agent turn that modifies files, spawns a fresh pi instance
 * to do a code review. Feeds the review feedback back to the main agent
 * as a steering message so it can decide whether to fix anything.
 *
 * Configuration (optional, in git repo root):
 *   .autoreview/review-rules.md  — custom review rules appended to prompt
 *   .autoreview/settings.json    — { "maxReviewLoops": 100 }
 *
 * UX:
 *   - Status bar shows auto-review on/off + pending file count
 *   - Alt+R toggles review on/off
 *   - Ctrl+Alt+R cancels an in-progress review
 *   - /review command toggles, /review <N> reviews last N commits
 *
 * Install:
 *   pi install npm:@inceptionstack/pi-autoreview
 *   or: cp index.ts ~/.pi/agent/extensions/pi-autoreview.ts
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { clampCommitCount, shouldDiffAllCommits, truncateDiff } from "./helpers";
import { runReviewSession, sendReviewResult } from "./reviewer";
import { type TrackedToolCall, hasFileChanges, isFileModifyingTool, collectModifiedPaths } from "./changes";
import { getBestReviewContent } from "./context";
import { loadIgnorePatterns, filterIgnored } from "./ignore";
import { loadRoundupRules, runRoundupReview } from "./roundup";
import { findGitRoot, resolveGitRoots } from "./git-roots";
import { log, logRotate } from "./logger";

const MAX_TRACKED_FILES = 1000;

/** Minimum content length to trigger a review (avoids reviewing trivial/empty diffs) */
const MIN_REVIEW_CONTENT_LENGTH = 50;

// ── Default review prompt ────────────────────────────

const DEFAULT_REVIEW_PROMPT = `You are a senior code reviewer. You will be given:
- A list of changed files
- Full contents of each changed file (post-change)
- The git diff of the changes
- Optionally, the project file tree

You have tools to explore the codebase:
- read(path, offset?, limit?) — read a file's contents
- bash(command) — run shell commands (git log, cat, find, grep, etc.)
- grep(pattern, path) — search for a pattern
- find(path, pattern) — find files
- ls(path) — list directory contents

You do NOT have write or edit tools. You are reviewing only, not modifying code.
Do NOT output XML tags like <read_file> or <bash> — use the tools above via function calls.

## IMPORTANT: Verify before flagging

You MUST use your tools to verify any concern before reporting it as an issue.
- If you think a function is missing error handling → read the file and confirm.
- If you think tests are missing → ls/find the test directory and check.
- If you think a pattern is used inconsistently → read the other call sites.
- If you suspect an injection risk → read the actual code to see how args are passed.
- NEVER report issues based on assumptions about code you haven't read.
- NEVER invent or hallucinate code that might exist — read it first.

## Workflow

1. **Explore**: Read all changed files fully. Check the test directory. Understand the codebase.
2. **Analyze**: Compare the diff against the full file contents. Understand the intent.
3. **Report**: Only then write your review.

## What to review

### Correctness (most important)
- Bugs, logic errors, off-by-one errors
- Missing error handling that would cause runtime crashes
- Race conditions or concurrency issues

### Security
- Injection vulnerabilities, secret leaks, auth bypasses
- Unsafe input handling

### Design (only flag clear violations)
- Duplicated logic that will cause bugs if one copy is updated but not the other
- Only flag design issues that create concrete risk, not stylistic preferences

## What NOT to review
- Do NOT flag missing tests unless the change is complex algorithmic logic
- Do NOT flag style issues (naming, file length, pattern preferences)
- Do NOT suggest refactors that aren't related to the current change
- Do NOT report issues you cannot verify with your tools

## Response format
Be concise. If everything looks fine, say "LGTM — no issues found."
If there are issues, list them as bullet points with severity (high/medium/low).
Only report issues you are confident about after verification.`;

// ── Config types ─────────────────────────────────────

interface AutoReviewSettings {
  maxReviewLoops: number;
  model: string; // "provider/model-id" e.g. "amazon-bedrock/us.anthropic.claude-opus-4-6-v1"
  thinkingLevel: string; // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  roundupEnabled: boolean;
}

const DEFAULT_SETTINGS: AutoReviewSettings = {
  maxReviewLoops: 100,
  model: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
  thinkingLevel: "off",
  roundupEnabled: false,
};

// ── Config loading ───────────────────────────────────

async function loadReviewRules(cwd: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, ".autoreview", "review-rules.md"), "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function loadSettings(
  cwd: string,
): Promise<{ settings: AutoReviewSettings; errors: string[] }> {
  const errors: string[] = [];

  try {
    const raw = await readFile(join(cwd, ".autoreview", "settings.json"), "utf8");

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      errors.push(
        `[auto-review] .autoreview/settings.json is not valid JSON: ${e.message}. Using defaults.`,
      );
      return { settings: { ...DEFAULT_SETTINGS }, errors };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`[auto-review] .autoreview/settings.json must be a JSON object. Using defaults.`);
      return { settings: { ...DEFAULT_SETTINGS }, errors };
    }

    const settings = { ...DEFAULT_SETTINGS };

    if ("maxReviewLoops" in parsed) {
      if (
        typeof parsed.maxReviewLoops === "number" &&
        Number.isInteger(parsed.maxReviewLoops) &&
        parsed.maxReviewLoops > 0
      ) {
        settings.maxReviewLoops = parsed.maxReviewLoops;
      } else {
        errors.push(
          `[auto-review] "maxReviewLoops" must be a positive integer (got ${JSON.stringify(parsed.maxReviewLoops)}). Using default: ${DEFAULT_SETTINGS.maxReviewLoops}.`,
        );
      }
    }

    if ("model" in parsed) {
      if (typeof parsed.model === "string" && parsed.model.includes("/")) {
        settings.model = parsed.model;
      } else {
        errors.push(
          `[auto-review] "model" must be "provider/model-id" (got ${JSON.stringify(parsed.model)}). Using default: ${DEFAULT_SETTINGS.model}.`,
        );
      }
    }

    if ("thinkingLevel" in parsed) {
      const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (typeof parsed.thinkingLevel === "string" && valid.includes(parsed.thinkingLevel)) {
        settings.thinkingLevel = parsed.thinkingLevel;
      } else {
        errors.push(
          `[auto-review] "thinkingLevel" must be one of ${valid.join(", ")} (got ${JSON.stringify(parsed.thinkingLevel)}). Using default: ${DEFAULT_SETTINGS.thinkingLevel}.`,
        );
      }
    }

    if ("roundupEnabled" in parsed) {
      if (typeof parsed.roundupEnabled === "boolean") {
        settings.roundupEnabled = parsed.roundupEnabled;
      } else {
        errors.push(
          `[auto-review] "roundupEnabled" must be a boolean (got ${JSON.stringify(parsed.roundupEnabled)}). Using default: ${DEFAULT_SETTINGS.roundupEnabled}.`,
        );
      }
    }

    const knownKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const key of Object.keys(parsed)) {
      if (!knownKeys.has(key)) {
        errors.push(
          `[auto-review] Unknown setting "${key}" (ignored). Known: ${[...knownKeys].join(", ")}.`,
        );
      }
    }

    return { settings, errors };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, errors };
  }
}

// ── Extension ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let reviewEnabled = true;
  let reviewAbort: AbortController | null = null;
  let isReviewing = false;
  let lastReviewHadIssues = false;
  let lastReviewedContentHash = "";
  let reviewLoopCount = 0;
  let peakReviewLoopCount = 0; // highest loop count before LGTM (tracks if fixes happened)
  let roundupDone = false;
  let roundupRules: string | null = null;
  let sessionChangeSummaries: string[] = []; // accumulates change summaries across loops

  let settings: AutoReviewSettings = { ...DEFAULT_SETTINGS };
  let customRules: string | null = null;
  let ignorePatterns: string[] | null = null;

  let agentToolCalls: TrackedToolCall[] = [];
  const modifiedFiles = new Set<string>();
  const detectedGitRoots = new Set<string>(); // git repos discovered from file paths or bash git commands
  const pendingArgs = new Map<string, { name: string; input: any }>();

  // ── Helpers ────────────────────────────────────────

  function buildReviewPrompt(): string {
    let prompt = DEFAULT_REVIEW_PROMPT;
    if (customRules) {
      prompt += `\n\n## Additional project-specific rules\n\n${customRules}`;
    }
    return prompt;
  }

  function resetTrackingState(ctx: { ui: any; hasUI?: boolean }) {
    agentToolCalls = [];
    modifiedFiles.clear();
    detectedGitRoots.clear();
    pendingArgs.clear();
    fileCapWarned = false;
    updateStatus(ctx);
  }

  let lastActivity = "";
  let activityTimer: ReturnType<typeof setTimeout> | undefined;

  function clearActivityTimer() {
    if (activityTimer) {
      clearTimeout(activityTimer);
      activityTimer = undefined;
    }
    lastActivity = "";
  }

  function updateStatus(ctx: { ui: any; hasUI?: boolean }, activity?: string) {
    if (!ctx.hasUI || !ctx.ui) return;
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "auto-review");
    const state = reviewEnabled ? theme.fg("success", "on") : theme.fg("dim", "off");

    if (isReviewing) {
      // Activity lingers for 1s so you can read it
      if (activity) {
        lastActivity = activity;
        if (activityTimer) clearTimeout(activityTimer);
        // Note: setTimeout captures ctx — safe because clearActivityTimer()
        // is called in all review-end paths before ctx can change.
        activityTimer = setTimeout(() => {
          lastActivity = "";
          updateStatus(ctx);
        }, 1000);
      }
      const displayActivity = activity ?? lastActivity;
      const loopInfo = theme.fg("dim", `[${reviewLoopCount}/${settings.maxReviewLoops}]`);
      const modelName = (settings.model || "").split("/").pop() ?? "";
      const modelInfo = theme.fg("dim", modelName);
      const activityInfo = displayActivity ? ` ${theme.fg("muted", displayActivity)}` : "";
      ctx.ui.setStatus(
        "code-review",
        `${label} ${theme.fg("warning", "reviewing…")} ${loopInfo} ${modelInfo}${activityInfo} ${theme.fg("dim", "(Ctrl+Alt+R to cancel)")}`,
      );
      return;
    }

    if (modifiedFiles.size > 0 || agentToolCalls.length > 0) {
      // Include paths extracted from tool call args (e.g. edit path, bash file refs)
      const toolPaths = collectModifiedPaths(agentToolCalls);
      const allPaths = new Set([...modifiedFiles, ...toolPaths]);
      allPaths.delete("(bash file op)");
      const count = allPaths.size;
      if (count > 0) {
        const verb = reviewEnabled ? theme.fg("muted", "will review") : theme.fg("muted", "pending");
        const issueIndicator = lastReviewHadIssues ? ` ${theme.fg("error", "issues found")}` : "";
        ctx.ui.setStatus(
          "code-review",
          `${label} ${state}${issueIndicator} · ${verb} ${theme.fg("accent", String(count))} ${theme.fg("muted", count === 1 ? "file" : "files")} ${theme.fg("dim", "(Alt+R toggle)")}`,
        );
        return;
      }
    }

    const issueIndicator = lastReviewHadIssues ? ` ${theme.fg("error", "issues found")}` : "";
    ctx.ui.setStatus(
      "code-review",
      `${label} ${state}${issueIndicator} ${theme.fg("dim", "(Alt+R toggle)")}`,
    );
  }

  let isToggling = false;
  let fileCapWarned = false;

  async function toggleReview(ctx: {
    ui: any;
    hasUI?: boolean;
    cwd: string;
    isIdle?: () => boolean;
  }) {
    if (isToggling) return;
    isToggling = true;

    try {
      reviewEnabled = !reviewEnabled;
      if (reviewEnabled) {
        reviewLoopCount = 0;
        peakReviewLoopCount = 0;
        lastReviewedContentHash = "";
        roundupDone = false;
        sessionChangeSummaries = [];
        if (ctx.hasUI) ctx.ui.notify(`Auto-review: on`, "info");
        // Only prompt to review if agent is idle and there are pending files.
        // If agent is mid-turn, silently enable — review triggers at next agent_end.
        const idle = ctx.isIdle?.() ?? true;
        if (modifiedFiles.size > 0 && ctx.hasUI && idle) {
          const count = modifiedFiles.size;
          const ok = await ctx.ui.confirm(
            "Run review now?",
            `${count} file${count > 1 ? "s" : ""} changed while auto-review was off. Review them now?`,
            { timeout: 30000 },
          );
          if (ok) {
            reviewLoopCount++;
            isReviewing = true;
            reviewAbort = new AbortController();
            updateStatus(ctx);
            try {
              // Resolve git roots from tracked files, tool call paths, and detected bash git commands
              const allRoots = new Set(detectedGitRoots);
              const toolCallPaths = new Set(collectModifiedPaths(agentToolCalls));
              const combinedFiles = new Set([...modifiedFiles, ...toolCallPaths]);
              const fileRoots = await resolveGitRoots(pi, ctx.cwd, combinedFiles);
              for (const root of fileRoots.keys()) {
                if (root !== "(no-git)") allRoots.add(root);
              }

              logRotate("=== review start ===");
              log("cwd:", ctx.cwd);
              log("gitRoots:", [...allRoots]);
              log("modifiedFiles:", [...modifiedFiles]);
              log("agentToolCalls:", agentToolCalls.length);
              log("ignorePatterns:", ignorePatterns?.length ?? "none");

              const best = await getBestReviewContent(
                pi,
                agentToolCalls,
                (msg) => updateStatus(ctx, msg),
                ignorePatterns ?? undefined,
                allRoots,
              );

              log("best:", best ? { label: best.label, files: best.files, contentLen: best.content.length } : "null");

              if (best) {
                updateStatus(ctx, "analyzing…");
                const prompt = `${buildReviewPrompt()}\n\n---\n\n${best.content}`;
                log("prompt length:", prompt.length);
                const result = await runReviewSession(prompt, {
                  signal: reviewAbort.signal,
                  cwd: ctx.cwd,
                  model: settings.model,
                  thinkingLevel: settings.thinkingLevel,
                  onActivity: (desc) => updateStatus(ctx, desc),
                });
                log("result:", { isLgtm: result.isLgtm, durationMs: result.durationMs, textLen: result.text.length });
                if (result.isLgtm) reviewLoopCount = 0;
                sendReviewResult(pi, result, best.label, { reviewedFiles: best.files });
              } else {
                log("no changes found");
                ctx.ui.notify("No changes found to review.", "info");
              }
            } catch (err: any) {
              if (err?.message === "Review cancelled") {
                ctx.ui.notify("Auto-review cancelled", "info");
              } else {
                const errMsg = err?.message ?? String(err);
                console.error("[auto-review] Review failed:", errMsg);
                ctx.ui.notify(`Auto-review error: ${errMsg.slice(0, 200)}`, "error");
              }
            } finally {
              isReviewing = false;
              reviewAbort = null;
              resetTrackingState(ctx);
            }
            return;
          } else {
            // User declined — clear pending so they don't get re-prompted
            resetTrackingState(ctx);
          }
        }
      } else {
        if (ctx.hasUI) ctx.ui.notify(`Auto-review: off`, "info");
      }
      updateStatus(ctx);
    } finally {
      isToggling = false;
    }
  }

  // ── Tool call tracking ─────────────────────────────

  pi.on("tool_execution_start", async (event, ctx) => {
    pendingArgs.set(event.toolCallId, { name: event.toolName, input: event.args });

    if (isFileModifyingTool(event.toolName)) {
      if (modifiedFiles.size < MAX_TRACKED_FILES) {
        if (event.args?.path) modifiedFiles.add(event.args.path);
        else modifiedFiles.add("(bash file op)");
      } else if (!fileCapWarned) {
        fileCapWarned = true;
        console.log(
          `[auto-review] File tracking cap reached (${MAX_TRACKED_FILES}). Additional files won't be tracked.`,
        );
      }
      updateStatus(ctx);
    }

    // Detect git repo roots from bash git commands
    if (event.toolName === "bash") {
      const cmd = event.args?.command ?? "";
      if (/\bgit\b/.test(cmd)) {
        // Extract -C <dir> if present
        const cFlag = cmd.match(/git\s+-C\s+(\S+)/);
        if (cFlag) {
          const root = await findGitRoot(pi, cFlag[1]);
          if (root) detectedGitRoots.add(root);
        } else {
          // Try cwd
          const root = await findGitRoot(pi, ctx.cwd);
          if (root) detectedGitRoots.add(root);
        }
      }
    }
  });

  pi.on("tool_execution_end", async (event) => {
    const pending = pendingArgs.get(event.toolCallId);
    pendingArgs.delete(event.toolCallId);
    agentToolCalls.push({
      name: event.toolName,
      input: pending?.input ?? {},
      result: event.result?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .slice(0, 2000),
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    resetTrackingState(ctx);
  });

  // ── Auto-review on agent_end ───────────────────────

  pi.on("agent_end", async (event, ctx) => {
    // Don't interfere if a toggle-review is in progress (confirm dialog open)
    if (isToggling) return;

    // Don't auto-review if the agent was aborted (Esc pressed)
    const messages = (event as any).messages ?? [];
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {
      updateStatus(ctx);
      return;
    }

    if (!reviewEnabled) {
      // Keep tracking state (modifiedFiles, agentToolCalls) so we can
      // offer to review when the user toggles review back on.
      // Just update the status bar to show pending file count.
      updateStatus(ctx);
      return;
    }

    if (reviewLoopCount >= settings.maxReviewLoops) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Auto-review: max loops reached (${settings.maxReviewLoops}). Toggle /review to reset.`,
          "warning",
        );
      resetTrackingState(ctx);
      return;
    }

    if (!hasFileChanges(agentToolCalls)) {
      resetTrackingState(ctx);
      return;
    }

    // Skip review if no real file paths were modified
    // (bash-only turns like cat/tail/ls shouldn't trigger review)
    const realFiles = new Set([
      ...[...modifiedFiles].filter(f => f !== "(bash file op)"),
      ...collectModifiedPaths(agentToolCalls),
    ]);
    if (realFiles.size === 0) {
      log("skipping review: no real file paths found");
      resetTrackingState(ctx);
      return;
    }

    reviewLoopCount++;
    isReviewing = true;
    reviewAbort = new AbortController();
    updateStatus(ctx);

    try {
      // Resolve git roots from tracked files, tool call paths, and detected bash git commands
      const allRoots = new Set(detectedGitRoots);
      const toolCallPaths = new Set(collectModifiedPaths(agentToolCalls));
      const combinedFiles = new Set([...modifiedFiles, ...toolCallPaths]);
      const fileRoots = await resolveGitRoots(pi, ctx.cwd, combinedFiles);
      for (const root of fileRoots.keys()) {
        if (root !== "(no-git)") allRoots.add(root);
      }

      logRotate("=== review start (auto) ===");
      log("cwd:", ctx.cwd);
      log("gitRoots:", [...allRoots]);
      log("modifiedFiles:", [...modifiedFiles]);
      log("agentToolCalls:", agentToolCalls.length);

      const best = await getBestReviewContent(
        pi,
        agentToolCalls,
        (msg) => updateStatus(ctx, msg),
        ignorePatterns ?? undefined,
        allRoots,
      );

      if (!best || best.content.trim().length < MIN_REVIEW_CONTENT_LENGTH) {
        // No meaningful changes to review, or content too small
        log("no meaningful changes, skipping");
        resetTrackingState(ctx);
        return;
      }

      log("best:", { label: best.label, files: best.files, contentLen: best.content.length });

      // Skip if we've already reviewed this exact content
      const contentHash = createHash("sha256").update(best.content).digest("hex");
      if (contentHash === lastReviewedContentHash) {
        console.log("[auto-review] Skipping — same content as last review");
        resetTrackingState(ctx);
        return;
      }

      updateStatus(ctx, "analyzing…");
      console.log(
        `[auto-review] Reviewing ${best.files.length} files via ${best.label || "git diff"}: ${best.files.join(", ")}`,
      );
      const prompt = `${buildReviewPrompt()}\n\n---\n\n${best.content}`;
      const result = await runReviewSession(prompt, {
        signal: reviewAbort.signal,
        cwd: ctx.cwd,
        model: settings.model,
        thinkingLevel: settings.thinkingLevel,
        onActivity: (desc) => updateStatus(ctx, desc),
      });

      // Track change summary for roundup
      sessionChangeSummaries.push(best.content.slice(0, 5000));

      // Mark content as reviewed (only after successful completion)
      lastReviewedContentHash = contentHash;

      if (result.isLgtm) {
        lastReviewHadIssues = false;
        // Check if roundup review should trigger:
        // - More than 1 review loop happened (fixes were made)
        // - Roundup hasn't already run this cycle
        if (peakReviewLoopCount >= 1 && !roundupDone) {
          roundupDone = true;
          reviewLoopCount = 0;
          sendReviewResult(pi, result, "", { reviewedFiles: best.files });

          // Run roundup
          updateStatus(ctx, "roundup review…");
          try {
            const summaryText = sessionChangeSummaries.join("\n\n---\n\n");
            await runRoundupReview({
              pi,
              signal: reviewAbort!.signal,
              cwd: ctx.cwd,
              model: settings.model,
              customRules: roundupRules,
              sessionChangeSummary: summaryText,
              onActivity: (desc) => updateStatus(ctx, `roundup: ${desc}`),
            });
          } catch (err: any) {
            if (err?.message !== "Review cancelled") {
              console.error("[auto-review] Roundup review failed:", err);
            }
          }
        } else {
          reviewLoopCount = 0;
          sendReviewResult(pi, result, "", { reviewedFiles: best.files });
        }
      } else {
        peakReviewLoopCount = Math.max(peakReviewLoopCount, reviewLoopCount);
        lastReviewHadIssues = true;
        sendReviewResult(pi, result, "", {
          showLoopCount: `loop ${reviewLoopCount}/${settings.maxReviewLoops}`,
          reviewedFiles: best.files,
        });
      }
    } catch (err: any) {
      if (err?.message === "Review cancelled") {
        if (ctx.hasUI) ctx.ui.notify("Auto-review cancelled", "info");
      } else {
        const errMsg = err?.message ?? String(err);
        console.error("[auto-review] Review failed:", errMsg);
        if (ctx.hasUI) ctx.ui.notify(`Auto-review error: ${errMsg.slice(0, 200)}`, "error");
        pi.sendMessage(
          {
            customType: "code-review",
            content: `⚠️ **Auto-review failed**\n\n${errMsg}\n\nThe review could not complete. Check the model configuration in .autoreview/settings.json.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
      }
    } finally {
      isReviewing = false;
      reviewAbort = null;
      clearActivityTimer();
      resetTrackingState(ctx);
    }
  });

  // ── Shortcuts ──────────────────────────────────────

  pi.registerShortcut("ctrl+alt+r", {
    description: "Cancel in-progress code review",
    handler: async (ctx) => {
      if (isReviewing && reviewAbort) {
        console.log("[auto-review] Cancel requested via Ctrl+Alt+R");
        reviewAbort.abort();
        if (ctx.hasUI) ctx.ui.notify("Auto-review cancelled", "info");
      }
    },
  });

  pi.registerShortcut("ctrl+alt+shift+r", {
    description: "Full reset: cancel review, reset loop count, clear tracked files",
    handler: async (ctx) => {
      console.log("[auto-review] Full reset via Ctrl+Alt+Shift+R");
      if (isReviewing && reviewAbort) {
        reviewAbort.abort();
      }
      isReviewing = false;
      reviewAbort = null;
      reviewLoopCount = 0;
      peakReviewLoopCount = 0;
      lastReviewedContentHash = "";
      roundupDone = false;
      lastReviewHadIssues = false;
      sessionChangeSummaries = [];
      clearActivityTimer();
      resetTrackingState(ctx);
      if (ctx.hasUI) ctx.ui.notify("Auto-review fully reset", "info");
    },
  });

  pi.registerShortcut("alt+r", {
    description: "Toggle automatic code review",
    handler: async (ctx) => toggleReview(ctx),
  });

  // ── /review command ────────────────────────────────

  pi.registerCommand("review", {
    description: "Toggle auto-review, or '/review <N>' to review last N commits",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed || !/^\d+$/.test(trimmed)) {
        toggleReview(ctx);
        return;
      }

      // /review N — review last N commits
      const count = parseInt(trimmed, 10);
      if (count <= 0) {
        ctx.ui.notify("Usage: /review <N> where N > 0", "warning");
        return;
      }

      ctx.ui.notify("Reviewing commits…", "info");
      isReviewing = true;
      reviewAbort = new AbortController();
      updateStatus(ctx);

      try {
        const countResult = await pi.exec("git", ["rev-list", "--count", "HEAD"], {
          timeout: 5000,
        });
        if (countResult.code !== 0)
          console.log(`[auto-review] git rev-list failed: ${countResult.stderr.trim()}`);

        const totalCommits = parseInt(countResult.stdout.trim(), 10) || 0;
        if (totalCommits === 0) {
          ctx.ui.notify("No commits found in this repo.", "warning");
          return;
        }

        const { effectiveCount, wasClamped } = clampCommitCount(count, totalCommits);
        if (wasClamped) ctx.ui.notify(`Repo has ${totalCommits} commits. Reviewing all.`, "info");

        // Build diff args
        const diffArgs: string[] = [];
        if (shouldDiffAllCommits(effectiveCount, totalCommits)) {
          const emptyTree = (
            await pi.exec("git", ["hash-object", "-t", "tree", "/dev/null"], { timeout: 5000 })
          ).stdout.trim();
          diffArgs.push("diff", emptyTree, "HEAD");
        } else {
          diffArgs.push("diff", `HEAD~${effectiveCount}`, "HEAD");
        }

        // Get changed file list and filter ignored patterns
        const nameArgs = [...diffArgs, "--name-only"];
        const nameResult = await pi.exec("git", nameArgs, { timeout: 5000 });
        let changedFiles =
          nameResult.code === 0 ? nameResult.stdout.trim().split("\n").filter(Boolean) : [];

        if (ignorePatterns && ignorePatterns.length > 0) {
          const before = changedFiles.length;
          changedFiles = filterIgnored(changedFiles, ignorePatterns);
          if (changedFiles.length < before) {
            const skipped = before - changedFiles.length;
            ctx.ui.notify(`Filtered ${skipped} ignored file(s)`, "info");
          }
        }

        if (changedFiles.length === 0) {
          ctx.ui.notify(`No reviewable changes in last ${effectiveCount} commit(s) (all ignored).`, "info");
          return;
        }

        // Get diff scoped to non-ignored files only
        const scopedDiffArgs = [...diffArgs, "--", ...changedFiles];
        const diffResult = await pi.exec("git", scopedDiffArgs, { timeout: 15000 });
        if (diffResult.code !== 0) {
          ctx.ui.notify(`git diff failed: ${diffResult.stderr.slice(0, 200)}`, "error");
          return;
        }

        const diff = diffResult.stdout.trim();
        if (!diff) {
          ctx.ui.notify(`No changes in last ${effectiveCount} commit(s).`, "info");
          return;
        }

        const commitLog = (
          await pi.exec("git", ["log", "--oneline", `-${effectiveCount}`], { timeout: 5000 })
        ).stdout.trim();
        const truncatedDiff = truncateDiff(diff, 30000);
        const commitLabel = `last ${effectiveCount} commit${effectiveCount > 1 ? "s" : ""}`;

        const prompt = `${buildReviewPrompt()}\n\n---\n\nReview the following git diff (${commitLabel}):\n\nCommits:\n${commitLog}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
        const result = await runReviewSession(prompt, {
          signal: reviewAbort!.signal,
          cwd: ctx.cwd,
          model: settings.model,
          thinkingLevel: settings.thinkingLevel,
        });

        sendReviewResult(pi, result, commitLabel);
      } catch (err: any) {
        if (err?.message === "Review cancelled") {
          ctx.ui.notify("Review cancelled", "info");
        } else {
          console.error("[auto-review] commit review failed:", err);
          ctx.ui.notify(`Review failed: ${err?.message ?? err}`, "error");
        }
      } finally {
        isReviewing = false;
        reviewAbort = null;
        if (activityTimer) {
          clearTimeout(activityTimer);
          activityTimer = undefined;
        }
        lastActivity = "";
        updateStatus(ctx);
      }
    },
  });

  // ── Session lifecycle ──────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    reviewLoopCount = 0;
    peakReviewLoopCount = 0;
    lastReviewedContentHash = "";
    roundupDone = false;
    sessionChangeSummaries = [];

    const [rules, settingsResult, patterns, rRules] = await Promise.all([
      loadReviewRules(ctx.cwd),
      loadSettings(ctx.cwd),
      loadIgnorePatterns(ctx.cwd),
      loadRoundupRules(ctx.cwd),
    ]);

    customRules = rules;
    ignorePatterns = patterns;
    roundupRules = rRules;
    settings = settingsResult.settings;

    if (customRules)
      console.log("[auto-review] Loaded custom rules from .autoreview/review-rules.md");
    if (roundupRules) console.log("[auto-review] Loaded roundup rules from .autoreview/roundup.md");
    if (ignorePatterns)
      console.log(
        `[auto-review] Loaded ${ignorePatterns.length} ignore pattern(s) from .autoreview/ignore`,
      );
    for (const err of settingsResult.errors) {
      console.log(err);
      if (ctx.hasUI) ctx.ui.notify(err, "warning");
    }
    if (settingsResult.errors.length === 0) {
      if (settings.maxReviewLoops !== DEFAULT_SETTINGS.maxReviewLoops) {
        console.log(`[auto-review] maxReviewLoops = ${settings.maxReviewLoops}`);
      }
      console.log(`[auto-review] reviewer model: ${settings.model}, thinking: ${settings.thinkingLevel}`);
    }

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (reviewAbort) reviewAbort.abort();
    agentToolCalls = [];
    modifiedFiles.clear();
    pendingArgs.clear();
  });
}
