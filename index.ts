/**
 * code-review.ts — Pi extension
 *
 * After each agent turn that modifies files, spawns a fresh pi instance
 * to do a code review. Feeds the review feedback back to the main agent
 * as a steering message so it can decide whether to fix anything.
 *
 * UX:
 *   - Status bar shows ★ review on/off + pending file count
 *   - Shift+R toggles review on/off
 *   - Esc cancels an in-progress review
 *   - /review command also toggles
 *
 * Install:
 *   pi -e ./extensions/code-review.ts
 *   or copy to ~/.pi/agent/extensions/
 */

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer. You will be given a description of changes that were just made to a codebase. Your job is to:

1. Check for bugs, logic errors, off-by-one errors
2. Check for security issues
3. Check for clarity and readability problems
4. Check for missing error handling
5. Check for DRY violations

Be concise. If everything looks fine, say "LGTM — no issues found."
If there are issues, list them as bullet points with severity (high/medium/low).
Do NOT suggest stylistic preferences. Only flag real problems.`;

const FILE_MODIFYING_TOOLS = ["write", "edit"];
const BASH_FILE_PATTERN = /\b(cat\s*>|tee|sed\s+-i|mv\s|cp\s|rm\s|mkdir|echo\s.*>)\b/;

export default function (pi: ExtensionAPI) {
  let reviewEnabled = true;
  let reviewAbort: AbortController | null = null;
  let isReviewing = false;

  // Track tool calls + modified files across the agent run
  let agentToolCalls: Array<{ name: string; input: any; result?: string }> = [];
  let modifiedFiles = new Set<string>();
  const pendingArgs = new Map<string, { name: string; input: any }>();

  // ── Status bar ─────────────────────────────────────

  function updateStatus(ctx: { ui: any; hasUI?: boolean }) {
    if (!ctx.hasUI || !ctx.ui) return;
    const theme = ctx.ui.theme;
    const star = reviewEnabled ? theme.fg("accent", "★") : theme.fg("dim", "☆");
    const state = reviewEnabled ? theme.fg("success", "on") : theme.fg("dim", "off");

    if (isReviewing) {
      ctx.ui.setStatus(
        "code-review",
        `${star} ${theme.fg("accent", "review")} ${theme.fg("warning", "reviewing…")} ${theme.fg("dim", "(Ctrl+Shift+R to cancel)")}`
      );
      return;
    }

    if (reviewEnabled && modifiedFiles.size > 0) {
      const count = modifiedFiles.size;
      ctx.ui.setStatus(
        "code-review",
        `${star} ${theme.fg("accent", "review")} ${state} ${theme.fg("muted", `· will review`)} ${theme.fg("accent", String(count))} ${theme.fg("muted", count === 1 ? "file" : "files")} ${theme.fg("dim", "(Shift+R toggle)")}`
      );
      return;
    }

    ctx.ui.setStatus(
      "code-review",
      `${star} ${theme.fg("accent", "review")} ${state} ${theme.fg("dim", "(Shift+R toggle)")}`
    );
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

    // Track modified files for status display
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

  pi.on("agent_end", async (event, ctx) => {
    if (!reviewEnabled) {
      agentToolCalls = [];
      modifiedFiles.clear();
      updateStatus(ctx);
      return;
    }

    const hasFileChanges = agentToolCalls.some(
      (tc) =>
        FILE_MODIFYING_TOOLS.includes(tc.name) ||
        (tc.name === "bash" && BASH_FILE_PATTERN.test(tc.input?.command ?? ""))
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
                `  Edit ${i + 1}: replaced "${(e.oldText ?? "").slice(0, 200)}" with "${(e.newText ?? "").slice(0, 200)}"`
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

    console.log(`[code-review] File changes detected (${modifiedFiles.size} files), spawning reviewer...`);
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
        if (
          ev.type === "message_update" &&
          ev.assistantMessageEvent.type === "text_delta"
        ) {
          reviewText += ev.assistantMessageEvent.delta;
        }
      });

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

          if (signal.aborted) { onAbort(); return; }

          signal.addEventListener("abort", onAbort, { once: true });

          reviewSession.prompt(
            `${REVIEW_SYSTEM_PROMPT}\n\n---\n\nHere are the changes made:\n\n${changeSummary}`
          ).then(
            () => { settled = true; signal.removeEventListener("abort", onAbort); resolve(); },
            (err) => { settled = true; signal.removeEventListener("abort", onAbort); reject(err); },
          );
        });
      } finally {
        unsub();
        reviewSession.dispose();
      }

      if (!reviewText.trim() || reviewText.includes("LGTM")) {
        console.log("[code-review] Reviewer says: LGTM");
      } else {
        console.log("[code-review] Reviewer found issues, feeding back...");
        pi.sendMessage(
          {
            customType: "code-review",
            content: `🔍 **Automated Code Review**\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${reviewText}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
      }
    } catch (err: any) {
      if (err?.message === "Review cancelled") {
        console.log("[code-review] Review cancelled by user");
        if (ctx.hasUI) ctx.ui.notify("Code review cancelled", "info");
      } else {
        console.error("[code-review] Review failed:", err);
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
    handler: async (ctx) => {
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
      ctx.ui.notify(
        `Code review: ${reviewEnabled ? "enabled ★" : "disabled ☆"}`,
        "info"
      );
      updateStatus(ctx);
    },
  });

  // ── /review command ────────────────────────────────

  pi.registerCommand("review", {
    description: "Toggle automatic code review",
    handler: async (_args, ctx) => {
      reviewEnabled = !reviewEnabled;
      ctx.ui.notify(
        `Code review: ${reviewEnabled ? "enabled ★" : "disabled ☆"}`,
        "info"
      );
      updateStatus(ctx);
    },
  });

  // ── Session lifecycle ──────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (reviewAbort) reviewAbort.abort();
    agentToolCalls = [];
    modifiedFiles.clear();
    pendingArgs.clear();
  });
}
