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
 *   - Shift+R toggles review on/off
 *   - Ctrl+Shift+R cancels an in-progress review
 *   - /review command toggles, /review <N> reviews last N commits
 *
 * Install:
 *   pi install npm:@inceptionstack/pi-autoreview
 *   or: cp index.ts ~/.pi/agent/extensions/pi-autoreview.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { clampCommitCount, shouldDiffAllCommits, truncateDiff } from "./helpers";
import { runReviewSession, sendReviewResult } from "./reviewer";
import {
  type TrackedToolCall,
  hasFileChanges,
  isFileModifyingTool,
  buildChangeSummary,
} from "./changes";
import { buildReviewContext, formatReviewContext } from "./context";
import { loadIgnorePatterns } from "./ignore";

// ── Default review prompt ────────────────────────────

const DEFAULT_REVIEW_PROMPT = `You are a senior code reviewer. You will be given:
- A list of changed files
- Full contents of each changed file
- The git diff of the changes
- The project file tree

You also have read-only tools available (read, grep, find, ls) to explore the codebase further. Use them if you need more context — for example to check if tests exist for a module, to read related files, or to understand how a function is used elsewhere. You do NOT have write or edit tools — you are reviewing only, not modifying.

Review the changes for the following:

## Correctness
- Bugs, logic errors, off-by-one errors
- Missing error handling
- Race conditions or concurrency issues

## Security
- Injection vulnerabilities, secret leaks, auth bypasses
- Unsafe input handling

## Design & principles
- DRY (Don't Repeat Yourself) — flag duplicated logic
- Single Responsibility Principle — each function/class should do one thing
- Readability and maintainability — unclear naming, overly complex logic

## Testing
- Are there tests for the new functionality added? Check the test directory.
- Test quality: follow Roy Osherove's "Art of Unit Testing" (3rd edition) conventions:
  - Naming: UnitOfWork_StateUnderTest_ExpectedBehavior (or similar descriptive pattern)
  - Each test should have clear entry points (triggers) and exit points (return values, state changes, or collaborator calls)
  - Tests should be isolated, readable, and trustworthy
  - Flag missing tests for new code paths

## Response format
Be concise. If everything looks fine, say "LGTM — no issues found."
If there are issues, list them as bullet points with severity (high/medium/low).
Do NOT suggest stylistic preferences. Only flag real problems.`;

// ── Config types ─────────────────────────────────────

interface AutoReviewSettings {
  maxReviewLoops: number;
}

