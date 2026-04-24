/**
 * pi-senior-review — Pi extension
 *
 * After each agent turn that modifies files, spawns a fresh pi instance
 * to do a code review. Feeds the review feedback back to the main agent
 * as a steering message so it can decide whether to fix anything.
 *
 * Configuration (optional, in cwd/.senior-review/ or ~/.pi/.senior-review/, local takes precedence):
 *   settings.json       — { "maxReviewLoops": 100, "toggleShortcut": "alt+r", "cancelShortcut": "alt+x" }
 *   review-rules.md     — custom review rules appended to prompt
 *
 * UX:
 *   - Status bar shows senior review on/off + pending file count
 *   - Alt+R toggles review on/off (configurable: toggleShortcut)
 *   - Alt+X or /cancel-review cancels an in-progress review (cancelShortcut configurable, default: none)
 *   - Ctrl+Alt+R also cancels (terminals that support it)
 *   - /review command toggles, /review <N> reviews last N commits
 *
 * Install:
 *   pi install npm:@inceptionstack/pi-senior-review
 *   or: cp index.ts ~/.pi/agent/extensions/pi-senior-review.ts
 */

import { createHash } from "node:crypto";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  type AutoReviewSettings,
  DEFAULT_SETTINGS,
  configDirs,
  loadSettings,
  loadReviewRules,
  loadAutoReviewRules,
  loadShortcutSettingsSync,
} from "./settings";
import { buildReviewPrompt } from "./prompt";
import { clampCommitCount, shouldDiffAllCommits, truncateDiff } from "./helpers";
import { runReviewSession, sendReviewResult } from "./reviewer";
import {
  type TrackedToolCall,
  hasFileChanges,
  isFileModifyingTool,
  collectModifiedPaths,
  isFormattingOnlyTurn,
} from "./changes";
import { getBestReviewContent } from "./context";
import { loadIgnorePatterns, filterIgnored } from "./ignore";
import {
  loadRoundupRules,
  runRoundupReview,
  checkRoundupHeuristics,
  runRoundupJudge,
} from "./roundup";
import { findGitRoot, resolveAllGitRoots } from "./git-roots";
import { log, logRotate } from "./logger";
import { startReviewDisplay, type ReviewDisplayHandle } from "./review-display";
import {
  SCAFFOLD_SETTINGS,
  SCAFFOLD_REVIEW_RULES,
  SCAFFOLD_AUTO_REVIEW,
  SCAFFOLD_ROUNDUP_RULES,
  SCAFFOLD_IGNORE,
} from "./scaffold";

const MAX_TRACKED_FILES = 1000;

