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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  type AutoReviewSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  loadReviewRules,
  loadAutoReviewRules,
  loadShortcutSettingsSync,
} from "./settings";
import { runReviewSession } from "./reviewer";
import { sendReviewResult } from "./message-sender";
import { type TrackedToolCall, isFileModifyingTool, collectModifiedPaths } from "./changes";
import { getBestReviewContent } from "./context";
import { loadIgnorePatterns } from "./ignore";
import { loadArchitectRules } from "./architect";
import { findGitRoot, resolveAllGitRoots } from "./git-roots";
import { log, logRotate } from "./logger";
import { ReviewOrchestrator, type ReviewOutcome } from "./orchestrator";
import { registerReviewCommands, type ManualReviewController } from "./commands";
import {
  startReviewDisplay,
  inferArchModules,
  buildArchDiagram,
  type ReviewDisplayHandle,
} from "./review-display";

const MAX_TRACKED_FILES = 1000;

// ── Extension ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let architectRules: string | null = null;

  let settings: AutoReviewSettings = { ...DEFAULT_SETTINGS };
  let customRules: string | null = null;
  let autoReviewRules: string | null = null;
  let ignorePatterns: string[] | null = null;

  let reviewDisplay: ReviewDisplayHandle | null = null;
  let manualReviews: ManualReviewController | null = null;

  let agentToolCalls: TrackedToolCall[] = [];
  const modifiedFiles = new Set<string>();
  const detectedGitRoots = new Set<string>(); // git repos discovered from file paths or bash git commands
  const pendingArgs = new Map<string, { name: string; input: any }>();
  let lastUserMessage: string | null = null; // captured from before_agent_start

  // Load shortcut config synchronously at init (before session_start)
  // so registerShortcut() uses the configured keys.
  const shortcutConfig = loadShortcutSettingsSync(process.cwd());

  const orchestrator = new ReviewOrchestrator({
    runner: runReviewSession,
    contentBuilder: (input) =>
      getBestReviewContent(
        pi,
        input.agentToolCalls,
        input.onStatus,
        input.ignorePatterns,
        input.gitRoots,
        input.limits,
      ),
  });

  // ── Helpers ──────────────────────────────────────

  /**
   * Start the visual review progress widget and return callbacks
   * for activity updates and tool call tracking.
   */
  function startReviewWidget(
    ctx: { ui: any; hasUI?: boolean },
    files: string[],
  ): {
    onActivity: (desc: string) => void;
    onToolCall: (toolName: string, targetPath: string | null) => void;
  } {
    const noOp = () => {};
    if (!ctx.hasUI) return { onActivity: noOp, onToolCall: noOp };

    reviewDisplay = startReviewDisplay(ctx.ui, {
      files,
      activeFile: null,
      activity: "starting…",
      loopCount: orchestrator.currentLoopCount,
      maxLoops: settings.maxReviewLoops,
      model: settings.model,
      startTime: Date.now(),
      toolCounts: new Map(),
      lastToolDesc: new Map(),
      totalToolCalls: 0,
      isArchitect: false,
      archDiagram: null,
      archActiveModule: null,
    });

    return {
      onActivity: (desc: string) => {
        if (reviewDisplay) reviewDisplay.update({ activity: desc });
      },
      onToolCall: (toolName: string, targetPath: string | null) => {
        if (reviewDisplay) reviewDisplay.recordToolCall(toolName, targetPath);
      },
    };
  }

  function resetTrackingState(ctx: { ui: any; hasUI?: boolean }) {
    agentToolCalls = [];
    modifiedFiles.clear();
    // NOTE: detectedGitRoots is NOT cleared here — it's session-level state.
    // It tracks repos the agent has worked in across turns, used by /review-all
    // when ctx.cwd isn't itself a git repo.
    pendingArgs.clear();
    fileCapWarned = false;
    updateStatus(ctx);
  }

  /**
   * Clean up after a review completes (success, error, or cancel).
   * Pass resetTracking=false for /review N which doesn't track files.
   */
  function finishReview(ctx: { ui: any; hasUI?: boolean }, resetTracking = true) {
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

  /** Safely access ctx.ui, returning null if the context is stale. */
  function safeGetUi(ctx: { ui: any; hasUI?: boolean }): any | null {
    try {
      return ctx.hasUI ? ctx.ui : null;
    } catch {
      return null;
    }
  }

  function updateStatus(ctx: { ui: any; hasUI?: boolean }) {
    const ui = safeGetUi(ctx);
    if (!ui) return;
    const theme = ui.theme;
    const label = theme.fg("accent", "senior-review");
    const state = orchestrator.isEnabled ? theme.fg("success", "on") : theme.fg("dim", "off");

    if (manualReviews?.isReviewing || orchestrator.isReviewing) {
      const cancelHint = shortcutConfig.cancelShortcut
        ? `${shortcutConfig.cancelShortcut} or /cancel-review`
        : "/cancel-review";
      ui.setStatus(
        "code-review",
        `${label} ${theme.fg("warning", "reviewing…")} ${theme.fg("dim", `(${cancelHint})`)}`,
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
        const verb = orchestrator.isEnabled
          ? theme.fg("muted", "will review")
          : theme.fg("muted", "pending");
        const issueIndicator = orchestrator.lastHadIssues
          ? ` ${theme.fg("error", "issues found")}`
          : "";
        ui.setStatus(
          "code-review",
          `${label} ${state}${issueIndicator} · ${verb} ${theme.fg("accent", String(count))} ${theme.fg("muted", count === 1 ? "file" : "files")} ${theme.fg("dim", "(Alt+R toggle)")}`,
        );
        return;
      }
    }

    const issueIndicator = orchestrator.lastHadIssues
      ? ` ${theme.fg("error", "issues found")}`
      : "";
    ui.setStatus(
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
      orchestrator.setEnabled(!orchestrator.isEnabled);
      if (orchestrator.isEnabled) {
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
            await runAutoReview(ctx, "toggle");
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

  async function runAutoReview(ctx: { ui: any; hasUI?: boolean; cwd: string }, source: string) {
    try {
      const allRoots = await resolveAllGitRoots(
        pi,
        ctx.cwd,
        modifiedFiles,
        collectModifiedPaths(agentToolCalls),
        detectedGitRoots,
      );

      logRotate(source === "auto" ? "=== review start (auto) ===" : "=== review start ===");
      log("cwd:", ctx.cwd);
      log("gitRoots:", [...allRoots]);
      log("modifiedFiles:", [...modifiedFiles]);
      log("agentToolCalls:", agentToolCalls.length);

      let reviewCallbacks: ReturnType<typeof startReviewWidget> | null = null;
      const outcome = await orchestrator.handleAgentEnd({
        agentToolCalls,
        modifiedFiles,
        gitRoots: allRoots,
        cwd: ctx.cwd,
        settings,
        customRules,
        autoReviewRules,
        ignorePatterns,
        architectRules,
        lastUserMessage,
        onActivity: (desc) => reviewCallbacks?.onActivity(desc),
        onToolCall: (toolName, targetPath) => reviewCallbacks?.onToolCall(toolName, targetPath),
        onArchitectActivity: (desc) => {
          if (reviewDisplay) reviewDisplay.update({ activity: `architect: ${desc}` });
        },
        onArchitectToolCall: (toolName, targetPath) => {
          if (reviewDisplay) reviewDisplay.recordToolCall(toolName, targetPath);
        },
        onContentReady: (files) => {
          try {
            updateStatus(ctx);
            reviewCallbacks = startReviewWidget(ctx, files);
          } catch (err: any) {
            log(`WARNING: onContentReady callback failed: ${err?.message ?? err}`);
          }
        },
        onArchitectStart: (files) => {
          try {
            if (!reviewDisplay) return;
            const ui = safeGetUi(ctx);
            const uiTheme = ui?.theme;
            if (!uiTheme?.fg || !uiTheme?.bold) {
              reviewDisplay.setArchitectMode(files);
              return;
            }
            const modules = inferArchModules(files);
            const theme = {
              fg: uiTheme.fg.bind(uiTheme) as (c: string, t: string) => string,
              bold: uiTheme.bold.bind(uiTheme) as (t: string) => string,
            };
            const archDiagram = buildArchDiagram(modules, null, theme);
            reviewDisplay.setArchitectMode(files, archDiagram);
          } catch (err: any) {
            log(`WARNING: onArchitectStart callback failed: ${err?.message ?? err}`);
            log(`WARNING stack: ${err?.stack ?? "(no stack)"}`);
          }
        },
        fileExists: async (path) => {
          const result = await pi.exec("test", ["-e", path], { timeout: 3000 });
          return result.code === 0;
        },
      });

      if (outcome.type === "max_loops" && ctx.hasUI) {
        ctx.ui.notify(
          `Senior review: max loops reached (${settings.maxReviewLoops}). Toggle /review to reset.`,
          "warning",
        );
      }
      if (outcome.type === "cancelled" && ctx.hasUI)
        ctx.ui.notify("Senior review cancelled", "info");
      if (outcome.type === "error") {
        const errMsg = outcome.error.message;
        log(`ERROR: Review failed: ${errMsg}`);
        log(`ERROR stack: ${outcome.error.stack ?? "(no stack)"}`);
        if (ctx.hasUI) ctx.ui.notify(`Senior review error: ${errMsg.slice(0, 200)}`, "error");
      }

      renderOutcome(outcome, ctx);
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      log(`ERROR: Review failed (outer): ${errMsg}`);
      log(`ERROR stack (outer): ${err?.stack ?? "(no stack)"}`);
      if (ctx.hasUI) ctx.ui.notify(`Senior review error: ${errMsg.slice(0, 200)}`, "error");
      renderOutcome({ type: "error", error: err instanceof Error ? err : new Error(errMsg) }, ctx);
    } finally {
      finishReview(ctx);
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

  pi.on("before_agent_start", async (event) => {
    if (event.prompt) {
      lastUserMessage = event.prompt;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    resetTrackingState(ctx);
  });

  // ── Auto-review on agent_end ───────────────────────

  function renderOutcome(outcome: ReviewOutcome, ctx: { ui: any; hasUI?: boolean }) {
    switch (outcome.type) {
      case "skipped": {
        // Show a brief status hint for skip reasons that indicate "nothing to review"
        const ui = safeGetUi(ctx);
        if (ui && outcome.reason !== "disabled") {
          const theme = ui.theme;
          const label = theme.fg("accent", "senior-review");
          const reason =
            outcome.reason === "no_file_changes" || outcome.reason === "no_real_files"
              ? "no file changes"
              : outcome.reason === "no_meaningful_changes"
                ? "no files to review"
                : outcome.reason === "formatting_only"
                  ? "formatting only"
                  : outcome.reason === "duplicate_content"
                    ? "no new changes"
                    : null;
          if (reason) {
            ui.setStatus("code-review", `${label} ${theme.fg("dim", `skipped — ${reason}`)}`);
            // Restore normal status after 3s
            setTimeout(() => updateStatus(ctx), 3000);
          }
        }
        return;
      }
      case "cancelled":
        return;
      case "max_loops":
        return;
      case "error": {
        const errMsg = outcome.error.message;
        pi.sendMessage(
          {
            customType: "code-review",
            content: `⚠️ **Senior review failed**\n\n${errMsg}\n\nThe review could not complete. Check the model configuration in .senior-review/settings.json.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
        return;
      }
      case "completed": {
        const hasArchitect = Boolean(outcome.architect);
        // LGTM: don't trigger a turn (nothing to fix). ISSUES_FOUND: trigger so agent fixes.
        const seniorTrigger = !outcome.senior.result.isLgtm && !hasArchitect;
        sendReviewResult(pi, outcome.senior.result, outcome.senior.label ?? "", {
          showLoopCount: outcome.senior.loopInfo,
          reviewedFiles: outcome.files,
          triggerTurn: seniorTrigger,
        });

        if (!outcome.architect) return;

        const architectResult = outcome.architect.result;
        if (architectResult.isLgtm) {
          pi.sendMessage(
            {
              customType: "code-review",
              content: `🏗️ **Architect Review**\n\nFinal architecture review found no issues. Everything fits together.\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
              display: true,
            },
            { triggerTurn: false, deliverAs: "followUp" },
          );
        } else {
          pi.sendMessage(
            {
              customType: "code-review",
              content: `🏗️ **Architect Review**\n\nFinal architecture review found potential issues:\n\n${architectResult.text}\n\nPlease review these findings. These are big-picture concerns that individual reviews may have missed.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }
      }
    }
  }

  pi.on("agent_end", async (event, ctx) => {
    // Don't interfere if a toggle-review is in progress (confirm dialog open)
    if (isToggling) return;

    // Reentrancy guard: if a review is already running (e.g. still winding down
    // after cancel), don't start another one.
    if (orchestrator.isReviewing) {
      log("agent_end: skipping — review still in progress");
      return;
    }

    // Don't review if the agent was aborted (Esc pressed)
    const messages = (event as any).messages ?? [];
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {
      updateStatus(ctx);
      return;
    }

    if (!orchestrator.isEnabled) {
      // Keep tracking state (modifiedFiles, agentToolCalls) so we can
      // offer to review when the user toggles review back on.
      // Just update the status bar to show pending file count.
      updateStatus(ctx);
      return;
    }

    await runAutoReview(ctx, "auto");
  });

  // ── Shortcuts ──────────────────────────────────────

  // Cancel handler — shared by shortcut + command
  function cancelReview(ctx: { ui: any; hasUI?: boolean }, source: string) {
    if (manualReviews?.isReviewing || orchestrator.isReviewing) {
      log(`Cancel requested via ${source}`);
      manualReviews?.cancel();
      orchestrator.cancel();
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
      manualReviews?.cancel();
      orchestrator.reset();
      detectedGitRoots.clear(); // full reset clears session-level state too
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
      if (manualReviews?.isReviewing || orchestrator.isReviewing) {
        cancelReview(ctx, "/cancel-review");
      } else {
        if (ctx.hasUI) ctx.ui.notify("No review in progress", "info");
      }
    },
  });

  manualReviews = registerReviewCommands({
    pi,
    getSettings: () => settings,
    getCustomRules: () => customRules,
    setCustomRules: (rules) => {
      customRules = rules;
    },
    getAutoReviewRules: () => autoReviewRules,
    getIgnorePatterns: () => ignorePatterns,
    getLastUserMessage: () => lastUserMessage,
    getDetectedGitRoots: () => detectedGitRoots,
    toggleReview,
    startReviewWidget,
    finishReview,
    updateStatus,
  });

  // ── Session lifecycle ──────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.reset();
    detectedGitRoots.clear(); // session-level: clear on new session

    const [rules, autoRules, settingsResult, patterns, rRules] = await Promise.all([
      loadReviewRules(ctx.cwd),
      loadAutoReviewRules(ctx.cwd),
      loadSettings(ctx.cwd),
      loadIgnorePatterns(ctx.cwd),
      loadArchitectRules(ctx.cwd),
    ]);

    customRules = rules;
    autoReviewRules = autoRules;
    ignorePatterns = patterns;
    architectRules = rRules;
    settings = settingsResult.settings;

    if (autoReviewRules) log("Loaded auto-review rules from .senior-review/auto-review.md");
    if (customRules) log("Loaded custom rules from .senior-review/review-rules.md");
    if (architectRules) log("Loaded architect rules from .senior-review/architect.md");
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
    manualReviews?.cancel();
    orchestrator.cancel();
    if (reviewDisplay) {
      reviewDisplay.stop();
      reviewDisplay = null;
    }
    agentToolCalls = [];
    modifiedFiles.clear();
    pendingArgs.clear();
  });
}