const DEFAULT_SETTINGS: AutoReviewSettings = {
  maxReviewLoops: 100,
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
  let reviewLoopCount = 0;

  let settings: AutoReviewSettings = { ...DEFAULT_SETTINGS };
  let customRules: string | null = null;
  let ignorePatterns: string[] | null = null;

  let agentToolCalls: TrackedToolCall[] = [];
  const modifiedFiles = new Set<string>();
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
    pendingArgs.clear();
    updateStatus(ctx);
  }

  function updateStatus(ctx: { ui: any; hasUI?: boolean }, activity?: string) {
    if (!ctx.hasUI || !ctx.ui) return;
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "auto-review");
    const state = reviewEnabled ? theme.fg("success", "on") : theme.fg("dim", "off");

    if (isReviewing) {
      const loopInfo = theme.fg("dim", `[${reviewLoopCount}/${settings.maxReviewLoops}]`);
      const activityInfo = activity ? ` ${theme.fg("muted", activity)}` : "";
      ctx.ui.setStatus(
        "code-review",
        `${label} ${theme.fg("warning", "reviewing…")} ${loopInfo}${activityInfo} ${theme.fg("dim", "(Ctrl+Shift+R to cancel)")}`,
      );
      return;
    }

    if (reviewEnabled && modifiedFiles.size > 0) {
      const count = modifiedFiles.size;
      ctx.ui.setStatus(
        "code-review",
        `${label} ${state} · ${theme.fg("muted", "will review")} ${theme.fg("accent", String(count))} ${theme.fg("muted", count === 1 ? "file" : "files")} ${theme.fg("dim", "(Shift+R toggle)")}`,
      );
      return;
    }

    ctx.ui.setStatus("code-review", `${label} ${state} ${theme.fg("dim", "(Shift+R toggle)")}`);
  }

  function toggleReview(ctx: { ui: any; hasUI?: boolean }) {
    reviewEnabled = !reviewEnabled;
    if (reviewEnabled) reviewLoopCount = 0;
    if (ctx.hasUI) ctx.ui.notify(`Auto-review: ${reviewEnabled ? "on" : "off"}`, "info");
    updateStatus(ctx);
  }

  // ── Tool call tracking ─────────────────────────────

  pi.on("tool_execution_start", async (event, ctx) => {
    pendingArgs.set(event.toolCallId, { name: event.toolName, input: event.args });

    if (isFileModifyingTool(event.toolName, event.args)) {
      if (event.args?.path) modifiedFiles.add(event.args.path);
      else modifiedFiles.add("(bash file op)");
      updateStatus(ctx);
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

  pi.on("agent_end", async (_event, ctx) => {
    if (!reviewEnabled) {
      resetTrackingState(ctx);
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

    reviewLoopCount++;
    isReviewing = true;
    reviewAbort = new AbortController();
    updateStatus(ctx);

    try {
      // Build rich context: file tree, changed files, full contents, diff
      const reviewContext = await buildReviewContext(
        pi,
        (msg) => updateStatus(ctx, msg),
        ignorePatterns ?? undefined,
      );

      let contextSection: string;
      if (reviewContext) {
        contextSection = formatReviewContext(reviewContext);
      } else {
        // No git diff available — fall back to tool call summaries
        const fallback = buildChangeSummary(agentToolCalls);
        if (!fallback.trim()) {
          resetTrackingState(ctx);
          return;
        }
        contextSection = fallback;
      }

      updateStatus(ctx, "analyzing…");
      const prompt = `${buildReviewPrompt()}\n\n---\n\n${contextSection}`;
      const result = await runReviewSession(prompt, {
        signal: reviewAbort.signal,
        cwd: ctx.cwd,
        onActivity: (desc) => updateStatus(ctx, desc),
      });

      if (result.isLgtm) reviewLoopCount = 0;
      sendReviewResult(pi, result, "", {
        showLoopCount: result.isLgtm
          ? undefined
          : `loop ${reviewLoopCount}/${settings.maxReviewLoops}`,
      });
    } catch (err: any) {
      if (err?.message === "Review cancelled") {
        if (ctx.hasUI) ctx.ui.notify("Auto-review cancelled", "info");
      } else {
        console.error("[auto-review] Review failed:", err);
      }
    } finally {
      isReviewing = false;
      reviewAbort = null;
      resetTrackingState(ctx);
    }
  });

  // ── Shortcuts ──────────────────────────────────────

  pi.registerShortcut("ctrl+shift+r", {
    description: "Cancel in-progress code review",
    handler: async (_ctx) => {
      if (isReviewing && reviewAbort) reviewAbort.abort();
    },
  });

  pi.registerShortcut("shift+r", {
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

        const diffResult = await pi.exec("git", diffArgs, { timeout: 15000 });
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
        updateStatus(ctx);
      }
    },
  });

  // ── Session lifecycle ──────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    reviewLoopCount = 0;

    const [rules, settingsResult, patterns] = await Promise.all([
      loadReviewRules(ctx.cwd),
      loadSettings(ctx.cwd),
      loadIgnorePatterns(ctx.cwd),
    ]);

    customRules = rules;
    ignorePatterns = patterns;
    settings = settingsResult.settings;

    if (customRules)
      console.log("[auto-review] Loaded custom rules from .autoreview/review-rules.md");
    if (ignorePatterns)
      console.log(
        `[auto-review] Loaded ${ignorePatterns.length} ignore pattern(s) from .autoreview/ignore`,
      );
    for (const err of settingsResult.errors) {
      console.log(err);
      if (ctx.hasUI) ctx.ui.notify(err, "warning");
    }
    if (
      settingsResult.errors.length === 0 &&
      settings.maxReviewLoops !== DEFAULT_SETTINGS.maxReviewLoops
    ) {
      console.log(`[auto-review] maxReviewLoops = ${settings.maxReviewLoops}`);
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