/** Minimum content length to trigger a review (avoids reviewing trivial/empty diffs) */
const MIN_REVIEW_CONTENT_LENGTH = 50;

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
  let sessionChangedFiles = new Set<string>(); // accumulates files across review loops for roundup

  let settings: AutoReviewSettings = { ...DEFAULT_SETTINGS };
  let customRules: string | null = null;
  let autoReviewRules: string | null = null;
  let ignorePatterns: string[] | null = null;

  let reviewDisplay: ReviewDisplayHandle | null = null;

  let agentToolCalls: TrackedToolCall[] = [];
  const modifiedFiles = new Set<string>();
  const detectedGitRoots = new Set<string>(); // git repos discovered from file paths or bash git commands
  const pendingArgs = new Map<string, { name: string; input: any }>();

  // Load shortcut config synchronously at init (before session_start)
  // so registerShortcut() uses the configured keys.
  const shortcutConfig = loadShortcutSettingsSync(process.cwd());

  // ── Helpers ──────────────────────────────────────

  /**
   * Build ReviewOptions for runReviewSession from current settings + call-site args.
   * Centralizes option wiring so adding a new setting only requires one edit.
   */
  function buildReviewOptions(
    signal: AbortSignal,
    cwd: string,
    filesReviewed: string[],
    onActivity?: (desc: string) => void,
  ) {
    return {
      signal,
      cwd,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      timeoutMs: settings.reviewTimeoutMs,
      filesReviewed,
      onActivity,
    };
  }

  /**
   * Start the visual review progress widget and return a combined activity
   * callback that updates both the status bar and the widget.
   */
  function startReviewWidget(
    ctx: { ui: any; hasUI?: boolean },
    files: string[],
  ): (desc: string) => void {
    if (!ctx.hasUI) return (desc) => updateStatus(ctx, desc);

    reviewDisplay = startReviewDisplay(ctx.ui, {
      files,
      activeFile: null,
      activity: "starting…",
      loopCount: reviewLoopCount,
      maxLoops: settings.maxReviewLoops,
      model: settings.model,
      startTime: Date.now(),
    });

    return (desc: string) => {
      updateStatus(ctx, desc);
      if (!reviewDisplay) return;
      // Try to extract the active file from the activity description
      const readMatch = desc.match(/^reading\s+(.+)/);
      if (readMatch) {
        const path = readMatch[1];
        reviewDisplay.update({ activity: desc, activeFile: path });
      } else {
        reviewDisplay.update({ activity: desc });
      }
    };
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

  /**
   * Clean up after a review completes (success, error, or cancel).
   * Pass resetTracking=false for /review N which doesn't track files.
   */
  function finishReview(ctx: { ui: any; hasUI?: boolean }, resetTracking = true) {
    isReviewing = false;
    reviewAbort = null;
    clearActivityTimer();
    if (reviewDisplay) {
      reviewDisplay.stop();
      reviewDisplay = null;
    }
    if (resetTracking) {
      resetTrackingState(ctx);
    } else {
      updateStatus(ctx);
    }
  }

  function updateStatus(ctx: { ui: any; hasUI?: boolean }, activity?: string) {
    if (!ctx.hasUI || !ctx.ui) return;
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "senior-review");
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
      const cancelHint = shortcutConfig.cancelShortcut
        ? `${shortcutConfig.cancelShortcut} or /cancel-review`
        : "/cancel-review";
      ctx.ui.setStatus(
        "code-review",
        `${label} ${theme.fg("warning", "reviewing…")} ${loopInfo} ${modelInfo}${activityInfo} ${theme.fg("dim", `(${cancelHint})`)}`,
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
        const verb = reviewEnabled
          ? theme.fg("muted", "will review")
          : theme.fg("muted", "pending");
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
        sessionChangedFiles = new Set();
        if (ctx.hasUI) ctx.ui.notify(`Senior review: on`, "info");
        // Only prompt to review if agent is idle and there are pending files.
        // If agent is mid-turn, silently enable — review triggers at next agent_end.
        const idle = ctx.isIdle?.() ?? true;
        if (modifiedFiles.size > 0 && ctx.hasUI && idle) {
          const count = modifiedFiles.size;
          const ok = await ctx.ui.confirm(
            "Run review now?",
            `${count} file${count > 1 ? "s" : ""} changed while senior review was off. Review them now?`,
            { timeout: 30000 },
          );
          if (ok) {
            reviewLoopCount++;
            isReviewing = true;
            reviewAbort = new AbortController();
            updateStatus(ctx);
            try {
              // Resolve git roots from tracked files, tool call paths, and detected bash git commands
              const allRoots = await resolveAllGitRoots(
                pi,
                ctx.cwd,
                modifiedFiles,
                collectModifiedPaths(agentToolCalls),
                detectedGitRoots,
              );

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

              log(
                "best:",
                best
                  ? { label: best.label, files: best.files, contentLen: best.content.length }
                  : "null",
              );

              if (best) {
                updateStatus(ctx, "analyzing…");
                const activityCb = startReviewWidget(ctx, best.files);
                const prompt = `${buildReviewPrompt(autoReviewRules, customRules)}\n\n---\n\n${best.content}`;
                log("prompt length:", prompt.length);
                const result = await runReviewSession(
                  prompt,
                  buildReviewOptions(reviewAbort.signal, ctx.cwd, best.files, activityCb),
                );
                log("result:", {
                  isLgtm: result.isLgtm,
                  durationMs: result.durationMs,
                  textLen: result.text.length,
                });
                if (result.isLgtm) reviewLoopCount = 0;
                sendReviewResult(pi, result, best.label, { reviewedFiles: best.files });
              } else {
                log("no changes found");
                ctx.ui.notify("No changes found to review.", "info");
              }
            } catch (err: any) {
              if (err?.message === "Review cancelled") {
                ctx.ui.notify("Senior review cancelled", "info");
              } else {
                const errMsg = err?.message ?? String(err);
                log(`ERROR: Review failed: ${errMsg}`);
                ctx.ui.notify(`Senior review error: ${errMsg.slice(0, 200)}`, "error");
              }
            } finally {
              finishReview(ctx);
            }
            return;
          } else {
            // User declined — clear pending so they don't get re-prompted
            resetTrackingState(ctx);
          }
        }
      } else {
        if (ctx.hasUI) ctx.ui.notify(`Senior review: off`, "info");
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
        log(`File tracking cap reached (${MAX_TRACKED_FILES}). Additional files won't be tracked.`);
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
    const rawContent = event.result?.content;
    agentToolCalls.push({
      name: event.toolName,
      input: pending?.input ?? {},
      result: Array.isArray(rawContent)
        ? rawContent
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n")
            .slice(0, 2000)
        : undefined,
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    resetTrackingState(ctx);
  });

  // ── Auto-review on agent_end ───────────────────────

  pi.on("agent_end", async (event, ctx) => {
    // Don't interfere if a toggle-review is in progress (confirm dialog open)
    if (isToggling) return;

    // Don't review if the agent was aborted (Esc pressed)
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
          `Senior review: max loops reached (${settings.maxReviewLoops}). Toggle /review to reset.`,
          "warning",
        );
      resetTrackingState(ctx);
      return;
    }

    if (!hasFileChanges(agentToolCalls)) {
      resetTrackingState(ctx);
      return;
    }

    // Skip review if the turn only ran formatters/linters
    // (prettier, eslint --fix, black, gofmt, etc. — cosmetic changes only)
    if (isFormattingOnlyTurn(agentToolCalls)) {
      log("skipping review: formatting/linting only");
      resetTrackingState(ctx);
      return;
    }

    // Skip review if no real file paths were modified
    // (bash-only turns like cat/tail/ls shouldn't trigger review)
    const realFiles = new Set([
      ...[...modifiedFiles].filter((f) => f !== "(bash file op)"),
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
      const allRoots = await resolveAllGitRoots(
        pi,
        ctx.cwd,
        modifiedFiles,
        collectModifiedPaths(agentToolCalls),
        detectedGitRoots,
      );

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
        log("Skipping — same content as last review");
        resetTrackingState(ctx);
        return;
      }

      updateStatus(ctx, "analyzing…");
      const activityCb = startReviewWidget(ctx, best.files);
      log(
        `Reviewing ${best.files.length} files via ${best.label || "git diff"}: ${best.files.join(", ")}`,
      );
      const prompt = `${buildReviewPrompt(autoReviewRules, customRules)}\n\n---\n\n${best.content}`;
      const result = await runReviewSession(
        prompt,
        buildReviewOptions(reviewAbort.signal, ctx.cwd, best.files, activityCb),
      );

      // Track change summary and files for roundup
      sessionChangeSummaries.push(best.content.slice(0, 5000));
      for (const f of best.files) sessionChangedFiles.add(f);

      // Mark content as reviewed (only after successful completion)
      lastReviewedContentHash = contentHash;

      if (result.isLgtm) {
        lastReviewHadIssues = false;
        reviewLoopCount = 0;
        sendReviewResult(pi, result, "", { reviewedFiles: best.files });

        // Gated roundup: heuristics → judge → full roundup
        if (settings.roundupEnabled && !roundupDone) {
          const heuristic = checkRoundupHeuristics({
            changedFiles: [...sessionChangedFiles],
            peakLoopCount: peakReviewLoopCount,
            changeSummaries: sessionChangeSummaries,
          });

          if (heuristic === "maybe") {
            roundupDone = true;
            updateStatus(ctx, "roundup judge…");
            if (reviewDisplay) reviewDisplay.update({ activity: "roundup judge…" });
            const judge = await runRoundupJudge({
              signal: reviewAbort!.signal,
              cwd: ctx.cwd,
              model: settings.model,
              changedFiles: [...sessionChangedFiles],
              peakLoopCount: peakReviewLoopCount,
              changeSummaries: sessionChangeSummaries,
              onActivity: (desc) => {
                updateStatus(ctx, `judge: ${desc}`);
                if (reviewDisplay) reviewDisplay.update({ activity: `judge: ${desc}` });
              },
            });

            if (judge.recommended) {
              log(`roundup: running — ${judge.reason}`);
              updateStatus(ctx, "roundup review…");
              if (reviewDisplay) reviewDisplay.update({ activity: "roundup review…" });
              try {
                const summaryText = sessionChangeSummaries.join("\n\n---\n\n");
                await runRoundupReview({
                  pi,
                  signal: reviewAbort!.signal,
                  cwd: ctx.cwd,
                  model: settings.model,
                  customRules: roundupRules,
                  sessionChangeSummary: summaryText,
                  onActivity: (desc) => {
                    updateStatus(ctx, `roundup: ${desc}`);
                    if (reviewDisplay) reviewDisplay.update({ activity: `roundup: ${desc}` });
                  },
                });
              } catch (err: any) {
                if (err?.message === "Review cancelled") throw err;
                log(`ERROR: Roundup review failed: ${err?.message ?? err}`);
              } finally {
                // Reset accumulated state so next roundup cycle starts fresh
                sessionChangeSummaries = [];
                sessionChangedFiles = new Set();
                peakReviewLoopCount = 0;
                roundupDone = false;
              }
            } else {
              log(`roundup: skipped by judge — ${judge.reason}`);
              roundupDone = false;
            }
          }
          // heuristic === "skip": roundupDone stays false, will re-evaluate next LGTM
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
        if (ctx.hasUI) ctx.ui.notify("Senior review cancelled", "info");
      } else {
        const errMsg = err?.message ?? String(err);
        log(`ERROR: Review failed: ${errMsg}`);
        if (ctx.hasUI) ctx.ui.notify(`Senior review error: ${errMsg.slice(0, 200)}`, "error");
        pi.sendMessage(
          {
            customType: "code-review",
            content: `⚠️ **Senior review failed**\n\n${errMsg}\n\nThe review could not complete. Check the model configuration in .senior-review/settings.json.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
      }
    } finally {
      finishReview(ctx);
    }
  });

  // ── Shortcuts ──────────────────────────────────────

  // Cancel handler — shared by shortcut + command
  function cancelReview(ctx: { ui: any; hasUI?: boolean }, source: string) {
    if (isReviewing && reviewAbort) {
      log(`Cancel requested via ${source}`);
      reviewAbort.abort();
      if (ctx.hasUI) ctx.ui.notify("Senior review cancelled", "info");
    }
  }

  // Register cancel shortcut only if user explicitly configured one.
  // Default is no shortcut — /cancel-review command is the reliable cross-terminal method.
  if (shortcutConfig.cancelShortcut) {
    pi.registerShortcut(shortcutConfig.cancelShortcut as any, {
      description: "Cancel in-progress code review",
      handler: async (ctx) => cancelReview(ctx, shortcutConfig.cancelShortcut),
    });
  }

  // Also register ctrl+alt+r as a fallback (for terminals that support it)
  if (shortcutConfig.cancelShortcut !== "ctrl+alt+r") {
    pi.registerShortcut("ctrl+alt+r", {
      description: "Cancel in-progress code review (fallback)",
      handler: async (ctx) => cancelReview(ctx, "Ctrl+Alt+R"),
    });
  }

  pi.registerShortcut("ctrl+alt+shift+r", {
    description: "Full reset: cancel review, reset loop count, clear tracked files",
    handler: async (ctx) => {
      log("Full reset via Ctrl+Alt+Shift+R");
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
      sessionChangedFiles = new Set();
      clearActivityTimer();
      if (reviewDisplay) {
        reviewDisplay.stop();
        reviewDisplay = null;
      }
      resetTrackingState(ctx);
      if (ctx.hasUI) ctx.ui.notify("Senior review fully reset", "info");
    },
  });

  // Register configurable toggle shortcut (default: alt+r)
  pi.registerShortcut(shortcutConfig.toggleShortcut as any, {
    description: "Toggle automatic code review",
    handler: async (ctx) => toggleReview(ctx),
  });

  // ── /cancel-review command ─────────────────────────

  pi.registerCommand("cancel-review", {
    description: "Cancel an in-progress code review",
    handler: async (_args, ctx) => {
      if (isReviewing && reviewAbort) {
        cancelReview(ctx, "/cancel-review");
      } else {
        if (ctx.hasUI) ctx.ui.notify("No review in progress", "info");
      }
    },
  });

  // ── /scaffold-review-files command ─────────────────

  pi.registerCommand("scaffold-review-files", {
    description:
      "Create .senior-review/ config templates in a git repo. Usage: /scaffold-review-files [path]",
    handler: async (args, ctx) => {
      const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");

      // Determine target directory: optional arg or cwd
      const targetBase = args?.trim() ? resolve(ctx.cwd, args.trim()) : ctx.cwd;

      // Must be inside a git repo
      const gitCheck = await pi.exec("git", ["-C", targetBase, "rev-parse", "--show-toplevel"], {
        timeout: 5000,
      });
      if (gitCheck.code !== 0) {
        const msg =
          `Not a git repository: ${targetBase}\n\n` +
          `Usage:\n` +
          `  /scaffold-review-files              — scaffold in current directory\n` +
          `  /scaffold-review-files /path/to/repo — scaffold in a specific git repo`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        log(`scaffold: refused — not a git repo: ${targetBase}`);
        return;
      }

      const gitRoot = gitCheck.stdout.trim();

      const dir = join(gitRoot, ".senior-review");
      mkdirSync(dir, { recursive: true });

      const files: Record<string, string> = {
        "settings.json": SCAFFOLD_SETTINGS,
        "auto-review.md": SCAFFOLD_AUTO_REVIEW,
        "review-rules.md": SCAFFOLD_REVIEW_RULES,
        "roundup.md": SCAFFOLD_ROUNDUP_RULES,
        ignore: SCAFFOLD_IGNORE,
      };

      let created = 0;
      let skipped = 0;
      for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name);
        if (existsSync(path)) {
          skipped++;
          log(`scaffold: skipped ${name} (already exists)`);
        } else {
          writeFileSync(path, content);
          created++;
          log(`scaffold: created ${name}`);
        }
      }

      const msg =
        created > 0
          ? `Created ${created} file(s) in ${dir}${skipped > 0 ? ` (${skipped} already existed)` : ""}`
          : `All files already exist in ${dir}`;

      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      log(`scaffold: ${msg}`);
    },
  });

  // ── /senior-edit-review-rules command ───────────────

  pi.registerCommand("senior-edit-review-rules", {
    description: "Edit .senior-review/review-rules.md in pi's built-in editor",
    handler: async (_args, ctx) => {
      const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      // Find existing review-rules.md (local first, then global)
      const [localDir, globalDir] = configDirs(ctx.cwd);
      let filePath: string | null = null;
      let fileContent: string | null = null;

      for (const dir of [localDir, globalDir]) {
        const candidate = join(dir, "review-rules.md");
        if (existsSync(candidate)) {
          filePath = candidate;
          try {
            fileContent = readFileSync(candidate, "utf8");
          } catch (err: any) {
            // File exists but unreadable (permissions, etc.) — don't offer to overwrite
            log(`senior-edit-review-rules: cannot read ${candidate}: ${err?.message}`);
            if (ctx.hasUI) ctx.ui.notify(`Cannot read ${candidate}: ${err?.message}`, "error");
            return;
          }
          break;
        }
      }

      // If not found anywhere, offer to create from scaffold
      if (!filePath) {
        if (!ctx.hasUI) return;
        const ok = await ctx.ui.confirm(
          "No review-rules.md found",
          `Create ${localDir}/review-rules.md from template?`,
        );
        if (!ok) return;

        mkdirSync(localDir, { recursive: true });
        filePath = join(localDir, "review-rules.md");
        fileContent = SCAFFOLD_REVIEW_RULES;
        writeFileSync(filePath, fileContent);
        log(`senior-edit-review-rules: created ${filePath}`);
      }

      if (!ctx.hasUI) return;

      // Open in pi's built-in editor
      const edited = await ctx.ui.editor(`Edit ${filePath}`, fileContent!);

      if (edited === undefined) {
        ctx.ui.notify("Cancelled — no changes saved", "info");
        return;
      }

      if (edited === fileContent) {
        ctx.ui.notify("No changes made", "info");
        return;
      }

      writeFileSync(filePath, edited);

      // Reload rules so they take effect immediately
      customRules = edited.trim() || null;
      log(`senior-edit-review-rules: saved and reloaded ${filePath}`);
      ctx.ui.notify(`Saved ${filePath}`, "info");
    },
  });

  // ── /add-review-rule command ────────────────────────

  pi.registerCommand("add-review-rule", {
    description: "Prepend a custom rule to .senior-review/review-rules.md",
    handler: async (args, ctx) => {
      const rule = (args ?? "").trim();
      if (!rule) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /add-review-rule <rule text>", "warning");
        return;
      }

      const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const [localDir] = configDirs(ctx.cwd);
      const filePath = join(localDir, "review-rules.md");

      let existing = "";
      if (existsSync(filePath)) {
        try {
          existing = readFileSync(filePath, "utf8");
        } catch (err: any) {
          log(`add-review-rule: cannot read ${filePath}: ${err?.message}`);
          if (ctx.hasUI) ctx.ui.notify(`Cannot read ${filePath}: ${err?.message}`, "error");
          return;
        }
      } else {
        mkdirSync(localDir, { recursive: true });
      }

      const newContent = `- ${rule}\n${existing}`;
      writeFileSync(filePath, newContent);

      // Reload rules so they take effect immediately
      customRules = newContent.trim() || null;
      log(`add-review-rule: prepended rule to ${filePath}`);

      // Show confirmation with preview
      const lines = newContent.split("\n");
      const preview = lines.slice(0, 10).join("\n");
      const ellipsis = lines.length > 10 ? "\n. . ." : "";

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Rule added to ${filePath}\n\n${preview}${ellipsis}`,
          "info",
        );
      }
    },
  });

  // ── /review command ────────────────────────────────

  pi.registerCommand("review", {
    description: "Toggle senior review, or '/review <N>' to review last N commits",
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

      // Prevent concurrent reviews — cancel any in-progress senior review
      if (isReviewing && reviewAbort) {
        log("Cancelling in-progress review for /review N");
        reviewAbort.abort();
        isReviewing = false;
        reviewAbort = null;
      }

      isReviewing = true;
      reviewAbort = new AbortController();
      updateStatus(ctx);

      try {
        const countResult = await pi.exec("git", ["rev-list", "--count", "HEAD"], {
          timeout: 5000,
        });
        if (countResult.code !== 0) log(`git rev-list failed: ${countResult.stderr.trim()}`);

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
          ctx.ui.notify(
            `No reviewable changes in last ${effectiveCount} commit(s) (all ignored).`,
            "info",
          );
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

        const prompt = `${buildReviewPrompt(autoReviewRules, customRules)}\n\n---\n\nReview the following git diff (${commitLabel}):\n\nCommits:\n${commitLog}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
        const activityCb = startReviewWidget(ctx, changedFiles);
        const result = await runReviewSession(
          prompt,
          buildReviewOptions(reviewAbort!.signal, ctx.cwd, changedFiles, activityCb),
        );

        sendReviewResult(pi, result, commitLabel);
      } catch (err: any) {
        if (err?.message === "Review cancelled") {
          ctx.ui.notify("Review cancelled", "info");
        } else {
          log(`ERROR: commit review failed: ${err?.message ?? err}`);
          ctx.ui.notify(`Review failed: ${err?.message ?? err}`, "error");
        }
      } finally {
        finishReview(ctx, false);
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
    sessionChangedFiles = new Set();

    const [rules, autoRules, settingsResult, patterns, rRules] = await Promise.all([
      loadReviewRules(ctx.cwd),
      loadAutoReviewRules(ctx.cwd),
      loadSettings(ctx.cwd),
      loadIgnorePatterns(ctx.cwd),
      loadRoundupRules(ctx.cwd),
    ]);

    customRules = rules;
    autoReviewRules = autoRules;
    ignorePatterns = patterns;
    roundupRules = rRules;
    settings = settingsResult.settings;

    if (autoReviewRules) log("Loaded auto-review rules from .senior-review/auto-review.md");
    if (customRules) log("Loaded custom rules from .senior-review/review-rules.md");
    if (roundupRules) log("Loaded roundup rules from .senior-review/roundup.md");
    if (ignorePatterns)
      log(`Loaded ${ignorePatterns.length} ignore pattern(s) from .senior-review/ignore`);
    for (const err of settingsResult.errors) {
      log(err);
      if (ctx.hasUI) ctx.ui.notify(err, "warning");
    }
    if (settingsResult.errors.length === 0) {
      if (settings.maxReviewLoops !== DEFAULT_SETTINGS.maxReviewLoops) {
        log(`maxReviewLoops = ${settings.maxReviewLoops}`);
      }
      log(`reviewer model: ${settings.model}, thinking: ${settings.thinkingLevel}`);
    }

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (reviewAbort) reviewAbort.abort();
    if (reviewDisplay) {
      reviewDisplay.stop();
      reviewDisplay = null;
    }
    agentToolCalls = [];
    modifiedFiles.clear();
    pendingArgs.clear();
  });
}
