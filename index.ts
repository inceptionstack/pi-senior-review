/**
 * pi-lgtm — Pi extension
 *
 * After each agent turn that modifies files, spawns a fresh pi instance
 * to do a code review. Feeds the review feedback back to the main agent
 * as a steering message so it can decide whether to fix anything.
 *
 * Configuration (optional, in cwd/.lgtm/ or ~/.pi/.lgtm/, local takes precedence):
 *   settings.json       — { "maxReviewLoops": 100, "toggleShortcut": "alt+r", "cancelShortcut": "alt+x" }
 *   review-rules.md     — custom review rules appended to prompt
 *
 * UX:
 *   - Status bar shows lgtm on/off + pending file count
 *   - Alt+R toggles review on/off (configurable: toggleShortcut)
 *   - Alt+X or /cancel-review cancels an in-progress review (cancelShortcut configurable, default: none)
 *   - Ctrl+Alt+R also cancels (terminals that support it)
 *   - /review command toggles, /review <N> reviews last N commits
 *
 * Install:
 *   pi install npm:@inceptionstack/pi-lgtm
 *   or: cp index.ts ~/.pi/agent/extensions/pi-lgtm.ts
 */

import { type ExtensionAPI, isToolCallEventType } from "@mariozechner/pi-coding-agent";

