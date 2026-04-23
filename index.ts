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
 *   - /review command also toggles
 *
 * Install:
 *   pi install npm:@inceptionstack/pi-autoreview
 *   or: cp index.ts ~/.pi/agent/extensions/pi-autoreview.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

import { clampCommitCount, shouldDiffAllCommits, truncateDiff } from "./helpers";

// ── Default review prompt ────────────────────────────

const DEFAULT_REVIEW_PROMPT = `You are a senior code reviewer. You will be given a description of changes that were just made to a codebase. Review them for the following:

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
- Are there tests for the new functionality added?
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

const FILE_MODIFYING_TOOLS = ["write", "edit"];
const BASH_FILE_PATTERN = /\b(cat\s*>|tee|sed\s+-i|mv\s|cp\s|rm\s|mkdir|echo\s.*>)\b/;

// ── Config loading ───────────────────────────────────

async function loadReviewRules(cwd: string): Promise<string | null> {
  try {
    const rulesPath = join(cwd, ".autoreview", "review-rules.md");
    const content = await readFile(rulesPath, "utf8");
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
    const settingsPath = join(cwd, ".autoreview", "settings.json");
    const raw = await readFile(settingsPath, "utf8");

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
      errors.push(
        `[auto-review] .autoreview/settings.json must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}). Using defaults.`,
      );
      return { settings: { ...DEFAULT_SETTINGS }, errors };
    }

    const settings = { ...DEFAULT_SETTINGS };

    // Validate maxReviewLoops
    if ("maxReviewLoops" in parsed) {
      if (
        typeof parsed.maxReviewLoops === "number" &&
        Number.isInteger(parsed.maxReviewLoops) &&
        parsed.maxReviewLoops > 0
      ) {
        settings.maxReviewLoops = parsed.maxReviewLoops;
      } else {
        errors.push(
          `[auto-review] .autoreview/settings.json: "maxReviewLoops" must be a positive integer (got ${JSON.stringify(parsed.maxReviewLoops)}). Using default: ${DEFAULT_SETTINGS.maxReviewLoops}.`,
        );
      }
    }

    // Warn about unknown keys
    const knownKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const key of Object.keys(parsed)) {
      if (!knownKeys.has(key)) {
        errors.push(
          `[auto-review] .autoreview/settings.json: unknown setting "${key}" (ignored). Known settings: ${[...knownKeys].join(", ")}.`,
        );
      }
    }

    return { settings, errors };
  } catch {
    // File doesn't exist — that's fine, use defaults silently
    return { settings: { ...DEFAULT_SETTINGS }, errors };
  }
}

// ── Extension ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let reviewEnabled = true;
  let reviewAbort: AbortController | null = null;
  let isReviewing = false;
  let reviewLoopCount = 0;

  // Config loaded per session
  let settings: AutoReviewSettings = { ...DEFAULT_SETTINGS };
  let customRules: string | null = null;

  // Track tool calls + modified files across the agent run
  let agentToolCalls: Array<{ name: string; input: any; result?: string }> = [];
  const modifiedFiles = new Set<string>();
  const pendingArgs = new Map<string, { name: string; input: any }>();

  // ── Build the full review prompt ───────────────────

  function buildReviewPrompt(): string {
    let prompt = DEFAULT_REVIEW_PROMPT;
    if (customRules) {
      prompt += `\n\n## Additional project-specific rules\n\n${customRules}`;
    }
    return prompt;
  }

  // ── Status bar ─────────────────────────────────────

  function updateStatus(ctx: { ui: any; hasUI?: boolean }) {
    if (!ctx.hasUI || !ctx.ui) return;
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "auto-review");
    const state = reviewEnabled ? theme.fg("success", "on") : theme.fg("dim", "off");

    if (isReviewing) {
      const loopInfo = theme.fg("dim", `[${reviewLoopCount}/${settings.maxReviewLoops}]`);
      ctx.ui.setStatus(
        "code-review",
        `${label} ${theme.fg("warning", "reviewing…")} ${loopInfo} ${theme.fg("dim", "(Ctrl+Shift+R to cancel)")}`,
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

  function trackFileChange(input: any) {
    if (input?.path) {
      modifiedFiles.add(input.path);
    }
  }

  // ── Tool call tracking ─────────────────────────────

  pi.on("tool_execution_start", async (event, ctx) => {
    pendingArgs.set(event.toolCallId, {
      name: event.toolName,
      input: event.args,
    });

    if (FILE_MODIFYING_TOOLS.includes(event.toolName)) {
      trackFileChange(event.args);
      updateStatus(ctx);
    } else if (event.toolName === "bash" && BASH_FILE_PATTERN.test(event.args?.command ?? "")) {
      modifiedFiles.add("(bash file op)");
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
    agentToolCalls = [];
    modifiedFiles.clear();
    pendingArgs.clear();
    updateStatus(ctx);
  });

  // ── Review on agent_end ────────────────────────────

  pi.on("agent_end", async (_event, ctx) => {
    if (!reviewEnabled) {
      agentToolCalls = [];
      modifiedFiles.clear();
      updateStatus(ctx);
      return;
    }

    // Check loop limit
    if (reviewLoopCount >= settings.maxReviewLoops) {
      console.log(
        `[auto-review] Max review loops reached (${settings.maxReviewLoops}). Skipping review. Reset with /review.`,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto-review: max loops reached (${settings.maxReviewLoops}). Toggle /review to reset.`,
          "warning",
        );
      }
      agentToolCalls = [];
      modifiedFiles.clear();
      updateStatus(ctx);
      return;
    }

    const hasFileChanges = agentToolCalls.some(
      (tc) =>
        FILE_MODIFYING_TOOLS.includes(tc.name) ||
        (tc.name === "bash" && BASH_FILE_PATTERN.test(tc.input?.command ?? "")),
    );

    if (!hasFileChanges) {
      agentToolCalls = [];
      modifiedFiles.clear();
      updateStatus(ctx);
      return;
    }

    // Build a summary of what changed
    const changeSummary = agentToolCalls
      .filter((tc) => FILE_MODIFYING_TOOLS.includes(tc.name) || tc.name === "bash")
      .map((tc) => {
        if (tc.name === "write") {
          return `WROTE file: ${tc.input?.path}\n${(tc.input?.content ?? "").slice(0, 3000)}`;
        }
        if (tc.name === "edit") {
          const edits = tc.input?.edits ?? [];
          const editSummary = edits
            .map(
              (e: any, i: number) =>
                `  Edit ${i + 1}: replaced "${(e.oldText ?? "").slice(0, 200)}" with "${(e.newText ?? "").slice(0, 200)}"`,
            )
            .join("\n");
          return `EDITED file: ${tc.input?.path}\n${editSummary}`;
        }
        if (tc.name === "bash") {
          return `BASH: ${tc.input?.command}\n→ ${(tc.result ?? "").slice(0, 1000)}`;
        }
        return `${tc.name}: ${JSON.stringify(tc.input).slice(0, 500)}`;
      })
      .join("\n\n---\n\n");

    if (!changeSummary.trim()) {
      agentToolCalls = [];
      modifiedFiles.clear();
      updateStatus(ctx);
      return;
    }

    reviewLoopCount++;
    isReviewing = true;
    reviewAbort = new AbortController();
    updateStatus(ctx);

    try {
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);

      const { session: reviewSession } = await createAgentSession({
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
      });

      let reviewText = "";
      const unsub = reviewSession.subscribe((ev) => {
        if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
          reviewText += ev.assistantMessageEvent.delta;
        }
      });

      const reviewPrompt = buildReviewPrompt();

      try {
        const signal = reviewAbort.signal;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            reviewSession.abort();
            reject(new Error("Review cancelled"));
          };

          if (signal.aborted) {
            onAbort();
            return;
          }

          signal.addEventListener("abort", onAbort, { once: true });

          reviewSession
            .prompt(`${reviewPrompt}\n\n---\n\nHere are the changes made:\n\n${changeSummary}`)
            .then(
              () => {
                settled = true;
                signal.removeEventListener("abort", onAbort);
                resolve();
              },
              (err) => {
                settled = true;
                signal.removeEventListener("abort", onAbort);
                reject(err);
              },
            );
        });
      } finally {
        unsub();
        reviewSession.dispose();
      }

      if (!reviewText.trim() || reviewText.includes("LGTM")) {
        console.log("[auto-review] Reviewer says: LGTM");
        reviewLoopCount = 0; // Reset on clean review
        pi.sendMessage(
          {
            customType: "code-review",
            content: `✅ **Automated Code Review**\n\nReview found no issues. Looks good!`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
      } else {
        console.log("[auto-review] Reviewer found issues, feeding back...");
        pi.sendMessage(
          {
            customType: "code-review",
            content: `🔍 **Automated Code Review** (loop ${reviewLoopCount}/${settings.maxReviewLoops})\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${reviewText}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either — a new review cycle will check your fixes automatically.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch (err: any) {
      if (err?.message === "Review cancelled") {
        console.log("[auto-review] Review cancelled by user");
        if (ctx.hasUI) ctx.ui.notify("Auto-review cancelled", "info");
      } else {
        console.error("[auto-review] Review failed:", err);
      }
    } finally {
      isReviewing = false;
      reviewAbort = null;
      agentToolCalls = [];
      modifiedFiles.clear();
      updateStatus(ctx);
    }
  });

  // ── Ctrl+Shift+R to cancel review ─────────────────

  pi.registerShortcut("ctrl+shift+r", {
    description: "Cancel in-progress code review",
    handler: async (_ctx) => {
      if (isReviewing && reviewAbort) {
        reviewAbort.abort();
      }
    },
  });

  // ── Shift+R to toggle ──────────────────────────────

  pi.registerShortcut("shift+r", {
    description: "Toggle automatic code review",
    handler: async (ctx) => {
      reviewEnabled = !reviewEnabled;
      if (reviewEnabled) reviewLoopCount = 0; // Reset loop counter on re-enable
      ctx.ui.notify(`Auto-review: ${reviewEnabled ? "on" : "off"}`, "info");
      updateStatus(ctx);
    },
  });

  // ── /review command ────────────────────────────────

  pi.registerCommand("review", {
    description: "Toggle auto-review, or '/review <N>' to review last N commits",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      // If a number is passed, review last N commits
      if (trimmed && /^\d+$/.test(trimmed)) {
        const count = parseInt(trimmed, 10);
        if (count <= 0) {
          ctx.ui.notify("Usage: /review <N> where N > 0", "warning");
          return;
        }

        ctx.ui.notify(`Reviewing commits…`, "info");
        isReviewing = true;
        reviewAbort = new AbortController();
        updateStatus(ctx);

        try {
          // Check how many commits exist and clamp
          const countResult = await pi.exec("git", ["rev-list", "--count", "HEAD"], {
            timeout: 5000,
          });

          if (countResult.code !== 0) {
            console.log(`[auto-review] git rev-list failed: ${countResult.stderr.trim()}`);
          }

          const totalCommits = parseInt(countResult.stdout.trim(), 10) || 0;

          if (totalCommits === 0) {
            ctx.ui.notify("No commits found in this repo.", "warning");
            return;
          }

          const { effectiveCount, wasClamped } = clampCommitCount(count, totalCommits);
          if (wasClamped) {
            ctx.ui.notify(
              `Repo has ${totalCommits} commit${totalCommits > 1 ? "s" : ""}. Reviewing all.`,
              "info",
            );
          }

          // Compute empty tree hash dynamically (works with SHA-1 and SHA-256 repos)
          const diffArgs: string[] = [];
          if (shouldDiffAllCommits(effectiveCount, totalCommits)) {
            const emptyTreeResult = await pi.exec(
              "git",
              ["hash-object", "-t", "tree", "/dev/null"],
              { timeout: 5000 },
            );
            const emptyTree = emptyTreeResult.stdout.trim();
            diffArgs.push("diff", emptyTree, "HEAD");
          } else {
            diffArgs.push("diff", `HEAD~${effectiveCount}`, "HEAD");
          }

          const diffResult = await pi.exec("git", diffArgs, {
            timeout: 15000,
          });

          if (diffResult.code !== 0) {
            ctx.ui.notify(
              `git diff failed (exit ${diffResult.code}): ${diffResult.stderr.slice(0, 200)}`,
              "error",
            );
            return;
          }

          const diff = diffResult.stdout.trim();
          if (!diff) {
            ctx.ui.notify("No changes found in the last " + effectiveCount + " commit(s).", "info");
            return;
          }

          // Get commit messages for context
          const logResult = await pi.exec("git", ["log", `--oneline`, `-${effectiveCount}`], {
            timeout: 5000,
          });
          const commitLog = logResult.stdout.trim();

          // Truncate diff if too large
          const truncatedDiff = truncateDiff(diff, 30000);

          const reviewPrompt = buildReviewPrompt();
          const prompt = `${reviewPrompt}\n\n---\n\nReview the following git diff (last ${effectiveCount} commit${effectiveCount > 1 ? "s" : ""}):\n\nCommits:\n${commitLog}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

          const authStorage = AuthStorage.create();
          const modelRegistry = ModelRegistry.create(authStorage);

          const { session: reviewSession } = await createAgentSession({
            cwd: ctx.cwd,
            sessionManager: SessionManager.inMemory(),
            authStorage,
            modelRegistry,
          });

          let reviewText = "";
          const unsub = reviewSession.subscribe((ev) => {
            if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
              reviewText += ev.assistantMessageEvent.delta;
            }
          });

          try {
            const signal = reviewAbort!.signal;
            await new Promise<void>((resolve, reject) => {
              let settled = false;
              const onAbort = () => {
                if (settled) return;
                settled = true;
                reviewSession.abort();
                reject(new Error("Review cancelled"));
              };
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener("abort", onAbort, { once: true });
              reviewSession.prompt(prompt).then(
                () => {
                  settled = true;
                  signal.removeEventListener("abort", onAbort);
                  resolve();
                },
                (err) => {
                  settled = true;
                  signal.removeEventListener("abort", onAbort);
                  reject(err);
                },
              );
            });
          } finally {
            unsub();
            reviewSession.dispose();
          }

          if (!reviewText.trim() || reviewText.includes("LGTM")) {
            pi.sendMessage(
              {
                customType: "code-review",
                content: `\u2705 **Code Review** (last ${effectiveCount} commit${effectiveCount > 1 ? "s" : ""})\n\nReview found no issues. Looks good!`,
                display: true,
              },
              { triggerTurn: false, deliverAs: "followUp" },
            );
          } else {
            pi.sendMessage(
              {
                customType: "code-review",
                content: `\ud83d\udd0d **Code Review** (last ${effectiveCount} commit${effectiveCount > 1 ? "s" : ""})\n\n${reviewText}\n\nPlease review these findings and fix any valid issues.\n\n\u26a0\ufe0f **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either \u2014 a new review cycle will check your fixes automatically.`,
                display: true,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          }
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
        return;
      }

      // No args: toggle auto-review
      reviewEnabled = !reviewEnabled;
      if (reviewEnabled) reviewLoopCount = 0;
      ctx.ui.notify(`Auto-review: ${reviewEnabled ? "on" : "off"}`, "info");
      updateStatus(ctx);
    },
  });

  // ── Session lifecycle ──────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    reviewLoopCount = 0;

    // Load config from repo
    const [rules, settingsResult] = await Promise.all([
      loadReviewRules(ctx.cwd),
      loadSettings(ctx.cwd),
    ]);

    customRules = rules;
    settings = settingsResult.settings;

    // Log config status
    if (customRules) {
      console.log(`[auto-review] Loaded custom rules from .autoreview/review-rules.md`);
    }
    if (settingsResult.errors.length > 0) {
      for (const err of settingsResult.errors) {
        console.log(err);
        if (ctx.hasUI) ctx.ui.notify(err, "warning");
      }
    } else if (settings.maxReviewLoops !== DEFAULT_SETTINGS.maxReviewLoops) {
      console.log(
        `[auto-review] maxReviewLoops = ${settings.maxReviewLoops} (from .autoreview/settings.json)`,
      );
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
