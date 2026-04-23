/**
 * reviewer.ts — Review session with full context
 *
 * The reviewer gets:
 * - Full git diff
 * - List of changed files
 * - Full contents of each changed file
 * - Project file tree
 * - Read-only tools to explore the codebase further
 * - Live status updates shown in the main pi status bar
 */

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createReadOnlyTools,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

export interface ReviewResult {
  text: string;
  isLgtm: boolean;
}

export interface ReviewOptions {
  signal: AbortSignal;
  cwd: string;
  /** Called when the reviewer uses tools — for status bar updates */
  onActivity?: (description: string) => void;
}

/**
 * Spawn a fresh pi reviewer instance with tools, send a prompt,
 * collect the response. The reviewer can read files and explore
 * the codebase as needed.
 */
export async function runReviewSession(prompt: string, opts: ReviewOptions): Promise<ReviewResult> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    // Read-only tools: read, grep, find, ls — no write/edit/bash
    tools: createReadOnlyTools(opts.cwd),
  });

  let reviewText = "";
  const unsub = session.subscribe((ev: AgentSessionEvent) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      reviewText += ev.assistantMessageEvent.delta;
    }

    // Report tool activity for status bar
    if (opts.onActivity) {
      if (ev.type === "tool_execution_start") {
        const name = ev.toolName;
        const args = ev.args as any;
        if (name === "read") {
          opts.onActivity(`reading ${args?.path ?? "file"}`);
        } else if (name === "find" || name === "grep" || name === "ls") {
          opts.onActivity(`${name} ${(args?.path ?? args?.pattern ?? "").slice(0, 40)}`);
        } else {
          opts.onActivity(`${name}…`);
        }
      }
      if (ev.type === "tool_execution_end") {
        opts.onActivity("analyzing…");
      }
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        session.abort();
        reject(new Error("Review cancelled"));
      };

      if (opts.signal.aborted) {
        onAbort();
        return;
      }

      opts.signal.addEventListener("abort", onAbort, { once: true });

      session.prompt(prompt).then(
        () => {
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err) => {
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  } finally {
    unsub();
    session.dispose();
  }

  const isLgtm = !reviewText.trim() || reviewText.includes("LGTM");
  return { text: reviewText, isLgtm };
}

/**
 * Send the appropriate review result message (LGTM or issues found).
 */
export function sendReviewResult(
  pi: ExtensionAPI,
  result: ReviewResult,
  label: string,
  opts?: { showLoopCount?: string },
): void {
  if (result.isLgtm) {
    console.log("[auto-review] Reviewer says: LGTM");
    pi.sendMessage(
      {
        customType: "code-review",
        content: `✅ **Automated Code Review**${label ? ` (${label})` : ""}\n\nReview found no issues. Looks good!\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
        display: true,
      },
      { triggerTurn: false, deliverAs: "followUp" },
    );
  } else {
    console.log("[auto-review] Reviewer found issues, feeding back...");
    const loopInfo = opts?.showLoopCount ? ` (${opts.showLoopCount})` : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `🔍 **Automated Code Review**${loopInfo || (label ? ` (${label})` : "")}\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${result.text}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either — a new review cycle will check your fixes automatically.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}