import {
  type AutoReviewSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  loadReviewRules,
  loadAutoReviewRules,
  loadShortcutSettingsSync,
} from "./settings";
import { runReviewSession } from "./reviewer";
import { classifyBashCommand, defaultJudgeRunner } from "./judge";
import { JudgeSkipChain } from "./judge-skip-chain";
import { isSpawnedSubSession } from "./session-kind";
import { sendReviewResult, formatReviewIdFooter } from "./message-sender";
import { type TrackedToolCall, isFileModifyingTool, collectModifiedPaths } from "./changes";
import { getBestReviewContent } from "./context";
import { loadIgnorePatterns } from "./ignore";
import { loadArchitectRules } from "./architect";
import { findGitRoot, resolveAllGitRoots } from "./git-roots";
import { cleanLogs, log, logRotate } from "./logger";
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
    // Judge wiring: closure over the default runner so the orchestrator
    // stays test-mockable (tests pass their own `judge` fn). When the user
    // hasn't enabled `judgeEnabled` in settings, the orchestrator skips
    // this entirely — zero runtime cost.
    judge: (command, opts) => classifyBashCommand(defaultJudgeRunner, command, opts),
  });

  // ── Helpers ──────────────────────────────────────

  /**
   * Start the visual review progress widget and return callbacks
   * for activity updates and tool call tracking.
   */
  function startReviewWidget(
    ctx: { ui: any; hasUI?: boolean },
    files: string[],
    timeoutMs = 0,
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
      timeoutMs,
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
    // Don't clear skipStatusShowing here — finishReview calls resetTrackingState
    // right after renderOutcome sets the skip status. The flag is only cleared
    // in two places: the top of runAutoReview when the next review cycle
    // starts, and tool_execution_start when the agent performs real file
    // activity. (It used to also clear on agent_start, but that made the skip
    // indicator vanish on the next user prompt — removed.)
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

  /** Check if there are pending file modifications awaiting review. */
  function hasPendingFiles(): boolean {
    if (!orchestrator.isEnabled) return false;
    const realFiles = new Set(modifiedFiles);
    realFiles.delete("(bash file op)");
    return realFiles.size > 0;
  }

  function updateStatus(ctx: { ui: any; hasUI?: boolean }) {
    // Don't overwrite a skip status message unless there's real activity
    if (skipStatusShowing) return;
    const ui = safeGetUi(ctx);
    if (!ui) return;
    const theme = ui.theme;
    const label = theme.fg("accent", "lgtm");
    const state = orchestrator.isEnabled ? theme.fg("success", "on") : theme.fg("dim", "off");

    // Determine if push is currently blocked
    const pushBlocked =
      orchestrator.isEnabled &&
      (orchestrator.isReviewing || orchestrator.lastHadIssues || hasPendingFiles());
    const pushTag = pushBlocked ? ` ${theme.fg("error", "🔒 push blocked")}` : "";

    // Judge indicator. Dim when on (it's a subtle assist); hidden when off.
    // `⚖` (scales) reads as "judge" without needing a word.
    const judgeTag = settings.judgeEnabled ? ` ${theme.fg("dim", "⚖ judge")}` : "";

    if (manualReviews?.isReviewing || orchestrator.isReviewing) {
      const cancelHint = shortcutConfig.cancelShortcut
        ? `${shortcutConfig.cancelShortcut} or /cancel-review`
        : "/cancel-review";
      ui.setStatus(
        "code-review",
        `${label} ${theme.fg("warning", "reviewing…")}${pushTag}${judgeTag} ${theme.fg("dim", `(${cancelHint})`)}`,
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
          `${label} ${state}${issueIndicator}${pushTag}${judgeTag} · ${verb} ${theme.fg("accent", String(count))} ${theme.fg("muted", count === 1 ? "file" : "files")} ${theme.fg("dim", "(Alt+R toggle)")}`,
        );
        return;
      }
    }

    const issueIndicator = orchestrator.lastHadIssues
      ? ` ${theme.fg("error", "issues found")}`
      : "";
    ui.setStatus(
      "code-review",
      `${label} ${state}${issueIndicator}${pushTag}${judgeTag} ${theme.fg("dim", "(Alt+R toggle)")}`,
    );
  }

  let isToggling = false;
  let fileCapWarned = false;
  let skipStatusShowing = false;

  // Loop safeguard for judge-skip chains. Each judge_read_only outcome that
  // we follow up with triggerTurn bumps the counter; it resets on any other
  // outcome type (completed / error / cancelled / max_loops / other skip
  // reasons). If we hit the cap we still post the chat message but stop
  // triggering new turns so a runaway "agent keeps exploring, judge keeps
  // skipping" chain can't loop forever. State + message formatting live in
  // judge-skip-chain.ts so they can be unit-tested without the pi SDK.
  const judgeSkipChain = new JudgeSkipChain();

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
        if (ctx.hasUI) ctx.ui.notify(`Review: on`, "info");
        // Only prompt to review if agent is idle and there are pending files.
        // If agent is mid-turn, silently enable — review triggers at next agent_end.
        const idle = ctx.isIdle?.() ?? true;
        if (modifiedFiles.size > 0 && ctx.hasUI && idle) {
          const count = modifiedFiles.size;
          const ok = await ctx.ui.confirm(
            "Run review now?",
            `${count} file${count > 1 ? "s" : ""} changed while review was off. Review them now?`,
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
        if (ctx.hasUI) ctx.ui.notify(`Review: off`, "info");
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

      skipStatusShowing = false; // Review starting clears skip message
      logRotate(source === "auto" ? "=== review start (auto) ===" : "=== review start ===");
      log("cwd:", ctx.cwd);
      log("gitRoots:", [...allRoots]);
      log("modifiedFiles:", [...modifiedFiles]);
      log("agentToolCalls:", agentToolCalls.length);

      let reviewCallbacks: ReturnType<typeof startReviewWidget> | null = null;
      const hadIssuesBefore = orchestrator.lastHadIssues;
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
        onContentReady: (files, _loopCount, timeoutMs) => {
          try {
            updateStatus(ctx);
            reviewCallbacks = startReviewWidget(ctx, files, timeoutMs);
          } catch (err: any) {
            log(`WARNING: onContentReady callback failed: ${err?.message ?? err}`);
          }
        },
        onArchitectStart: (files, timeoutMs) => {
          try {
            if (!reviewDisplay) return;
            const ui = safeGetUi(ctx);
            const uiTheme = ui?.theme;
            if (!uiTheme?.fg || !uiTheme?.bold) {
              reviewDisplay.setArchitectMode(files, undefined, timeoutMs);
              return;
            }
            const modules = inferArchModules(files);
            const theme = {
              fg: uiTheme.fg.bind(uiTheme) as (c: string, t: string) => string,
              bold: uiTheme.bold.bind(uiTheme) as (t: string) => string,
            };
            const archDiagram = buildArchDiagram(modules, null, theme);
            reviewDisplay.setArchitectMode(files, archDiagram, timeoutMs);
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
          `Review: max loops reached (${settings.maxReviewLoops}). Toggle /review to reset.`,
          "warning",
        );
      }
      if (outcome.type === "cancelled" && ctx.hasUI) ctx.ui.notify("Review cancelled", "info");
      if (outcome.type === "error") {
        const errMsg = outcome.error.message;
        log(`ERROR: Review failed: ${errMsg}`);
        log(`ERROR stack: ${outcome.error.stack ?? "(no stack)"}`);
        if (ctx.hasUI) ctx.ui.notify(`Review error: ${errMsg.slice(0, 200)}`, "error");
      }

      renderOutcome(outcome, ctx, hadIssuesBefore);
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      log(`ERROR: Review failed (outer): ${errMsg}`);
      log(`ERROR stack (outer): ${err?.stack ?? "(no stack)"}`);
      if (ctx.hasUI) ctx.ui.notify(`Review error: ${errMsg.slice(0, 200)}`, "error");
      renderOutcome({ type: "error", error: err instanceof Error ? err : new Error(errMsg) }, ctx);
    } finally {
      finishReview(ctx);
    }
  }

  // ── Tool call tracking ─────────────────────────────

  pi.on("tool_execution_start", async (event, ctx) => {
    pendingArgs.set(event.toolCallId, { name: event.toolName, input: event.args });

    if (isFileModifyingTool(event.toolName)) {
      skipStatusShowing = false; // Real file activity clears skip message
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

  // ── Push guard: block git push when review is needed ──

  /** Determine why push should be blocked, or null if push is allowed. */
  function getPushBlockReason(): string | null {
    if (!orchestrator.isEnabled) return null;
    if (orchestrator.isReviewing) return "a code review is in progress";
    if (orchestrator.lastHadIssues) return "the last review found unresolved issues";
    if (hasPendingFiles()) return "files have been modified but not yet reviewed";
    return null;
  }

  pi.on("tool_call", async (event, _ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const cmd = event.input.command ?? "";
    // Match push as a git subcommand (allows flags like --no-pager, -C, -c between git and push)
    // Excludes git stash push (stash operation, not remote push)
    if (!/\bgit\s+(?:\S+\s+)*?push\b/.test(cmd) || /\bgit\s+stash\s+push\b/.test(cmd)) return;

    const reason = getPushBlockReason();
    if (!reason) return;

    const hasOtherCommands = /&&|\|\||;/.test(cmd);
    const hint = hasOtherCommands
      ? " Your command had other parts chained with the push — re-run them without the push."
      : "";

    return {
      block: true,
      reason: `Push blocked: ${reason}.${hint} Push will be allowed after all reviews pass.`,
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (event.prompt) {
      lastUserMessage = event.prompt;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    // Don't clear `skipStatusShowing` here. The skip indicator should persist
    // across turns until:
    //   (a) a new review cycle starts — cleared in runAutoReview, or
    //   (b) the agent performs real file activity — cleared in
    //       tool_execution_start for file-modifying tools.
    // Clearing it on every agent_start was making the indicator vanish as
    // soon as the user sent their next prompt, even though nothing had
    // actually changed review-wise.
    resetTrackingState(ctx);
  });

  // ── Auto-review on agent_end ───────────────────────

  function renderOutcome(
    outcome: ReviewOutcome,
    ctx: { ui: any; hasUI?: boolean },
    hadIssuesBefore = false,
  ) {
    switch (outcome.type) {
      case "skipped": {
        // Show a brief status hint for skip reasons that indicate "nothing to review"
        const ui = safeGetUi(ctx);
        if (ui && outcome.reason !== "disabled") {
          const theme = ui.theme;
          const label = theme.fg("accent", "lgtm");
          const reason =
            outcome.reason === "no_file_changes" || outcome.reason === "no_real_files"
              ? "no file changes"
              : outcome.reason === "no_meaningful_changes" ||
                  outcome.reason === "fallback_too_small"
                ? "no files to review"
                : outcome.reason === "formatting_only"
                  ? "formatting only"
                  : outcome.reason === "duplicate_content"
                    ? "no new changes"
                    : outcome.reason === "judge_read_only"
                      ? "judge: read-only turn"
                      : null;
          if (reason) {
            skipStatusShowing = true;
            // Visible "✓ review skipped" with reason dim next to it. Using the
            // success color signals the "nothing needed reviewing" outcome as
            // a positive (vs the dim gray it used to be, which was easy to
            // miss). Status persists until the next review cycle starts
            // (skipStatusShowing=false is set in runAutoReview) or real file
            // activity in tool_execution_start.
            ui.setStatus(
              "code-review",
              `${label} ${theme.fg("success", "✓ review skipped")} ${theme.fg("dim", `— ${reason}`)}`,
            );
          }
        }

        // If the previous review had issues and this skip means they're resolved,
        // trigger a turn so the agent can continue working.
        if (
          hadIssuesBefore &&
          (outcome.reason === "no_meaningful_changes" || outcome.reason === "fallback_too_small")
        ) {
          pi.sendMessage(
            {
              customType: "code-review",
              content: `✅ **Review issues resolved** — previous issues are no longer present. You can continue working.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }

        // Judge skips are worth surfacing in chat, not just the status bar:
        // (a) the judge actually did work (an LLM call) — the user should see
        //     their opt-in feature operate
        // (b) the status bar is transient; chat is a persistent audit trail
        // We also triggerTurn so the agent can continue naturally (e.g. after
        // a read-only `git status` the user may have asked for a push-if-clean
        // flow; the agent needs to be woken up to proceed).
        //
        // Loop safeguard: `JudgeSkipChain` caps consecutive judge-skip
        // triggers so a runaway "agent keeps exploring, judge keeps skipping"
        // chain can't loop forever. Once the cap is hit we still post the
        // chat message but suppress `triggerTurn` so the agent halts and
        // waits for user input. User can /review-judge-toggle off or prompt
        // manually. State + message formatting live in judge-skip-chain.ts.
        if (outcome.reason === "judge_read_only") {
          const { content, triggerTurn } = judgeSkipChain.handleJudgeSkip(settings.judgeModel);
          pi.sendMessage(
            {
              customType: "code-review",
              content,
              display: true,
            },
            { triggerTurn, deliverAs: "followUp" },
          );
        } else {
          // Non-judge skip reason — reset the chain counter so a later
          // judge-skip gets the full benefit of the cap again.
          judgeSkipChain.reset();
        }
        return;
      }
      case "cancelled":
        judgeSkipChain.reset();
        return;
      case "max_loops":
        judgeSkipChain.reset();
        return;
      case "error": {
        judgeSkipChain.reset();
        const errMsg = outcome.error.message;
        pi.sendMessage(
          {
            customType: "code-review",
            content: `⚠️ **Review failed**\n\n${errMsg}\n\nThe review could not complete. Check the logs in ~/.pi/.lgtm/review.log for details. If this is a timeout, consider increasing reviewTimeoutMs in .lgtm/settings.json.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
        return;
      }
      case "completed": {
        judgeSkipChain.reset();
        const hasArchitectStep = Boolean(outcome.architect);
        const hasArchitectFailure = Boolean(outcome.architectFailure);
        const hasFollowUp = hasArchitectStep || hasArchitectFailure;
        // Always trigger a turn for ISSUES_FOUND so agent can fix.
        // Also trigger for LGTM so agent can continue (push, etc.).
        // Skip triggering only when architect (success or failure) follows — it sends its own message.
        sendReviewResult(pi, outcome.senior.result, outcome.senior.label ?? "", {
          showLoopCount: outcome.senior.loopInfo,
          reviewedFiles: outcome.files,
          triggerTurn: !hasFollowUp,
          reviewId: outcome.senior.reviewId,
        });

        if (outcome.architectFailure) {
          // Architect was supposed to run but failed (e.g. timed out). Make it visible
          // instead of silently swallowing — the senior review already passed so the
          // follow-up context for the agent is "big-picture check didn't finish".
          const failure = outcome.architectFailure;
          const architectIdFooter = formatReviewIdFooter(failure.reviewId);
          const errMsg = failure.error.message || String(failure.error);
          pi.sendMessage(
            {
              customType: "code-review",
              content: `🏗️ **Architect Review failed**\n\nThe cross-file architecture review did not complete: \`${errMsg.slice(0, 300)}\`\n\nIndividual file reviews passed, but the big-picture check didn't finish. You may want to — at your discretion — rerun the review, inspect cross-file consistency manually, or proceed.${architectIdFooter}`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
          return;
        }

        if (!outcome.architect) return;

        const architectResult = outcome.architect.result;
        const architectIdFooter = formatReviewIdFooter(outcome.architect.reviewId);
        if (architectResult.isLgtm) {
          pi.sendMessage(
            {
              customType: "code-review",
              content: `🏗️ **Architect Review**\n\nFinal architecture review found no issues. Everything fits together.${architectIdFooter}\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } else {
          pi.sendMessage(
            {
              customType: "code-review",
              content: `🏗️ **Architect Review**\n\nFinal architecture review found potential issues:\n\n${architectResult.text}${architectIdFooter}\n\nPlease review these findings. These are big-picture concerns that individual reviews may have missed.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }
      }
    }
  }

  pi.on("agent_end", async (event, ctx) => {
    // First guard: if pi-lgtm is loaded into a spawned sub-session (e.g. the
    // reviewer session created by runReviewSession), do nothing. Without
    // this, our handler recursively triggers a review inside the reviewer
    // session, then crashes with "ctx is stale" once reviewer.ts disposes
    // that session. See session-kind.ts for the full rationale + detection.
    if (isSpawnedSubSession(pi)) return;

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
      if (ctx.hasUI) ctx.ui.notify("Review cancelled", "info");
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
      skipStatusShowing = false;
      judgeSkipChain.reset();
      if (reviewDisplay) {
        reviewDisplay.stop();
        reviewDisplay = null;
      }
      resetTrackingState(ctx);
      if (ctx.hasUI) ctx.ui.notify("Review fully reset", "info");
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

  // ── /review-judge-toggle command ────────────────
  //
  // In-memory toggle for the duplicate-review suppressor. Does NOT persist
  // to settings.json — matches the pattern of /review (Alt+R) which is also
  // a session-level toggle. To make the change permanent, the user edits
  // `.lgtm/settings.json` themselves.
  pi.registerCommand("review-judge-toggle", {
    description: "Toggle the duplicate-review suppressor (judge) for this session",
    handler: async (_args, ctx) => {
      settings.judgeEnabled = !settings.judgeEnabled;
      const state = settings.judgeEnabled ? "on" : "off";
      log(`judge toggled ${state} via /review-judge-toggle`);
      if (ctx.hasUI) {
        ctx.ui.notify(
          settings.judgeEnabled
            ? `Judge: on (skipping redundant reviews on read-only turns, using ${settings.judgeModel.split("/").pop()})`
            : "Judge: off (every file-changing turn triggers a full review)",
          "info",
        );
      }
      // Toggling is explicit user activity — clear any persistent skip
      // indicator so the new `⚖ judge` state renders immediately.
      // Without this, `updateStatus` early-returns when `skipStatusShowing`
      // is true (left over from a prior judge_read_only/no_meaningful_changes
      // skip) and the user sees the old status until the next real activity.
      skipStatusShowing = false;
      updateStatus(ctx);
    },
  });

  // ── /review-clean-logs command ──────────────
  //
  // Wipes ~/.pi/.lgtm/review.log (+ .old) and every structured reviews/*.json.
  // Does NOT touch user config (settings.json, review-rules.md, etc.) — only
  // the append-only history pi-lgtm owns. Useful when testing changes to the
  // review pipeline without noise from prior runs.
  pi.registerCommand("review-clean-logs", {
    description: "Wipe pi-lgtm review logs (review.log + reviews/*.json); leaves config untouched",
    handler: async (_args, ctx) => {
      const { logsRemoved, reviewsRemoved } = cleanLogs();
      const summary = `Cleared ${logsRemoved} log file${logsRemoved === 1 ? "" : "s"} and ${reviewsRemoved} review record${reviewsRemoved === 1 ? "" : "s"}`;
      log(`review-clean-logs: ${summary}`);
      if (ctx.hasUI) ctx.ui.notify(summary, "info");
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
    judgeSkipChain.reset();

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

    if (autoReviewRules) log("Loaded auto-review rules from .lgtm/auto-review.md");
    if (customRules) log("Loaded custom rules from .lgtm/review-rules.md");
    if (architectRules) log("Loaded architect rules from .lgtm/architect.md");
    if (ignorePatterns) log(`Loaded ${ignorePatterns.length} ignore pattern(s) from .lgtm/ignore`);
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
    skipStatusShowing = false;
    judgeSkipChain.reset();
    if (reviewDisplay) {
      reviewDisplay.stop();
      reviewDisplay = null;
    }
    agentToolCalls = [];
    modifiedFiles.clear();
    pendingArgs.clear();
  });
}
